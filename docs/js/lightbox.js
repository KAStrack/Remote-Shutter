// Full-screen photo: pinch, double-tap or scroll-wheel to zoom, drag to look
// around. The photo is laid out at its fitted size and zoomed with a
// transform, so the browser keeps drawing it from the full-resolution file.
import { $ } from './ui.js';

const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 10; // px a finger can drift and still count as a tap
const DOUBLE_TAP_ZOOM = 3;

const box = $('lightbox');
const img = $('lightbox-img');
// k: zoom over the fitted size; (x, y): where the photo's top-left corner
// sits on screen; (w, h): the fitted size; max: the largest k allowed.
const v = { k: 1, x: 0, y: 0, w: 0, h: 0, max: 4 };
const pointers = new Map();
let gesture = null;
let tap = null; // the finger that might turn out to be a tap
let lastTap = { at: 0, x: 0, y: 0 };
let opener = null;

export function openLightbox(url, returnFocus) {
  opener = returnFocus || null;
  box.hidden = false;
  img.onload = fit;
  img.src = url;
  if (img.complete) fit();
  box.querySelector('.lightbox-close').focus();
  // Restart the hint's fade-out.
  const hint = box.querySelector('.lightbox-hint');
  hint.classList.remove('fade');
  void hint.offsetWidth;
  hint.classList.add('fade');
}

export function closeLightbox() {
  if (box.hidden) return;
  box.hidden = true;
  pointers.clear();
  gesture = tap = null;
  opener?.focus();
}

export function lightboxOpen() {
  return !box.hidden;
}

function fit() {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !box.clientWidth) return;
  const f = Math.min(box.clientWidth / nw, box.clientHeight / nh);
  v.w = nw * f;
  v.h = nh * f;
  img.style.width = `${v.w}px`;
  img.style.height = `${v.h}px`;
  // Up to two screen pixels per photo pixel, and never less than 4x.
  v.max = Math.max(4, 2 / f);
  v.k = 1;
  apply();
}

// Keep the photo covering the screen where it can, centred where it can't.
function apply() {
  const W = box.clientWidth;
  const H = box.clientHeight;
  const sw = v.w * v.k;
  const sh = v.h * v.k;
  v.x = sw <= W ? (W - sw) / 2 : Math.min(0, Math.max(W - sw, v.x));
  v.y = sh <= H ? (H - sh) / 2 : Math.min(0, Math.max(H - sh, v.y));
  img.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
}

const clampZoom = (k) => Math.min(v.max, Math.max(1, k));

// Zoom to k, keeping the bit of photo under (px, py) where it is.
function zoomAt(k, px, py) {
  k = clampZoom(k);
  v.x = px - ((px - v.x) * k) / v.k;
  v.y = py - ((py - v.y) * k) / v.k;
  v.k = k;
  apply();
}

// (Re)start the gesture from the fingers now down: one pans, two pinch.
function startGesture() {
  const [a, b] = pointers.values();
  if (b) {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    // Photo point under the fingers' midpoint, in fitted (unzoomed) pixels.
    gesture = { pinch: true, dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, k: v.k, ix: (mx - v.x) / v.k, iy: (my - v.y) / v.k };
  } else if (a) {
    gesture = { pinch: false, sx: a.x, sy: a.y, x: v.x, y: v.y };
  } else {
    gesture = null;
  }
}

box.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  box.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  tap = pointers.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
  startGesture();
});

box.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p || !gesture) return;
  p.x = e.clientX;
  p.y = e.clientY;
  if (tap && Math.hypot(p.x - tap.x, p.y - tap.y) > TAP_SLOP) tap = null;
  if (gesture.pinch) {
    const [a, b] = pointers.values();
    const k = clampZoom((gesture.k * Math.hypot(b.x - a.x, b.y - a.y)) / gesture.dist);
    v.x = (a.x + b.x) / 2 - gesture.ix * k;
    v.y = (a.y + b.y) / 2 - gesture.iy * k;
    v.k = k;
  } else {
    v.x = gesture.x + p.x - gesture.sx;
    v.y = gesture.y + p.y - gesture.sy;
  }
  apply();
});

function pointerEnd(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (e.type === 'pointerup' && tap?.id === e.pointerId) onTap(e.clientX, e.clientY);
  tap = null;
  startGesture();
}
box.addEventListener('pointerup', pointerEnd);
box.addEventListener('pointercancel', pointerEnd);

// Double tap: zoom in on that spot, or back out to the whole photo.
function onTap(x, y) {
  const now = performance.now();
  const double = now - lastTap.at < DOUBLE_TAP_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < TAP_SLOP * 3;
  lastTap = double ? { at: 0, x: 0, y: 0 } : { at: now, x, y };
  if (!double) return;
  img.classList.add('glide');
  if (v.k > 1.01) zoomAt(1, x, y);
  else zoomAt(DOUBLE_TAP_ZOOM, x, y);
  setTimeout(() => img.classList.remove('glide'), 250);
}

box.addEventListener('wheel', (e) => {
  e.preventDefault();
  const lines = e.deltaMode === 1 ? 16 : 1;
  zoomAt(v.k * Math.exp(-e.deltaY * lines * 0.002), e.clientX, e.clientY);
}, { passive: false });

// iOS Safari's own pinch-zoom of the page.
box.addEventListener('gesturestart', (e) => e.preventDefault());

// Turning the phone: fit the photo to the new shape.
new ResizeObserver(() => { if (!box.hidden) fit(); }).observe(box);
