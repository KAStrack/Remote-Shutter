// Camera role: the phone at the awkward angle. Owns the real camera, takes
// the stills, runs the self-timer, and streams a light preview to the viewer.
import { $, show, currentScreen, toast, setStatus, showProblem, showSheet, hideSheet, flash, keepAwake } from '../ui.js';
import { createCameraPeer, acceptAnswer, applyPreviewEncoding, watchConnection, offerFromText, appUrl } from '../webrtc.js';
import { openCamera, cameraErrorMessage, capturePhoto, zoomInfo, setZoom } from '../capture.js';
import { MSG, send, listen, sendPhoto } from '../protocol.js';
import { qrSvg, startScanner } from '../qr.js';
import { photoFile, save } from '../share.js';

const CONNECT_TIMEOUT_MS = 15000;

const video = $('cam-video');
const s = {
  stream: null,
  track: null,
  facing: 'environment',
  pc: null,
  dc: null,
  sender: null,
  unwatch: null,
  stopScan: null,
  rotation: 0,
  busy: false,
  timer: null,
  lastPhoto: null,
  lastUrl: null,
  generation: 0, // bumps on every new pairing so stale callbacks bail out
};

// ------------------------------------------------------------ lifecycle

export async function start() {
  show('camera-offer');
  resetOfferCard('Starting the camera…');
  try {
    await useStream(await openCamera(s.facing));
  } catch (err) {
    showProblem('The camera didn’t start', cameraErrorMessage(err), start);
    return;
  }
  keepAwake(true);
  await pair();
}

export function stop() {
  s.generation++;
  stopScanning();
  stopTimer(false);
  closePeer(true);
  s.stream?.getTracks().forEach((t) => t.stop());
  s.stream = s.track = null;
  video.srcObject = null;
  keepAwake(false);
}

async function useStream(stream) {
  s.stream = stream;
  s.track = stream.getVideoTracks()[0];
  s.track.addEventListener('ended', onTrackEnded);
  video.srcObject = stream;
  video.classList.toggle('mirror', s.facing === 'user');
  await startVideo(video);
}

// play() can stay pending forever in some engines, so never await it alone:
// wait for the first metadata (so videoWidth is known), with a time limit.
function startVideo(el) {
  el.play().catch(() => {});
  if (el.readyState >= 1) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); el.removeEventListener('loadedmetadata', done); resolve(); };
    const t = setTimeout(done, 3000);
    el.addEventListener('loadedmetadata', done);
  });
}

function closePeer(sayBye) {
  s.unwatch?.();
  s.unwatch = null;
  if (sayBye && s.dc) send(s.dc, MSG.BYE);
  s.dc?.close();
  s.pc?.close();
  s.pc = s.dc = s.sender = null;
  s.busy = false;
}

// ------------------------------------------------------------ pairing

function resetOfferCard(caption) {
  $('offer-qr').replaceChildren(Object.assign(document.createElement('div'), { className: 'spinner' }));
  $('offer-caption').textContent = caption;
  $('btn-scan-reply').disabled = true;
}

export async function pair() {
  const gen = ++s.generation;
  closePeer(false);
  hideSheet();
  show('camera-offer');
  resetOfferCard('Making a pairing code…');
  let peer;
  try {
    peer = await createCameraPeer(s.track);
  } catch (err) {
    console.error(err);
    showProblem('Couldn’t make a pairing code', `This browser couldn’t set up a connection (${err.message}).`, pair);
    return;
  }
  if (gen !== s.generation) { peer.pc.close(); return; }
  Object.assign(s, { pc: peer.pc, dc: peer.dc, sender: peer.sender });
  listen(s.dc, onMessage);

  $('offer-qr').replaceChildren(qrSvg(`${appUrl()}#o=`, peer.payload, 'Pairing code for the other phone'));
  $('offer-caption').textContent = 'Scan me with the other phone';
  $('btn-scan-reply').disabled = false;

  s.unwatch = watchConnection(s.pc, s.dc, {
    onOpen: () => gen === s.generation && onConnected(),
    onTrouble: (kind) => gen === s.generation && onTrouble(kind),
    onRecovered: () => { hideSheet(); setStatus('camera-status', 'live', 'Connected'); },
    onLost: (kind) => gen === s.generation && onLost(kind),
  });
}

