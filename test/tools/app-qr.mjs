// Writes assets/app-qr.svg, the README's QR code for the published app.
// Usage: node test/tools/app-qr.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeQr, qrPath } from '../../docs/js/qr.js';

export const APP_URL = 'https://kastrack.github.io/Remote-Shutter/';

export function appQrSvg(url = APP_URL) {
  const { d, n } = qrPath(makeQr(url));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">
  <title>QR code: ${url}</title>
  <rect width="${n}" height="${n}" fill="#fff"/>
  <path fill="#000" d="${d}"/>
</svg>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../assets/app-qr.svg');
  fs.writeFileSync(out, appQrSvg());
  console.log(`wrote ${out}`);
}
