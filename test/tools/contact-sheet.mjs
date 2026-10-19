// Tiles screenshots into one image for quick review.
// Usage: node test/tools/contact-sheet.mjs <out.png> <img>...
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const [outFile, ...imgs] = process.argv.slice(2);
const cells = imgs.map((f) => `<figure><img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}"><figcaption>${path.basename(f, '.png')}</figcaption></figure>`).join('');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.setContent(`<style>body{margin:0;padding:12px;background:#888;font:14px sans-serif;display:grid;grid-template-columns:repeat(4,1fr);gap:12px}figure{margin:0}img{width:100%;display:block;border-radius:8px}figcaption{padding:4px;color:#fff}</style>${cells}`);
await page.screenshot({ path: outFile, fullPage: true });
await browser.close();
