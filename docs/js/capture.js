// Camera access and still capture. Stills always come from the camera
// phone's own full-resolution track, never from the received preview.

import { t } from './i18n.js';

const JPEG_QUALITY = 0.92;
// Keep canvases under iOS's ~16.7 MP limit and phones' memory comfortable.
const MAX_PHOTO_PIXELS = 16_000_000;
const TAKE_PHOTO_TIMEOUT_MS = 6000;

export async function openCamera(facing = 'environment') {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('No camera API'), { name: 'NotSupportedError' });
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: 30 },
    },
  });
}

// Viewer side: ask for camera permission and drop it straight away. While
// permission is granted, browsers expose real host IPs instead of mDNS names.
export async function unlockHostCandidates() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

export function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return t('cameraError.blocked');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return t('cameraError.notFound');
    case 'NotReadableError':
    case 'AbortError':
      return t('cameraError.busy');
    case 'NotSupportedError':
      return t('cameraError.unsupported');
    default:
      return t('cameraError.other', { detail: err?.message || err });
  }
}

export function zoomInfo(track) {
  const caps = track?.getCapabilities?.();
  const z = caps?.zoom;
  if (!z || !(z.max > z.min)) return null;
  const value = track.getSettings?.().zoom ?? z.min;
  return { min: z.min, max: z.max, step: z.step || 0.1, value };
}

export async function setZoom(track, value) {
  const z = zoomInfo(track);
  if (!z) return null;
  const clamped = Math.min(z.max, Math.max(z.min, Number(value)));
  await track.applyConstraints({ advanced: [{ zoom: clamped }] });
  return track.getSettings?.().zoom ?? clamped;
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
  ]);
}

const SIG = 24; // signature size for orientation matching

// Grey-level signature of an image (after rotating by k quarter turns and
// cropping to `aspect`), mean-subtracted so exposure differences cancel out.
export function signature(source, sw, sh, k, aspect) {
  const c = document.createElement('canvas');
  c.width = SIG;
  c.height = SIG;
  const g = c.getContext('2d', { willReadFrequently: true });
  const crop = centreCrop(sw, sh, k % 2 ? 1 / aspect : aspect);
  drawRotated(g, source, crop, k, SIG, SIG);
  const px = g.getImageData(0, 0, SIG, SIG).data;
  const out = new Float32Array(SIG * SIG);
  let mean = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] = px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11;
    mean += out[i];
  }
  mean /= out.length;
  for (let i = 0; i < out.length; i++) out[i] -= mean;
  return out;
}

function centreCrop(sw, sh, aspect) {
  let cw = sw;
  let ch = sh;
  if (sw / sh > aspect) cw = sh * aspect;
  else ch = sw / aspect;
  return { x: (sw - cw) / 2, y: (sh - ch) / 2, w: cw, h: ch };
}

// Draw `crop` of `source`, rotated clockwise by k quarter turns, to fill a
// width x height target.
function drawRotated(g, source, crop, k, width, height) {
  g.save();
  if (k === 1) { g.translate(width, 0); g.rotate(Math.PI / 2); }
  if (k === 2) { g.translate(width, height); g.rotate(Math.PI); }
  if (k === 3) { g.translate(0, height); g.rotate(-Math.PI / 2); }
  const [dw, dh] = k % 2 ? [height, width] : [width, height];
  g.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, dw, dh);
  g.restore();
}

// Which quarter turn makes the full-sensor still look like the live frame?
// takePhoto() orientation differs across Android devices (sensor mounting,
// rotation lock), so compare content instead of trusting metadata.
export function matchOrientation(bitmap, ref, aspect) {
  let best = 0;
  let bestScore = Infinity;
  for (let k = 0; k < 4; k++) {
    const sig = signature(bitmap, bitmap.width, bitmap.height, k, aspect);
    let score = 0;
    for (let i = 0; i < sig.length; i++) score += Math.abs(sig[i] - ref[i]);
    if (score < bestScore) { bestScore = score; best = k; }
  }
  return best;
}

async function takeFullPhoto(track) {
  const ic = new ImageCapture(track);
  const settings = {};
  try {
    const caps = await withTimeout(ic.getPhotoCapabilities(), 2000, 'getPhotoCapabilities');
    const w = caps.imageWidth;
    const h = caps.imageHeight;
    if (w?.max && h?.max && w.max * h.max > MAX_PHOTO_PIXELS) {
      const scale = Math.sqrt(MAX_PHOTO_PIXELS / (w.max * h.max));
      const step = w.step || 1;
      settings.imageWidth = Math.max(w.min || 0, Math.floor((w.max * scale) / step) * step);
    }
  } catch { /* use the camera's default size */ }
  const blob = await withTimeout(ic.takePhoto(settings), TAKE_PHOTO_TIMEOUT_MS, 'takePhoto');
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the photo'))), 'image/jpeg', JPEG_QUALITY);
  });
}

// Capture a still. `rotation` is the viewer's extra clockwise quarter turns,
// baked into the pixels (canvas export drops EXIF, so orientation must be
// real). Returns { blob, width, height, method }.
export async function capturePhoto({ track, video, rotation = 0 }) {
  if (!video.videoWidth) throw new Error('The camera isn’t ready yet');
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  let source = video;
  let sw = vw;
  let sh = vh;
  let turn = 0;
  let method = 'frame';

  if (typeof ImageCapture === 'function' && track?.readyState === 'live') {
    try {
      // Reference first: some phones stall the stream while takePhoto runs.
      const ref = signature(video, vw, vh, 0, vw / vh);
      const bitmap = await takeFullPhoto(track);
      // Only worth it if it's actually bigger than a video frame.
      if (bitmap.width * bitmap.height > vw * vh) {
        turn = matchOrientation(bitmap, ref, vw / vh);
        source = bitmap;
        sw = bitmap.width;
        sh = bitmap.height;
        method = 'takePhoto';
      } else {
        bitmap.close();
      }
    } catch (err) {
      console.warn('takePhoto failed, using a video frame instead', err);
    }
  }

  // Crop the still to the preview's framing, so the photo is what you saw.
  const aspect = turn % 2 ? vh / vw : vw / vh;
  const crop = method === 'frame' ? { x: 0, y: 0, w: sw, h: sh } : centreCrop(sw, sh, aspect);
  let w = Math.round(crop.w);
  let h = Math.round(crop.h);
  const scale = Math.min(1, Math.sqrt(MAX_PHOTO_PIXELS / (w * h)));
  w = Math.round(w * scale);
  h = Math.round(h * scale);

  const total = (turn + rotation) % 4;
  const canvas = document.createElement('canvas');
  [canvas.width, canvas.height] = total % 2 ? [h, w] : [w, h];
  drawRotated(canvas.getContext('2d'), source, crop, total, canvas.width, canvas.height);
  if (source !== video) source.close();

  const blob = await canvasToJpeg(canvas);
  const out = { blob, width: canvas.width, height: canvas.height, method };
  canvas.width = canvas.height = 0; // free the memory promptly on iOS
  return out;
}
