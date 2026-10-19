// Captures real offer/answer SDPs from each engine using the app's own
// webrtc.js, and writes them to test/fixtures/ for the node unit tests.
// Usage: node test/tools/capture-sdp-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINES, openHarness, withServer } from '../browser/engines.js';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

await withServer(async (origin) => {
  for (const engine of ENGINES) {
    const { browser, page } = await openHarness(engine, origin);
    try {
      const res = await page.evaluate(async () => {
        const { track, source } = await window.cameraTrack();
        const cam = await window.rtc.createCameraPeer(track);
        const viewer = await window.rtc.createViewerPeer(cam.payload);
        return {
          source,
          offer: cam.pc.localDescription.sdp,
          answer: viewer.pc.localDescription.sdp,
        };
      });
      fs.writeFileSync(path.join(outDir, `${engine}-offer.sdp`), res.offer);
      fs.writeFileSync(path.join(outDir, `${engine}-answer.sdp`), res.answer);
      console.log(`${engine}: media from ${res.source}; offer ${res.offer.length} B, answer ${res.answer.length} B`);
    } finally {
      await browser.close();
    }
  }
});
