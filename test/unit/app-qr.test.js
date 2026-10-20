// The README's QR code must be current and must open the published app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeQr } from '../../docs/js/qr.js';
import { APP_URL, appQrSvg } from '../tools/app-qr.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const jsQR = (() => {
  const module = { exports: {} };
  new Function('module', 'exports', fs.readFileSync(path.join(here, '../../docs/vendor/jsQR.min.js'), 'utf8'))(module, module.exports);
  return module.exports;
})();

test('assets/app-qr.svg is up to date (regenerate with node test/tools/app-qr.mjs)', () => {
  assert.equal(fs.readFileSync(path.join(here, '../../assets/app-qr.svg'), 'utf8'), appQrSvg());
});

test('the app QR code decodes to the published URL', () => {
  const qr = makeQr(APP_URL);
  const scale = 4;
  const px = (qr.size + 8) * scale;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.isDark(r, c)) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = (((r + 4) * scale + y) * px + (c + 4) * scale + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  assert.equal(jsQR(data, px, px)?.data, APP_URL);
});
