// Viewer role: the phone you look at. Shows the live preview, sends shutter,
// timer, zoom, rotation and camera-switch commands, and receives the photos.
import { $, show, toast, setStatus, showProblem, showSheet, hideSheet, keepAwake, vibrate } from '../ui.js';
import { createViewerPeer, watchConnection, offerFromText } from '../webrtc.js';
import { openCamera, cameraErrorMessage, unlockHostCandidates } from '../capture.js';
import { MSG, send, listen, PhotoReceiver } from '../protocol.js';
import { qrSvg, startScanner } from '../qr.js';
import { photoFile, save, share, offerSeparateShare } from '../share.js';
import { t, locale, setText, setLabel } from '../i18n.js';

const TIMERS = [0, 3, 5, 10];
const NO_ICE_HINT_MS = 20000;
const NO_VIDEO_HINT_MS = 8000;

const remote = $('remote-video');
const stage = $('stage');
const s = {
  offer: null,
  pc: null,
  dc: null,
  unwatch: null,
  scanStream: null,
  stopScan: null,
  timerIndex: 0,
  rotation: 0,
  facing: 'environment',
  counting: false,
  photo: null, // { file, url }
  hasFrames: false,
  zoomSendTimer: 0,
  generation: 0,
};

const receiver = new PhotoReceiver({
  onStart: (meta) => openReview({ developing: true, aspect: meta.width / meta.height }),
  onProgress: (p) => setDevelop(p),
  onPhoto: (blob, meta) => gotPhoto(blob, meta),
  onError: (err) => {
    console.warn(err);
    toast(t('viewer.photoIncomplete'), 4000);
    closeReview();
  },
});

// ------------------------------------------------------------ entry points

// Opened from the camera phone's QR (native Camera app): offer is in the URL.
export function startFromLink(offer) {
  s.offer = offer;
  setIntroText('viewer.foundTitle', 'viewer.foundText');
  $('btn-viewer-connect').hidden = false;
  $('btn-viewer-scan').hidden = true;
  show('viewer-intro');
}

// Chosen from the home screen (or re-pairing): scan the code in-page.
export function startFromHome(repairing = false) {
  s.offer = null;
  if (repairing) setIntroText('viewer.repairTitle', 'viewer.repairText');
  else setIntroText('viewer.scanTitle', 'viewer.scanText');
  $('btn-viewer-connect').hidden = true;
  $('btn-viewer-scan').hidden = false;
  show('viewer-intro');
}

// Keys are kept on the elements so a language switch re-translates them.
function setIntroText(titleKey, textKey) {
  setText($('viewer-intro-heading'), titleKey);
  setText($('viewer-intro-text'), textKey);
}

export function stop() {
  s.generation++;
  stopScanning();
  closePeer(true);
  closeReview();
  keepAwake(false);
}

function closePeer(sayBye) {
  s.unwatch?.();
  s.unwatch = null;
  if (sayBye && s.dc) send(s.dc, MSG.BYE);
  s.dc?.close();
  s.pc?.close();
  s.pc = s.dc = null;
  remote.srcObject = null;
  receiver.reset();
  hideCountdown();
}

// ------------------------------------------------------------ in-page scan

export async function scan() {
  show('viewer-scan');
  const video = $('viewer-scan-video');
  try {
    s.scanStream = await openCamera('environment');
  } catch (err) {
    showProblem(t('camera.startFailedTitle'), `${cameraErrorMessage(err)} ${t('viewer.scanFailedExtra')}`, scan);
    return;
  }
  video.srcObject = s.scanStream;
  video.play().catch(() => {}); // the scanner waits for frames by itself
  s.stopScan = startScanner(video, (text) => {
    const offer = offerFromText(text);
    if (!offer) {
      toast(t('viewer.notCameraCode'));
      return false;
    }
    stopScanning();
    connect(offer, { permissionGranted: true });
    return true;
  });
}

function stopScanning() {
  s.stopScan?.();
  s.stopScan = null;
  s.scanStream?.getTracks().forEach((t) => t.stop());
  s.scanStream = null;
  $('viewer-scan-video').srcObject = null;
}

