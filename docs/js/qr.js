// QR rendering (qrcode-generator) and in-page scanning (jsQR in a worker).
import qrcode from '../vendor/qrcode-generator.mjs';

const QUIET_ZONE = 4; // modules, per the QR spec

// Medium error correction is more forgiving of glare on a phone screen; drop
// to Low only if Medium would push the code past a comfortable density.
const COMFORTABLE_VERSION = 12;

// `prefix` (e.g. the app URL) is encoded in byte mode; `payload` must be
// base32 so it can use the denser alphanumeric mode. Scanners join the two
// segments transparently.
export function makeQr(prefix, payload) {
  let qr;
  for (const ecl of ['M', 'L']) {
    qr = qrcode(0, ecl);
    if (prefix) qr.addData(prefix, 'Byte');
    qr.addData(payload, 'Alphanumeric');
    qr.make();
    if ((qr.getModuleCount() - 17) / 4 <= COMFORTABLE_VERSION) break;
  }
  const size = qr.getModuleCount();
  return {
    size,
    version: (size - 17) / 4,
    isDark: (r, c) => qr.isDark(r, c),
  };
}

// Returns an <svg> that scales crisply to whatever size CSS gives it.
export function qrSvg(prefix, payload, label = 'Pairing code') {
  const qr = makeQr(prefix, payload);
  const n = qr.size + QUIET_ZONE * 2;
  let d = '';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.isDark(r, c)) d += `M${c + QUIET_ZONE} ${r + QUIET_ZONE}h1v1h-1z`;
    }
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.classList.add('qr');
  svg.dataset.version = qr.version;
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', n);
  bg.setAttribute('height', n);
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  return svg;
}

// Scan a playing <video> for QR codes. Calls onCode(text) for each decode;
// return true from onCode to stop scanning.
export function startScanner(video, onCode) {
  const worker = new Worker(new URL('./qr-worker.js', import.meta.url));
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let busy = false;
  let stopped = false;
  let timer = 0;

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    worker.terminate();
  };

  worker.onmessage = (e) => {
    busy = false;
    if (stopped) return;
    if (e.data && onCode(e.data)) stop();
    else schedule();
  };
  worker.onerror = (e) => {
    console.error('QR worker failed', e);
    busy = false;
    schedule();
  };

  function schedule() {
    if (!stopped) timer = setTimeout(tick, 120);
  }

  function tick() {
    if (stopped || busy) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) { schedule(); return; }
    // Centre square crop, scaled down: the code is held in the middle of the
    // frame and jsQR is much faster on ~600px images.
    const side = Math.min(vw, vh) * 0.85;
    const out = Math.min(640, Math.round(side));
    canvas.width = out;
    canvas.height = out;
    ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, out, out);
    const img = ctx.getImageData(0, 0, out, out);
    busy = true;
    worker.postMessage({ width: out, height: out, buffer: img.data.buffer }, [img.data.buffer]);
  }

  schedule();
  return stop;
}
