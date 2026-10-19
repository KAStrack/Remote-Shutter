// End-to-end through the real UI: QR codes are decoded from the rendered
// SVGs, the camera's in-page scanner reads the viewer's reply from a video
// stream, then shutter, self-timer, rotation and photo transfer are checked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { startServer } from '../serve.js';
import { closeAll } from './engines.js';
import { readQr, showToCamera, restoreCamera } from './app-helpers.js';

let server;
let origin;
before(async () => {
  server = await startServer(0);
  origin = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const LAUNCH = {
  chromium: () => chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }),
  webkit: () => webkit.launch(),
};

async function openApp(engine, path = '/') {
  const browser = await LAUNCH[engine]();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try { await context.grantPermissions(['camera'], { origin }); } catch { /* engine lacks it */ }
  if (engine === 'webkit') {
    // Playwright's Linux WebKit (WPE) tab often crashes on drawImage() from a
    // 4K camera stream, before any app code runs: an engine bug, not ours.
    // Cap its mock camera at 720p so the frame-capture path stays testable.
    await context.addInitScript(() => {
      const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
      if (!gum) return;
      navigator.mediaDevices.getUserMedia = (c) => gum(c?.video ? { ...c, video: { ...(typeof c.video === 'object' ? c.video : {}), width: { ideal: 1280 }, height: { ideal: 720 } } } : c);
    });
  }
  const page = await context.newPage();
  const errors = [];
  page.on('crash', () => console.log(`  !! ${engine} page crashed (${path})`));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (process.env.DEBUG) console.log(`  [${engine} ${m.type()}] ${m.text()}`);
    if (m.type() === 'error' && !/404|sw\.js/.test(m.text())) errors.push(m.text());
  });
  await page.goto(origin + path);
  return { browser, page, errors };
}

const screenOf = (page) => page.evaluate(() => document.body.dataset.screen);

async function waitForPhoto(viewer, previousSrc) {
  // Collect any error the camera reported, to explain a timeout.
  const toasts = [];
  const poll = setInterval(async () => {
    const t = await viewer.evaluate(() => !document.getElementById('toast').hidden && document.getElementById('toast').textContent).catch(() => null);
    if (t && !toasts.includes(t)) toasts.push(t);
  }, 200);
  try {
    await waitForPhotoInner(viewer, previousSrc);
  } catch (err) {
    err.message += ` (viewer toasts: ${JSON.stringify(toasts)})`;
    throw err;
  } finally {
    clearInterval(poll);
  }
  return viewer.evaluate(() => {
    const img = document.getElementById('review-img');
    return { src: img.src, width: img.naturalWidth, height: img.naturalHeight, method: document.getElementById('polaroid').dataset.method };
  });
}

async function waitForPhotoInner(viewer, previousSrc) {
  await viewer.waitForFunction((prev) => {
    const img = document.getElementById('review-img');
    return img.src && img.src !== prev && img.complete && img.naturalWidth > 0
      && document.getElementById('polaroid').classList.contains('developed');
  }, previousSrc, { timeout: 20000 });
}

