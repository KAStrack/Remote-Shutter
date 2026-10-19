// Launch helpers for the Playwright loopback tests.
import { chromium, firefox, webkit } from 'playwright';
import { startServer } from '../serve.js';

const LAUNCH = {
  chromium: () => chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  }),
  firefox: () => firefox.launch({
    firefoxUserPrefs: {
      'media.navigator.streams.fake': true,
      'media.navigator.permission.disabled': true,
    },
  }),
  webkit: () => webkit.launch(),
};

export const ENGINES = Object.keys(LAUNCH);

export async function withServer(fn) {
  const server = await startServer(0);
  try {
    return await fn(`http://localhost:${server.address().port}`);
  } finally {
    server.close();
  }
}

// Opens the loopback harness in a fresh browser of the given engine.
export async function openHarness(engine, origin) {
  const browser = await LAUNCH[engine]();
  const context = await browser.newContext();
  try { await context.grantPermissions(['camera'], { origin }); } catch { /* engine lacks it */ }
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[${engine}] pageerror`, e.message));
  await page.goto(`${origin}/__test/loopback.html`);
  await page.waitForFunction(() => window.ready === true);
  return { browser, page };
}