export function backToIntro() {
  stopScanning();
  if (s.offer) startFromLink(s.offer);
  else startFromHome();
}

// ------------------------------------------------------------ pairing

// Runs from the Connect tap (or a successful scan).
export async function connect(offer = s.offer, { permissionGranted = false } = {}) {
  const gen = ++s.generation;
  closePeer(false);
  show('viewer-reply');
  $('answer-qr').replaceChildren(Object.assign(document.createElement('div'), { className: 'spinner' }));
  setText($('answer-caption'), 'viewer.makingReply');
  keepAwake(true);

  // Camera permission makes browsers reveal real IPs instead of mDNS names.
  // Not fatal if refused: the camera phone's addresses are usually enough.
  if (!permissionGranted && !(await unlockHostCandidates())) {
    toast(t('viewer.noPermission'), 4000);
  }

  let peer;
  try {
    peer = await createViewerPeer(offer);
  } catch (err) {
    console.error(err);
    if (gen !== s.generation) return;
    showProblem(t('viewer.badCodeTitle'), t('viewer.badCodeText'), () => startFromHome());
    return;
  }
  if (gen !== s.generation) { peer.pc.close(); return; }
  Object.assign(s, { pc: peer.pc, dc: peer.dc, hasFrames: false });
  listen(s.dc, onMessage, (buf) => receiver.handleBinary(buf));

  remote.srcObject = new MediaStream([peer.track]);
  remote.play().catch(() => {});

  $('answer-qr').replaceChildren(qrSvg('', peer.payload, t('viewer.replyLabel')));
  setText($('answer-caption'), 'viewer.replyCaption');

  // ICE connects to the camera phone before it scans our reply (it answers
  // connectivity checks with its own credentials). If that hasn't happened
  // after a while, the network is probably blocking phone-to-phone traffic.
  setTimeout(() => {
    if (gen !== s.generation || s.dc?.readyState === 'open') return;
    const ice = s.pc?.iceConnectionState;
    if (ice !== 'connected' && ice !== 'completed') {
      showSheet({ title: t('sheet.cantReachTitle'), text: t('sheet.cantReachText'), hint: true, waiting: true });
    }
  }, NO_ICE_HINT_MS);

  s.unwatch = watchConnection(s.pc, s.dc, {
    onOpen: () => gen === s.generation && onConnected(gen),
    onTrouble: (kind) => {
      if (gen !== s.generation || kind !== 'unstable') return;
      setStatus('viewer-status', 'warn', 'status.reconnecting');
      showSheet({ title: t('sheet.droppedTitle'), text: t('sheet.droppedToCamera'), waiting: true });
    },
    onRecovered: () => { hideSheet(); setStatus('viewer-status', 'live', 'status.live'); },
    onLost: (kind) => gen === s.generation && onLost(kind),
  });
}

function onConnected(gen) {
  hideSheet();
  show('viewer-live');
  setStatus('viewer-status', 'connecting', 'status.waitingVideo');
  $('btn-shutter').disabled = false;
  layoutStage();
  remote.play().catch(() => { $('btn-play').hidden = false; });
  send(s.dc, MSG.SET_ROTATION, { quarterTurns: s.rotation });
  watchFrames(gen);
  setTimeout(() => {
    if (gen === s.generation && !s.hasFrames && s.dc?.readyState === 'open') {
      setStatus('viewer-status', 'warn', 'status.noVideo');
      showSheet({ title: t('sheet.noVideoTitle'), text: t('sheet.noVideoText'), hint: true, waiting: true });
    }
  }, NO_VIDEO_HINT_MS);
}

function onLost(kind) {
  $('btn-shutter').disabled = true;
  hideCountdown();
  setStatus('viewer-status', 'lost', 'status.disconnected');
  if (kind === 'bye') {
    showSheet({ title: t('sheet.cameraLeftTitle'), text: t('sheet.cameraLeftText') });
  } else {
    showSheet({ title: t('sheet.lostTitle'), text: t('sheet.lostText'), hint: kind === 'failed' });
  }
}

