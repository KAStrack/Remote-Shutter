// Screenshots of every screen in a real paired session, for design review.
// Usage: node test/tools/screens.mjs <out-dir> [locale]
import { chromium } from 'playwright';
import { startServer } from '../serve.js';
import { readQr, showToCamera, restoreCamera } from '../browser/app-helpers.js';

const out = process.argv[2] || '.';
const locale = process.argv[3] || 'en-US';
const server = await startServer(0);
const origin = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['camera'], hasTouch: true, isMobile: true, locale };
const shot = (page, name) => page.screenshot({ path: `${out}/${name}${locale === 'en-US' ? '' : `-${locale}`}.png` });

for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ ...phone, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(origin + '/');
  await page.waitForTimeout(300);
  await shot(page, `home-${scheme}`);
  await ctx.close();
}

const camCtx = await browser.newContext(phone);
const cam = await camCtx.newPage();
await cam.goto(origin + '/');
await cam.click('[data-action="role-camera"]');
const offerUrl = await readQr(cam, '#offer-qr');
await shot(cam, 'camera-offer');

const viewCtx = await browser.newContext(phone);
const view = await viewCtx.newPage();
await view.goto(offerUrl);
await shot(view, 'viewer-intro-link');
await view.click('#btn-viewer-connect');
await readQr(view, '#answer-qr');
await shot(view, 'viewer-reply');
const answerSvg = await view.$eval('#answer-qr svg', (el) => el.outerHTML);

await cam.click('#btn-scan-reply');
await showToCamera(cam, answerSvg);
await cam.waitForTimeout(250);
await shot(cam, 'camera-scan');
await cam.waitForFunction(() => document.body.dataset.screen === 'camera-live', null, { timeout: 20000 });
await restoreCamera(cam);
await view.waitForFunction(() => document.getElementById('viewer-status').dataset.state === 'live', null, { timeout: 20000 });
await view.waitForTimeout(1500);
await shot(view, 'viewer-live');

// Show the zoom control as it looks on phones that support it.
await view.evaluate(() => { document.getElementById('zoom').hidden = false; });
await view.click('#btn-timer');
await shot(view, 'viewer-live-zoom-timer');
await view.evaluate(() => { document.getElementById('zoom').hidden = true; });

await view.click('#btn-shutter');
await cam.waitForFunction(() => !document.getElementById('camera-count').hidden);
await view.waitForTimeout(200);
await shot(view, 'viewer-countdown');
await shot(cam, 'camera-countdown');
await view.waitForFunction(() => !document.getElementById('review').hidden, null, { timeout: 10000 });
await view.waitForTimeout(60);
await shot(view, 'viewer-developing');
await view.waitForFunction(() => document.getElementById('polaroid').classList.contains('developed'), null, { timeout: 20000 });
await view.waitForTimeout(3000);
await shot(view, 'viewer-photo');
await cam.waitForTimeout(300);
await shot(cam, 'camera-live');

// Full screen, then zoomed in on the middle with a double tap.
await view.click('#btn-full');
await view.waitForTimeout(400);
await shot(view, 'viewer-full');
await view.tap('#lightbox', { position: { x: 195, y: 422 } });
await view.tap('#lightbox', { position: { x: 195, y: 422 } });
await view.waitForTimeout(400);
await shot(view, 'viewer-full-zoomed');
await view.click('.lightbox-close');

// Saved: green button and a stamp on the print; same on the camera phone.
await view.click('#btn-save');
await view.waitForFunction(() => document.getElementById('polaroid').classList.contains('saved'));
await view.waitForTimeout(400);
await shot(view, 'viewer-saved');
await cam.click('#btn-camera-save');
await cam.waitForFunction(() => document.getElementById('btn-camera-save').classList.contains('done'));
await shot(cam, 'camera-saved');

await view.click('[data-action="close-photo"]');
await view.click('.live-top [data-action="disconnect"]');
await cam.waitForFunction(() => !document.getElementById('sheet').hidden);
await shot(cam, 'camera-sheet');

await browser.close();
server.close();
console.log('done');
