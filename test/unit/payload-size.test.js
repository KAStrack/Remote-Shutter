// Measures real payload sizes for typical candidate sets and checks that the
// resulting QR codes stay small, then proves they decode with jsQR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactFromSdp, encodeCompact, decodePayload, fromBase32 } from '../../docs/js/signaling-codec.js';
import { makeQr } from '../../docs/js/qr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'fixtures');

// The vendored jsQR is a UMD bundle meant for importScripts; load it as CommonJS.
const jsQR = (() => {
  const module = { exports: {} };
  new Function('module', 'exports', fs.readFileSync(path.join(here, '../../docs/vendor/jsQR.min.js'), 'utf8'))(module, module.exports);
  return module.exports;
})();
const load = (name) => fs.readFileSync(path.join(fixtures, `${name}.sdp`), 'utf8');

// A realistic GitHub Pages URL; the actual one is used at runtime.
const APP_URL = 'https://your-username.github.io/remote-shutter/';
// Comfortable for a phone camera at arm's length on a phone screen.
const MAX_VERSION = 10;

const v4 = (a, port = 51234) => ({ kind: 4, address: a, port });
const v6 = (a, port = 51235) => ({ kind: 6, address: a, port });
const mdns = (n, port = 51236) => ({ kind: 1, address: `${n}a1b2c3d-1111-4222-8333-944445555666.local`.slice(-42), port });

const SCENARIOS = [
  ['Wi-Fi, one IPv4', [v4('192.168.1.23')]],
  ['Wi-Fi + mobile data', [v4('192.168.1.23'), v4('10.71.4.200', 40100)]],
  ['Hotspot host (iPhone)', [v4('172.20.10.1'), v4('192.168.1.23', 40100)]],
  ['Worst case: four IPv4', [v4('192.168.1.23'), v4('10.71.4.200'), v4('172.20.10.1'), v4('100.64.3.9')]],
  ['IPv6 only, two', [v6('2a02:c7f:1234:5600:1c2a:3b4c:5d6e:7f80'), v6('fd00::1c2a:3b4c:5d6e:7f80')]],
  ['mDNS only, two (no permission)', [mdns('0'), mdns('1')]],
];

function qrStats(prefix, payload) {
  const qr = makeQr(prefix, payload);
  return { version: qr.version, modules: qr.size };
}

// Rasterise like a phone screen would show it: 4 px per module, quiet zone.
function rasterise(qr, scale = 4) {
  const n = qr.size + 8;
  const px = n * scale;
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
  return { data, width: px, height: px };
}

const rows = [];

for (const engine of ['chromium', 'webkit', 'firefox']) {
  for (const [name, candidates] of SCENARIOS) {
    test(`${engine} / ${name}: offer URL and answer fit in a small QR`, async () => {
      const offer = { ...compactFromSdp(load(`${engine}-offer`), 'offer'), candidates };
      const answer = { ...compactFromSdp(load(`${engine}-answer`), 'answer'), candidates };
      const offerText = await encodeCompact(offer);
      const answerText = await encodeCompact(answer);
      const prefix = `${APP_URL}#o=`;
      const o = qrStats(prefix, offerText);
      const a = qrStats('', answerText);
      rows.push({
        engine, scenario: name,
        offerBytes: fromBase32(offerText).length, offerUrlChars: prefix.length + offerText.length, offerQr: `v${o.version} (${o.modules}²)`,
        answerBytes: fromBase32(answerText).length, answerChars: answerText.length, answerQr: `v${a.version} (${a.modules}²)`,
        deflated: fromBase32(offerText)[0] === 1 ? 'yes' : 'no',
      });
      assert.ok(o.version <= MAX_VERSION, `offer QR is version ${o.version}`);
      assert.ok(a.version <= MAX_VERSION, `answer QR is version ${a.version}`);
      assert.deepEqual((await decodePayload(offerText)).compact.candidates.map((c) => c.address),
        candidates.map((c) => c.address));
    });
  }
}

test('generated QR codes decode with jsQR', async () => {
  const offer = { ...compactFromSdp(load('webkit-offer'), 'offer'), candidates: SCENARIOS[3][1] };
  for (const [prefix, payload] of [
    [`${APP_URL}#o=`, await encodeCompact(offer)],
    ['', await encodeCompact({ ...offer, type: 'answer', ssrcs: [] })],
  ]) {
    const img = rasterise(makeQr(prefix, payload));
    const code = jsQR(img.data, img.width, img.height);
    assert.ok(code, 'jsQR found the code');
    assert.equal(code.data, prefix + payload);
  }
});

test('report', () => {
  console.log('\nMeasured payload sizes (bytes are binary before base32):');
  console.table(rows);
});