export function repair() {
  stop();
  hideSheet();
  startFromHome(true);
}

// First decoded frame: we're truly live.
function markLive() {
  if (s.hasFrames) return;
  s.hasFrames = true;
  hideSheet();
  setStatus('viewer-status', 'live', 'status.live');
  layoutStage();
}
remote.addEventListener('loadeddata', markLive);
remote.addEventListener('resize', () => { markLive(); layoutStage(); });

// Video element events aren't reliable for MediaStreams in every engine, so
// also watch the decoder directly.
async function watchFrames(gen) {
  while (gen === s.generation && !s.hasFrames && s.pc) {
    try {
      const stats = await s.pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video' && r.framesDecoded > 0) markLive();
      });
    } catch { /* closed */ }
    await new Promise((r) => setTimeout(r, 400));
  }
}

export function playVideo() {
  $('btn-play').hidden = true;
  remote.play().catch(() => {});
}

// ------------------------------------------------------------ messages

function onMessage(msg) {
  if (receiver.handleMessage(msg)) return;
  switch (msg.type) {
    case MSG.STATUS: applyStatus(msg); break;
    case MSG.TIMER_TICK: showCountdown(msg.remaining); break;
    case MSG.TIMER_CANCEL: hideCountdown(); break;
    case MSG.SHUTTER:
      hideCountdown();
      vibrate(30);
      stage.classList.remove('snap');
      void stage.offsetWidth;
      stage.classList.add('snap');
      break;
    case MSG.ERROR: toast(t(`remote.${msg.code}`), 4000); break;
    case MSG.BYE:
      s.unwatch?.();
      onLost('bye');
      break;
    default: break;
  }
}

function applyStatus(msg) {
  s.facing = msg.facing === 'user' ? 'user' : 'environment';
  setText($('switch-label'), s.facing === 'user' ? 'viewer.front' : 'viewer.rear');
  $('switch-label').dataset.ready = '1';
  $('btn-switch').disabled = false;
  $('btn-switch').classList.toggle('unavailable', msg.canSwitch === false);
  stage.classList.toggle('mirror', s.facing === 'user');

  const zoom = msg.zoom;
  const box = $('zoom');
  box.hidden = !zoom;
  if (zoom) {
    const range = $('zoom-range');
    Object.assign(range, { min: zoom.min, max: zoom.max, step: zoom.step });
    if (document.activeElement !== range) range.value = zoom.value;
    $('zoom-value').textContent = `${Number(range.value).toFixed(1)}×`;
  }
}

// ------------------------------------------------------------ controls

export function shutter() {
  if (!s.dc || s.dc.readyState !== 'open') return;
  vibrate(10);
  if (s.counting) {
    send(s.dc, MSG.TIMER_CANCEL);
    hideCountdown();
    return;
  }
  const seconds = TIMERS[s.timerIndex];
  if (seconds) {
    send(s.dc, MSG.TIMER_START, { seconds });
    showCountdown(seconds);
  } else {
    send(s.dc, MSG.CAPTURE);
  }
}

export function cycleTimer() {
  s.timerIndex = (s.timerIndex + 1) % TIMERS.length;
  const n = TIMERS[s.timerIndex];
  if (n) {
    setText($('timer-label'), 'viewer.timerSeconds', { n });
    setLabel($('btn-timer'), 'viewer.timerLabel', { n });
  } else {
    setText($('timer-label'), 'viewer.timerOff');
    setLabel($('btn-timer'), 'viewer.timerLabelOff');
  }
  $('btn-timer').classList.toggle('on', n > 0);
}

export function rotate() {
  s.rotation = (s.rotation + 1) % 4;
  $('rotate-label').textContent = `${s.rotation * 90}°`;
  $('btn-rotate').classList.toggle('on', s.rotation > 0);
  layoutStage();
  send(s.dc, MSG.SET_ROTATION, { quarterTurns: s.rotation });
}

export function switchCamera() {
  $('btn-switch').disabled = true; // re-enabled by the next status message
  send(s.dc, MSG.SWITCH_CAMERA);
}

