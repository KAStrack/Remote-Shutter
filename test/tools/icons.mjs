// Renders docs/icons/icon.svg to the PNG sizes the manifest and iOS need.
// Usage: node test/tools/icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
const browser = await chromium.launch();
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: path.join(dir, name), omitBackground: false });
  await page.close();
  console.log(name);
}
await browser.close();
