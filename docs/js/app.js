// Entry point: picks a role, routes taps to it, and handles pairing links.
import { $, show, currentScreen, showProblem, retryProblem, hideSheet } from './ui.js';
import { offerFromText, appUrl } from './webrtc.js';
import { qrSvg } from './qr.js';
import { closeLightbox, lightboxOpen } from './lightbox.js';
import { t, lang, setLanguage, initLanguage } from './i18n.js';
import * as camera from './roles/camera.js';
import * as viewer from './roles/viewer.js';

let role = null; // 'camera' | 'viewer' | null
let updateReady = false; // a new release has taken over; reload at the start screen

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
  if (updateReady) location.reload();
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

// The start screen's code for this page's own address, so the other phone
// can open the app without typing. Re-drawn on a language switch because its
// accessible name is translated.
function drawAppQr() {
  $('app-qr-image').replaceChildren(qrSvg(appUrl(), '', t('home.qrLabel')));
}

function switchLanguage() {
  setLanguage(lang() === 'zh-Hans' ? 'en' : 'zh-Hans', { remember: true });
  drawAppQr();
}

const actions = {
  home: goHome,
  'switch-language': switchLanguage,
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
  'open-full': () => viewer.openFullScreen(),
  'close-full': closeLightbox,
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

// Escape closes the full-screen photo, the photo review or the trouble sheet.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (lightboxOpen()) closeLightbox();
  else if (!$('review').hidden) viewer.closeReview();
  else if (!$('btn-sheet-dismiss').hidden) hideSheet();
});

// A new pairing link while the app is already open (e.g. the browser reused
// this tab when the QR was scanned again).
window.addEventListener('hashchange', handleLink);

initLanguage();
drawAppQr();
if (!handleLink()) show('home');

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));

  // The app is served from the service worker's cache, so a new release is
  // only fetched in the background. When it takes over, switch to it at once
  // if we're on the start screen, or as soon as we get back there, so a
  // session in progress is never interrupted.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install: this page is already current
    updateReady = true;
    if (currentScreen() === 'home') location.reload();
  });
  // An app left open in the background doesn't look for updates by itself.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentScreen() === 'home') {
      navigator.serviceWorker.getRegistration().then((reg) => reg?.update()).catch(() => {});
    }
  });
}
