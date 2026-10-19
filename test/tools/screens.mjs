// Screenshots of the main screens, for design review.
// Usage: node test/tools/screens.mjs <out-dir> [light|dark]
import { chromium } from 'playwright';
import { startServer } from '../serve.js';

const out = process.argv[2] || '.';
const scheme = process.argv[3] || 'light';
const server = await startServer(0);
const origin = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme, permissions: ['camera'], hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(origin + '/');
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/home-${scheme}.png` });
await page.click('[data-action="role-camera"]');
await page.waitForSelector('#offer-qr svg', { timeout: 10000 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/camera-offer.png` });
console.log('errors:', errors);
await browser.close();
server.close();