export function onZoomInput() {
  const value = Number($('zoom-range').value);
  $('zoom-value').textContent = `${value.toFixed(1)}×`;
  // Throttle: applyConstraints is slow on some phones.
  if (s.zoomSendTimer) return;
  s.zoomSendTimer = setTimeout(() => {
    s.zoomSendTimer = 0;
    send(s.dc, MSG.SET_ZOOM, { value: Number($('zoom-range').value) });
  }, 120);
}

function showCountdown(n) {
  s.counting = true;
  const el = $('countdown');
  el.hidden = false;
  el.textContent = String(n);
  el.classList.remove('pulse');
  void el.offsetWidth;
  el.classList.add('pulse');
  $('btn-shutter').classList.add('cancel');
  setLabel($('btn-shutter'), 'viewer.cancelTimer');
}

function hideCountdown() {
  s.counting = false;
  $('countdown').hidden = true;
  $('btn-shutter').classList.remove('cancel');
  setLabel($('btn-shutter'), 'viewer.takePhoto');
}

// Fit the (possibly rotated) video inside the stage, contain-style, so the
// whole frame is visible for framing. CSS does the rotation; we supply the
// box size because a quarter turn swaps width and height.
function layoutStage() {
  const r = stage.getBoundingClientRect();
  const odd = s.rotation % 2 === 1;
  stage.style.setProperty('--box-w', `${odd ? r.height : r.width}px`);
  stage.style.setProperty('--box-h', `${odd ? r.width : r.height}px`);
  stage.style.setProperty('--rot', `${s.rotation * 90}deg`);
}
new ResizeObserver(layoutStage).observe(stage);

// ------------------------------------------------------------ photo review

function openReview({ developing, aspect }) {
  const review = $('review');
  review.hidden = false;
  if (aspect > 0) document.querySelector('.polaroid-image').style.setProperty('--ar', aspect.toFixed(4));
  $('polaroid').classList.toggle('developing', developing);
  $('polaroid').classList.remove('developed');
  if (developing) {
    $('review-img').removeAttribute('src');
    setText($('review-caption'), 'viewer.developing');
    $('review-size').textContent = '';
    $('btn-save').disabled = true;
    $('btn-share').hidden = true;
    setDevelop(0);
  }
}

function setDevelop(p) {
  $('develop-progress').style.transform = `scaleX(${p})`;
}

function gotPhoto(blob, meta) {
  if (s.photo) URL.revokeObjectURL(s.photo.url);
  const file = photoFile(blob);
  const size = meta.width && meta.height ? `${meta.width} × ${meta.height}` : '';
  s.photo = { file, url: URL.createObjectURL(blob), size, aspect: meta.width / meta.height };
  $('polaroid').dataset.method = meta.method || '';
  const img = $('review-img');
  img.onload = () => {
    $('polaroid').classList.remove('developing');
    $('polaroid').classList.add('developed');
  };
  img.src = s.photo.url;
  setDevelop(1);
  delete $('review-caption').dataset.i18n; // a time, not a phrase
  $('review-caption').textContent = new Date().toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  $('review-size').textContent = size;
  $('btn-save').disabled = false;
  $('btn-share').hidden = !offerSeparateShare(file);
  $('btn-last-photo').disabled = false;
  $('last-thumb').replaceChildren(Object.assign(new Image(), { src: s.photo.url, alt: '' }));
}

export function showLastPhoto() {
  if (!s.photo) return;
  openReview({ developing: false, aspect: s.photo.aspect });
  $('review-img').src = s.photo.url;
  $('review-size').textContent = s.photo.size;
  $('polaroid').classList.add('developed');
  $('btn-save').disabled = false;
  $('btn-share').hidden = !offerSeparateShare(s.photo.file);
}

export function closeReview() {
  $('review').hidden = true;
}

// Run straight from taps: no awaits before share() (Safari).
export function savePhoto() {
  if (!s.photo) return;
  save(s.photo.file).then((result) => {
    if (result === 'downloaded') toast(t('common.savedToDownloads'));
  });
}

export function sharePhoto() {
  if (s.photo) share(s.photo.file);
}
