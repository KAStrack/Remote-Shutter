// takePhoto() stills can come back in sensor orientation and with a wider
// aspect than the preview. capture.js picks the quarter turn whose content
// best matches the live frame; check it on synthetic stills in each engine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openHarness, closeAll } from './engines.js';
import { startServer } from '../serve.js';

let server;
let origin;
before(async () => {
  server = await startServer(0);
  origin = `http://localhost:${server.address().port}`;
});
after(() => server.close());

for (const engine of ['chromium', 'webkit']) {
  test(`${engine}: picks the right rotation for full-sensor stills`, async () => {
    const { browser, page } = await openHarness(engine, origin);
    try {
      const results = await page.evaluate(async () => {
        const { signature, matchOrientation } = await import('/js/capture.js');
        const scene = (g, w, h) => {
          // An asymmetric scene: sky gradient, a dark block bottom-left, a sun top-right.
          const sky = g.createLinearGradient(0, 0, 0, h);
          sky.addColorStop(0, '#6ab0ff');
          sky.addColorStop(1, '#f7e7c4');
          g.fillStyle = sky;
          g.fillRect(0, 0, w, h);
          g.fillStyle = '#222';
          g.fillRect(w * 0.05, h * 0.55, w * 0.35, h * 0.4);
          g.fillStyle = '#ffcc00';
          g.beginPath();
          g.arc(w * 0.78, h * 0.22, h * 0.12, 0, Math.PI * 2);
          g.fill();
        };
        const out = [];
        for (const [vw, vh] of [[640, 360], [360, 640]]) {
          // The "live frame" the user saw.
          const frame = document.createElement('canvas');
          frame.width = vw; frame.height = vh;
          scene(frame.getContext('2d'), vw, vh);
          const ref = signature(frame, vw, vh, 0, vw / vh);
          for (let k = 0; k < 4; k++) {
            // A bigger still with extra margins (4:3-ish sensor vs 16:9 preview),
            // stored rotated counter-clockwise by k quarter turns.
            const pad = 0.12;
            const big = document.createElement('canvas');
            big.width = vw * 3 * (1 + (vw > vh ? 0 : pad * 2));
            big.height = vh * 3 * (1 + (vw > vh ? pad * 2 : 0));
            const bg = big.getContext('2d');
            bg.fillStyle = '#888';
            bg.fillRect(0, 0, big.width, big.height);
            bg.drawImage(frame, (big.width - vw * 3) / 2, (big.height - vh * 3) / 2, vw * 3, vh * 3);
            const still = document.createElement('canvas');
            [still.width, still.height] = k % 2 ? [big.height, big.width] : [big.width, big.height];
            const sg = still.getContext('2d');
            sg.translate(still.width / 2, still.height / 2);
            sg.rotate((-k * Math.PI) / 2);
            sg.drawImage(big, -big.width / 2, -big.height / 2);
            const bitmap = await createImageBitmap(still);
            out.push({ frame: `${vw}x${vh}`, stored: k, picked: matchOrientation(bitmap, ref, vw / vh) });
          }
        }
        return out;
      });
      for (const r of results) assert.equal(r.picked, r.stored, `${r.frame}, stored ${r.stored} turns CCW`);
    } finally {
      await closeAll(browser);
    }
  });
}