export function scanReply() {
  if (!s.pc) return;
  show('camera-scan');
  $('camera-scan-hint').textContent = 'Point this phone at the code on the other phone.';
  stopScanning();
  s.stopScan = startScanner(video, (text) => {
    if (offerFromText(text)) {
      $('camera-scan-hint').textContent = 'That’s a camera code. Scan the code on the other phone.';
      return false;
    }
    handleAnswer(text.trim());
    return true;
  });
}

export function showOffer() {
  stopScanning();
  show('camera-offer');
}

function stopScanning() {
  s.stopScan?.();
  s.stopScan = null;
}

async function handleAnswer(text) {
  const gen = s.generation;
  $('camera-scan-hint').textContent = 'Got it. Connecting…';
  try {
    await acceptAnswer(s.pc, text);
  } catch (err) {
    if (gen !== s.generation) return;
    console.warn('Bad answer code', err);
    $('camera-scan-hint').textContent = 'That code didn’t work. Point at the code on the other phone.';
    setTimeout(() => currentScreen() === 'camera-scan' && scanReply(), 1500);
    return;
  }
  // Now waiting for the data channel; warn if it takes too long.
  setTimeout(() => {
    if (gen === s.generation && s.dc?.readyState !== 'open') onTrouble('slow');
  }, CONNECT_TIMEOUT_MS);
}

function onConnected() {
  stopScanning();
  hideSheet();
  show('camera-live');
  setStatus('camera-status', 'live', 'Connected');
  if (s.sender) applyPreviewEncoding(s.sender, s.track);
  sendStatus();
}

function onTrouble(kind) {
  if (kind === 'unstable') {
    setStatus('camera-status', 'warn', 'Reconnecting…');
    showSheet({ title: 'Connection dropped', text: 'Trying to reconnect to the viewer phone.', waiting: true });
  } else if (kind === 'slow' && currentScreen() === 'camera-scan') {
    showSheet({ title: 'Still connecting', text: 'The phones can’t reach each other yet.', hint: true, waiting: true });
  }
}

function onLost(kind) {
  stopTimer(false);
  setStatus('camera-status', 'lost', 'Disconnected');
  if (kind === 'bye') {
    showSheet({ title: 'Viewer disconnected', text: 'The viewer phone ended the session. Pair again to keep shooting.' });
  } else {
    showSheet({ title: 'Connection lost', text: 'The phones stopped talking to each other. Pairing again needs both codes, like the first time.', hint: kind === 'failed' });
  }
}

// ------------------------------------------------------------ messages

function onMessage(msg) {
  switch (msg.type) {
    case MSG.CAPTURE: if (!s.timer) shoot(); break;
    case MSG.TIMER_START: startTimer(Number(msg.seconds)); break;
    case MSG.TIMER_CANCEL: stopTimer(true); break;
    case MSG.SWITCH_CAMERA: switchCamera(); break;
    case MSG.SET_ZOOM: applyZoom(msg.value); break;
    case MSG.SET_ROTATION:
      s.rotation = ((Number(msg.quarterTurns) % 4) + 4) % 4;
      sendStatus();
      break;
    case MSG.BYE:
      s.unwatch?.();
      onLost('bye');
      break;
    default: break;
  }
}

async function sendStatus() {
  if (!s.dc) return;
  let canSwitch = true;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    canSwitch = devices.filter((d) => d.kind === 'videoinput').length > 1;
  } catch { /* assume yes */ }
  const settings = s.track?.getSettings?.() || {};
  send(s.dc, MSG.STATUS, {
    facing: s.facing,
    zoom: zoomInfo(s.track),
    canSwitch,
    rotation: s.rotation,
    width: settings.width,
    height: settings.height,
    stills: typeof ImageCapture === 'function' ? 'full-sensor' : 'video-frame',
  });
}

// ------------------------------------------------------------ capture

