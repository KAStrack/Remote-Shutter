// Cross-engine loopback: the camera runs in one engine, the viewer in
// another, and the only thing passed between them is the compact payload.
// Proves the rebuilt SDP is accepted by setRemoteDescription in each engine
// and that media and the data channel actually flow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES, openHarness, closeAll } from './engines.js';
import { startServer } from '../serve.js';

let server;
let origin;
const results = [];

before(async () => {
  server = await startServer(0);
  origin = `http://localhost:${server.address().port}`;
});
after(() => {
  server.close();
  console.table(results);
});

async function pollUntil(fn, ok, ms = 10000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

for (const camEngine of ENGINES) {
  for (const viewEngine of ENGINES) {
    // Headless Firefox only offers mDNS (.local) candidates, so Firefox to
    // Firefox depends on the host's multicast DNS. Real phones running the
    // app grant camera access and expose real IPs on the camera side.
    const skip = camEngine === 'firefox' && viewEngine === 'firefox' && !process.env.FF_MDNS
      && 'both sides mDNS-only; set FF_MDNS=1 to try';
    test(`camera ${camEngine} -> viewer ${viewEngine}`, { skip, timeout: 60000 }, async () => {
      const cam = await openHarness(camEngine, origin);
      const view = await openHarness(viewEngine, origin);
      try {
        const offer = await cam.page.evaluate(() => window.startCamera());
        const answer = await view.page.evaluate((o) => window.startViewer(o), offer);
        await cam.page.evaluate((a) => window.finishCamera(a), answer);
        await Promise.all([cam.page.evaluate(() => window.waitOpen()), view.page.evaluate(() => window.waitOpen())]);

        await view.page.evaluate(() => window.expectMessage());
        await cam.page.evaluate(() => window.expectMessage());
        await cam.page.evaluate(() => window.side.dc.send('hello viewer'));
        await view.page.evaluate(() => window.side.dc.send('hello camera'));
        const fromCam = await view.page.evaluate(() => window.nextMessage);
        const fromViewer = await cam.page.evaluate(() => window.nextMessage);
        assert.equal(fromCam, 'hello viewer');
        assert.equal(fromViewer, 'hello camera');

        const rx = await pollUntil(() => view.page.evaluate(() => window.mediaStats()), (s) => s.framesDecoded > 5);
        const tx = await cam.page.evaluate(() => window.mediaStats());
        results.push({ camera: camEngine, viewer: viewEngine, offerChars: offer.length, answerChars: answer.length,
          codec: rx.codec || tx.codec, framesDecoded: rx.framesDecoded, rxSize: rx.width ? `${rx.width}x${rx.height}` : '?' });
        assert.ok(rx.framesDecoded > 5, `viewer decoded ${rx.framesDecoded} frames`);
      } finally {
        await closeAll(cam.browser, view.browser);
      }
    });
  }
}
