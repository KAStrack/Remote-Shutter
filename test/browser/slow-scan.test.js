// The viewer starts ICE checks as soon as it has the offer, but the camera
// only learns the answer once someone scans the reply QR. Make sure a slow
// scan (longer than ICE's ~30 s check budget) still connects.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openHarness, closeAll } from './engines.js';
import { startServer } from '../serve.js';

// Takes ~90 s, so it only runs when asked: SLOW=1 npm run test:browser
const DELAY_MS = Number(process.env.SLOW_SCAN_MS || 45000);
const skip = !process.env.SLOW && 'set SLOW=1 to run';
let server;
let origin;

before(async () => {
  server = await startServer(0);
  origin = `http://localhost:${server.address().port}`;
});
after(() => server.close());

for (const [camEngine, viewEngine] of [['chromium', 'webkit'], ['webkit', 'chromium']]) {
  test(`slow reply scan: camera ${camEngine} -> viewer ${viewEngine}`, { skip, timeout: DELAY_MS + 60000 }, async () => {
    const cam = await openHarness(camEngine, origin);
    const view = await openHarness(viewEngine, origin);
    try {
      const offer = await cam.page.evaluate(() => window.startCamera());
      const answer = await view.page.evaluate((o) => window.startViewer(o), offer);
      await new Promise((r) => setTimeout(r, DELAY_MS));
      const before = await view.page.evaluate(() => `${window.side.pc.iceConnectionState}/${window.side.pc.connectionState}`);
      console.log(`viewer state after ${DELAY_MS / 1000}s without an answer: ${before}`);
      await cam.page.evaluate((a) => window.finishCamera(a), answer);
      await Promise.all([cam.page.evaluate(() => window.waitOpen()), view.page.evaluate(() => window.waitOpen())]);
      const after = await view.page.evaluate(() => window.side.pc.connectionState);
      assert.equal(after, 'connected');
    } finally {
      await closeAll(cam.browser, view.browser);
    }
  });
}
