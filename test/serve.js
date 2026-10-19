// Tiny static server for docs/ (plus test/harness/ under /__test/).
// Usage: node test/serve.js [port] [--https]
// --https uses a self-signed cert (openssl must be installed) so phones on the
// LAN can open the app; accept the certificate warning on each phone.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const roots = { '/__test/': path.join(here, 'harness'), '/': path.join(here, '..', 'docs') };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const prefix = Object.keys(roots).find((p) => url.pathname.startsWith(p));
  const root = roots[prefix];
  let file = path.join(root, decodeURIComponent(url.pathname.slice(prefix.length)));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

export function startServer(port = 0, { secure = false } = {}) {
  let server;
  if (secure) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
      '-subj', '/CN=remote-shutter-dev', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`],
    { stdio: 'ignore' });
    server = https.createServer({ key: fs.readFileSync(`${dir}/key.pem`), cert: fs.readFileSync(`${dir}/cert.pem`) }, handler);
  } else {
    server = http.createServer(handler);
  }
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 8080;
  const secure = process.argv.includes('--https');
  const server = await startServer(port, { secure });
  const scheme = secure ? 'https' : 'http';
  const addrs = Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  console.log(`Serving docs/ on ${scheme}://localhost:${server.address().port}/`);
  for (const a of addrs) console.log(`  ${scheme}://${a}:${server.address().port}/`);
}
