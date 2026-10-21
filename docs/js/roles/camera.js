// Camera role: the phone at the awkward angle. Owns the real camera, takes
// the stills, runs the self-timer, and streams a light preview to the viewer.
import { $, show, currentScreen, toast, setStatus, showProblem, showSheet, hideSheet, flash, keepAwake } from '../ui.js';
import { createCameraPeer, acceptAnswer, applyPreviewEncoding, watchConnection, offerFromText, appUrl } from '../webrtc.js';
import { openCamera, listCameras, rememberFacing, cameraErrorMessage, capturePhoto, zoomInfo, setZoom } from '../capture.js';
import { MSG, send, listen, sendPhoto } from '../protocol.js';
import { qrSvg, startScanner } from '../qr.js';
import { photoFile, save } from '../share.js';
import { t, setText } from '../i18n.js';

const CONNECT_TIMEOUT_MS = 15000;

const video = $('cam-video');
const s = {
  stream: null,
  track: null,
  facing: 'environment', // '' when the phone doesn't say which way it faces
  deviceId: null,
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
  resetOfferCard('camera.startingCamera');
  try {
    await useStream(await openCamera(s.facing || 'environment'));
  } catch (err) {
    showProblem(t('camera.startFailedTitle'), cameraErrorMessage(err), start);
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
  const settings = s.track.getSettings?.() || {};
  s.deviceId = settings.deviceId || null;
  rememberFacing(s.deviceId, settings.facingMode);
  s.facing = settings.facingMode || (await cameraList()).find((c) => c.deviceId === s.deviceId)?.facing || '';
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

function resetOfferCard(captionKey) {
  $('offer-qr').replaceChildren(Object.assign(document.createElement('div'), { className: 'spinner' }));
  setText($('offer-caption'), captionKey);
  $('btn-scan-reply').disabled = true;
}

export async function pair() {
  const gen = ++s.generation;
  closePeer(false);
  hideSheet();
  show('camera-offer');
  resetOfferCard('camera.makingCode');
  let peer;
  try {
    peer = await createCameraPeer(s.track);
  } catch (err) {
    console.error(err);
    showProblem(t('camera.codeFailedTitle'), t('camera.codeFailedText'), pair);
    return;
  }
  if (gen !== s.generation) { peer.pc.close(); return; }
  Object.assign(s, { pc: peer.pc, dc: peer.dc, sender: peer.sender });
  listen(s.dc, onMessage);

  $('offer-qr').replaceChildren(qrSvg(`${appUrl()}#o=`, peer.payload, t('camera.offerLabel')));
  setText($('offer-caption'), 'camera.offerCaption');
  $('btn-scan-reply').disabled = false;

  s.unwatch = watchConnection(s.pc, s.dc, {
    onOpen: () => gen === s.generation && onConnected(),
    onTrouble: (kind) => gen === s.generation && onTrouble(kind),
    onRecovered: () => { hideSheet(); setStatus('camera-status', 'live', 'status.connected'); },
    onLost: (kind) => gen === s.generation && onLost(kind),
  });
}

export function scanReply() {
  if (!s.pc) return;
  show('camera-scan');
  setText($('camera-scan-hint'), 'camera.scanHint');
  stopScanning();
  s.stopScan = startScanner(video, (text) => {
    if (offerFromText(text)) {
      setText($('camera-scan-hint'), 'camera.scanWrongCode');
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
  setText($('camera-scan-hint'), 'camera.scanGotIt');
  try {
    await acceptAnswer(s.pc, text);
  } catch (err) {
    if (gen !== s.generation) return;
    console.warn('Bad answer code', err);
    setText($('camera-scan-hint'), 'camera.scanBadCode');
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
  setStatus('camera-status', 'live', 'status.connected');
  if (s.sender) applyPreviewEncoding(s.sender, s.track);
  sendStatus();
}

function onTrouble(kind) {
  if (kind === 'unstable') {
    setStatus('camera-status', 'warn', 'status.reconnecting');
    showSheet({ title: t('sheet.droppedTitle'), text: t('sheet.droppedToViewer'), waiting: true });
  } else if (kind === 'slow' && currentScreen() === 'camera-scan') {
    showSheet({ title: t('sheet.slowTitle'), text: t('sheet.slowText'), hint: true, waiting: true });
  }
}

function onLost(kind) {
  stopTimer(false);
  setStatus('camera-status', 'lost', 'status.disconnected');
  if (kind === 'bye') {
    showSheet({ title: t('sheet.viewerLeftTitle'), text: t('sheet.viewerLeftText') });
  } else {
    showSheet({ title: t('sheet.lostTitle'), text: t('sheet.lostText'), hint: kind === 'failed' });
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

async function cameraList() {
  try {
    return await listCameras();
  } catch {
    return [];
  }
}

async function sendStatus() {
  if (!s.dc) return;
  const cameras = await cameraList();
  // "Front 2": numbered only when several cameras face the same way.
  const sameWay = cameras.filter((c) => c.facing === s.facing);
  const number = sameWay.length > 1 ? sameWay.findIndex((c) => c.deviceId === s.deviceId) + 1 : 0;
  const settings = s.track?.getSettings?.() || {};
  send(s.dc, MSG.STATUS, {
    facing: s.facing,
    cameraNumber: number,
    zoom: zoomInfo(s.track),
    canSwitch: cameras.length !== 1, // can't list them: let the viewer try
    rotation: s.rotation,
    width: settings.width,
    height: settings.height,
    stills: typeof ImageCapture === 'function' ? 'full-sensor' : 'video-frame',
  });
}

// ------------------------------------------------------------ capture

async function shoot() {
  if (s.busy) {
    send(s.dc, MSG.ERROR, { code: 'busy' });
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
    send(dc, MSG.ERROR, { code: 'captureFailed' });
    toast(t('camera.captureFailed'));
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
  setText($('camera-save-label'), 'camera.saveLast');
}

// Runs from the Save button tap; no awaits before share() (Safari).
export function saveLast() {
  if (!s.lastPhoto) return;
  const file = s.lastPhoto;
  save(file).then((result) => {
    if (result === 'downloaded') toast(t('common.savedToDownloads'));
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

// Steps through every camera in turn: front 1 -> front 2 -> rear -> front 1.
async function switchCamera() {
  if (s.busy || s.timer) return;
  const cameras = await cameraList();
  const previous = { facing: s.facing, deviceId: s.deviceId };
  let next;
  if (cameras.length) {
    const at = cameras.findIndex((c) => c.deviceId === previous.deviceId);
    next = cameras[(at + 1) % cameras.length];
  } else {
    // Can't list them: fall back to flipping direction.
    next = { facing: previous.facing === 'user' ? 'environment' : 'user', deviceId: null };
  }
  // iOS allows one capture at a time: stop the old track first.
  s.track?.removeEventListener('ended', onTrackEnded);
  s.stream?.getTracks().forEach((t) => t.stop());
  try {
    await useStream(await openCamera(next.facing || 'environment', next.deviceId));
  } catch (err) {
    console.warn('Switch failed', err);
    try {
      await useStream(await openCamera(previous.facing || 'environment', previous.deviceId));
    } catch (err2) {
      send(s.dc, MSG.ERROR, { code: 'cameraFailed' });
      toast(cameraErrorMessage(err2), 5000);
      return;
    }
    send(s.dc, MSG.ERROR, { code: 'switchFailed' });
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
    await useStream(await openCamera(s.facing || 'environment', s.deviceId));
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