async function shoot() {
  if (s.busy) {
    send(s.dc, MSG.ERROR, { message: 'Still sending the last photo. Try again in a moment.' });
    return;
  }
  s.busy = true;
  const dc = s.dc;
  const pc = s.pc;
  send(dc, MSG.SHUTTER);
  flash();
  try {
    const shot = await capturePhoto({ track: s.track, video, rotation: s.rotation });
    keepLastPhoto(shot.blob);
    if (dc?.readyState === 'open') {
      await sendPhoto(dc, pc, shot.blob, { width: shot.width, height: shot.height, method: shot.method, name: s.lastPhoto.name });
    }
  } catch (err) {
    console.error(err);
    send(dc, MSG.ERROR, { message: `The camera couldn’t take the photo (${err.message}).` });
    toast('Couldn’t take the photo');
  } finally {
    s.busy = false;
  }
}

function keepLastPhoto(blob) {
  s.lastPhoto = photoFile(blob);
  if (s.lastUrl) URL.revokeObjectURL(s.lastUrl);
  s.lastUrl = URL.createObjectURL(blob);
  const thumb = $('camera-thumb');
  thumb.replaceChildren(Object.assign(new Image(), { src: s.lastUrl, alt: '' }));
  $('btn-camera-save').disabled = false;
  $('camera-save-label').textContent = 'Save last photo';
}

// Runs from the Save button tap; no awaits before share() (Safari).
export function saveLast() {
  if (!s.lastPhoto) return;
  const file = s.lastPhoto;
  save(file).then((result) => {
    if (result === 'downloaded') toast('Saved to Downloads');
  });
}

// ------------------------------------------------------------ self-timer

// The countdown runs here so the shutter fires on time regardless of network
// jitter; the viewer just displays the ticks it receives.
function startTimer(seconds) {
  if (!(seconds > 0) || s.busy) return;
  stopTimer(false);
  const endAt = performance.now() + seconds * 1000;
  let shown = 0;
  const count = $('camera-count');
  const tick = () => {
    const left = Math.ceil((endAt - performance.now()) / 1000);
    if (left <= 0) {
      s.timer = null;
      count.hidden = true;
      shoot();
      return;
    }
    if (left !== shown) {
      shown = left;
      count.textContent = String(left);
      count.classList.remove('pulse');
      void count.offsetWidth;
      count.classList.add('pulse');
      send(s.dc, MSG.TIMER_TICK, { remaining: left });
    }
    s.timer = setTimeout(tick, Math.min(100, endAt - performance.now()));
  };
  count.hidden = false;
  s.timer = -1; // mark as running before the first tick
  tick();
}

function stopTimer(notify) {
  if (!s.timer) return;
  clearTimeout(s.timer);
  s.timer = null;
  $('camera-count').hidden = true;
  if (notify) send(s.dc, MSG.TIMER_CANCEL);
}

// ------------------------------------------------------------ camera controls

async function switchCamera() {
  if (s.busy || s.timer) return;
  const previous = s.facing;
  const next = previous === 'environment' ? 'user' : 'environment';
  // iOS allows one capture at a time: stop the old track first.
  s.track?.removeEventListener('ended', onTrackEnded);
  s.stream?.getTracks().forEach((t) => t.stop());
  try {
    s.facing = next;
    await useStream(await openCamera(next));
  } catch (err) {
    console.warn('Switch failed', err);
    s.facing = previous;
    try {
      await useStream(await openCamera(previous));
    } catch (err2) {
      send(s.dc, MSG.ERROR, { message: cameraErrorMessage(err2) });
      return;
    }
    send(s.dc, MSG.ERROR, { message: 'This phone couldn’t switch cameras.' });
  }
  if (s.sender) {
    await s.sender.replaceTrack(s.track);
    await applyPreviewEncoding(s.sender, s.track);
  }
  sendStatus();
}

async function applyZoom(value) {
  try {
    await setZoom(s.track, value);
  } catch (err) {
    console.warn('Zoom failed', err);
  }
  sendStatus();
}

// The camera can end under us: another app grabbed it, or iOS suspended the
// page. Re-open when we're visible again and swap it into the connection.
function onTrackEnded() {
  if (document.visibilityState === 'visible') reopenCamera();
}

async function reopenCamera() {
  if (!s.stream || s.track?.readyState === 'live') return;
  try {
    await useStream(await openCamera(s.facing));
    if (s.sender) {
      await s.sender.replaceTrack(s.track);
      await applyPreviewEncoding(s.sender, s.track);
    }
    sendStatus();
  } catch (err) {
    toast(cameraErrorMessage(err), 5000);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && s.stream && s.track?.readyState === 'ended') reopenCamera();
});