const PAIRS = process.env.PAIR ? [process.env.PAIR.split(',')] : [['chromium', 'chromium'], ['chromium', 'webkit'], ['webkit', 'chromium']];
for (const [camEngine, viewEngine] of PAIRS) {
  test(`app: camera ${camEngine}, viewer ${viewEngine}`, { timeout: 120000 }, async () => {
    const cam = await openApp(camEngine);
    let view;
    try {
      // Camera shows its pairing code.
      await cam.page.click('[data-action="role-camera"]');
      const offerUrl = await readQr(cam.page, '#offer-qr');
      assert.ok(offerUrl, 'offer QR decodes');
      assert.ok(offerUrl.startsWith(`${origin}/#o=`), offerUrl);
      const offerVersion = await cam.page.$eval('#offer-qr svg', (el) => Number(el.dataset.version));

      // Viewer opens the link (as the native camera app would) and connects.
      view = await openApp(viewEngine, offerUrl.slice(origin.length));
      assert.equal(await screenOf(view.page), 'viewer-intro');
      assert.equal(await view.page.evaluate(() => location.hash), '', 'offer stripped from the URL');
      await view.page.click('#btn-viewer-connect');
      const answer = await readQr(view.page, '#answer-qr');
      assert.match(answer, /^[A-Z2-7]+$/);
      const answerSvg = await view.page.$eval('#answer-qr svg', (el) => el.outerHTML);

      // Camera scans the reply with its own in-page scanner.
      await cam.page.click('#btn-scan-reply');
      assert.equal(await screenOf(cam.page), 'camera-scan');
      await showToCamera(cam.page, answerSvg);
      await cam.page.waitForFunction(() => document.body.dataset.screen === 'camera-live', null, { timeout: 20000 });
      await restoreCamera(cam.page);
      await view.page.waitForFunction(() => document.body.dataset.screen === 'viewer-live', null, { timeout: 20000 });
      await view.page.waitForFunction(() => document.getElementById('viewer-status').dataset.state === 'live', null, { timeout: 15000 });

      // Capabilities arrive: zoom is shown exactly when the camera has it.
      await view.page.waitForFunction(() => document.getElementById('switch-label').dataset.ready === '1');
      const camZoom = await cam.page.evaluate(() => {
        const z = document.getElementById('cam-video').srcObject.getVideoTracks()[0].getCapabilities?.().zoom;
        return z && z.max > z.min ? z : null;
      });
      await view.page.waitForFunction((has) => document.getElementById('zoom').hidden === !has, !!camZoom);
      if (camZoom) {
        const target = Math.min(camZoom.max, camZoom.min + (camZoom.max - camZoom.min) / 2);
        await view.page.$eval('#zoom-range', (el, v) => {
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }, target);
        await cam.page.waitForFunction((v) => {
          const z = document.getElementById('cam-video').srcObject.getVideoTracks()[0].getSettings().zoom;
          return Math.abs(z - v) < 0.2;
        }, target, { timeout: 5000 });
      }

      // Shutter -> photo develops on the viewer, camera can save it.
      await view.page.click('#btn-shutter');
      const p1 = await waitForPhoto(view.page, '').catch(async (err) => {
        const v = await view.page.evaluate(() => ({
          review: !document.getElementById('review').hidden,
          polaroid: document.getElementById('polaroid').className,
          progress: document.getElementById('develop-progress').style.transform,
          caption: document.getElementById('review-caption').textContent,
          status: document.getElementById('viewer-status').textContent,
        }));
        const c = await cam.page.evaluate(() => ({
          save: document.getElementById('camera-save-label').textContent,
          screen: document.body.dataset.screen,
          video: `${document.getElementById('cam-video').videoWidth}x${document.getElementById('cam-video').videoHeight}`,
        }));
        err.message += `\nviewer: ${JSON.stringify(v)}\ncamera: ${JSON.stringify(c)}`;
        throw err;
      });
      assert.ok(p1.width >= 320 && p1.height >= 180, `photo is ${p1.width}x${p1.height}`);
      assert.equal(await cam.page.$eval('#btn-camera-save', (b) => b.disabled), false);
      assert.equal(await view.page.$eval('#btn-save', (b) => b.disabled), false);
      await view.page.click('[data-action="close-photo"]');

      // Rotate a quarter turn: the next photo comes out with sides swapped.
      await view.page.click('#btn-rotate');
      await view.page.click('#btn-shutter');
      const p2 = await waitForPhoto(view.page, p1.src);
      assert.equal(p2.width, p1.height, 'rotated width');
      assert.equal(p2.height, p1.width, 'rotated height');
      await view.page.click('[data-action="close-photo"]');

      // 3 s self-timer: countdown shows on both phones, then a photo arrives.
      await view.page.click('#btn-timer');
      const t0 = Date.now();
      await view.page.click('#btn-shutter');
      await view.page.waitForFunction(() => !document.getElementById('countdown').hidden);
      await cam.page.waitForFunction(() => !document.getElementById('camera-count').hidden);
      const p3 = await waitForPhoto(view.page, p2.src);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 2900, `timer fired after ${elapsed} ms`);
      assert.ok(p3.width > 0);
      await view.page.click('[data-action="close-photo"]');

      // Timer can be cancelled from the viewer.
      await view.page.click('#btn-shutter');
      await cam.page.waitForFunction(() => !document.getElementById('camera-count').hidden);
      await view.page.click('#btn-shutter');
      await cam.page.waitForFunction(() => document.getElementById('camera-count').hidden);

      // Viewer disconnects: the camera says so.
      await view.page.click('.live-top [data-action="disconnect"]');
      await cam.page.waitForFunction(() => !document.getElementById('sheet').hidden);
      assert.match(await cam.page.textContent('#sheet-title'), /Viewer disconnected/);

      console.log(`  ${camEngine} -> ${viewEngine}: offer QR v${offerVersion}, photo ${p1.width}x${p1.height} via ${p1.method}, rotated ${p2.width}x${p2.height}, timer ${elapsed} ms${camZoom ? ', zoom ok' : ''}`);
      assert.deepEqual(cam.errors, []);
      assert.deepEqual(view.errors, []);
    } finally {
      await closeAll(cam.browser, view?.browser);
    }
  });
}
