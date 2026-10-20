// Entry point: picks a role, routes taps to it, and handles pairing links.
import { $, show, showProblem, retryProblem, hideSheet } from './ui.js';
import { offerFromText, appUrl } from './webrtc.js';
import { qrSvg } from './qr.js';
import { t, lang, setLanguage, initLanguage } from './i18n.js';
import * as camera from './roles/camera.js';
import * as viewer from './roles/viewer.js';

let role = null; // 'camera' | 'viewer' | null

function unsupportedReason() {
  if (!window.isSecureContext) return t('unsupported.https');
  if (typeof RTCPeerConnection !== 'function') return t('unsupported.webrtc');
  if (!navigator.mediaDevices?.getUserMedia) return t('unsupported.camera');
  return null;
}

function goHome() {
  if (role === 'camera') camera.stop();
  if (role === 'viewer') viewer.stop();
  role = null;
  hideSheet();
  show('home');
}

function begin(nextRole, fn) {
  const reason = unsupportedReason();
  if (reason) {
    showProblem(t('unsupported.title'), reason);
    return;
  }
  if (role && role !== nextRole) goHome();
  role = nextRole;
  fn();
}

// Opened via the camera phone's QR code: the offer is in the fragment (never
// sent to any server). Strip it so a reload doesn't reuse a stale offer.
function takeOfferFromUrl() {
  const offer = offerFromText(location.hash);
  if (offer) history.replaceState(null, '', location.pathname + location.search);
  return offer;
}

function handleLink() {
  const offer = takeOfferFromUrl();
  if (!offer) return false;
  begin('viewer', () => { viewer.stop(); viewer.startFromLink(offer); });
  return true;
}

// A code for this page's own address, so the second phone (or a laptop's
// visitor) can open the app without typing.
function toggleAppQr() {
  const box = $('app-qr');
  const btn = $('btn-app-qr');
  box.hidden = !box.hidden;
  btn.setAttribute('aria-expanded', String(!box.hidden));
  btn.dataset.i18n = box.hidden ? 'home.showQr' : 'home.hideQr';
  btn.textContent = t(btn.dataset.i18n);
  if (!box.hidden && !$('app-qr-image').firstChild) {
    $('app-qr-image').append(qrSvg(appUrl(), '', t('home.qrLabel')));
  }
  if (!box.hidden) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function switchLanguage() {
  setLanguage(lang() === 'zh-Hans' ? 'en' : 'zh-Hans', { remember: true });
  // The home QR's accessible name was built in the old language.
  $('app-qr-image').replaceChildren();
  if (!$('app-qr').hidden) $('app-qr-image').append(qrSvg(appUrl(), '', t('home.qrLabel')));
}

const actions = {
  home: goHome,
  'switch-language': switchLanguage,
  'toggle-app-qr': toggleAppQr,
  'role-camera': () => begin('camera', camera.start),
  'role-viewer': () => begin('viewer', () => viewer.startFromHome()),

  // camera
  'camera-scan': () => camera.scanReply(),
  'camera-offer': () => camera.showOffer(),
  'camera-save': () => camera.saveLast(),

  // viewer
  'viewer-connect': () => viewer.connect(),
  'viewer-scan': () => viewer.scan(),
  'viewer-intro': () => viewer.backToIntro(),
  'play-video': () => viewer.playVideo(),
  shutter: () => viewer.shutter(),
  'cycle-timer': () => viewer.cycleTimer(),
  rotate: () => viewer.rotate(),
  'switch-camera': () => viewer.switchCamera(),
  'show-photo': () => viewer.showLastPhoto(),
  'close-photo': () => viewer.closeReview(),
  'save-photo': () => viewer.savePhoto(),
  'share-photo': () => viewer.sharePhoto(),

  // both
  disconnect: goHome,
  repair: () => (role === 'camera' ? camera.pair() : viewer.repair()),
  'sheet-dismiss': hideSheet,
  'problem-retry': retryProblem,
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) fn();
});

$('zoom-range').addEventListener('input', () => viewer.onZoomInput());

// Escape closes the photo review or the trouble sheet.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('review').hidden) viewer.closeReview();
  else if (!$('btn-sheet-dismiss').hidden) hideSheet();
});

// A new pairing link while the app is already open (e.g. the browser reused
// this tab when the QR was scanned again).
window.addEventListener('hashchange', handleLink);

initLanguage();
if (!handleLink()) show('home');

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));
}
