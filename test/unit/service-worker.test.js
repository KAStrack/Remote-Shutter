// The service worker's precache list must cover every file the app serves,
// or the installed app breaks offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [path.relative(docs, p).split(path.sep).join('/')];
  });
}

test('sw.js precaches every app file', () => {
  const src = fs.readFileSync(path.join(docs, 'sw.js'), 'utf8');
  const list = JSON.parse(`[${/const ASSETS = \[([\s\S]*?)\];/.exec(src)[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`);
  const needed = walk(docs).filter((f) => f !== 'sw.js' && !/LICENSE|\.txt$|\.md$|^\.nojekyll$/.test(f));
  assert.deepEqual(list.filter((a) => a !== './').sort(), needed.sort());
});

test('every local reference in index.html exists', () => {
  const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8');
  for (const [, ref] of html.matchAll(/(?:href|src)="([^"#:]+)"/g)) {
    assert.ok(fs.existsSync(path.join(docs, ref)), `${ref} is missing`);
  }
});

test('no external URLs in the app (no CDNs, analytics or requests)', () => {
  for (const f of walk(docs).filter((x) => /\.(html|js|mjs|css|webmanifest)$/.test(x))) {
    const src = fs.readFileSync(path.join(docs, f), 'utf8');
    const urls = [...src.matchAll(/https?:\/\/[^\s'"`)<>]+/g)].map((m) => m[0])
      .filter((u) => !/^http:\/\/www\.w3\.org\/2000\/svg|^http:\/\/www\.opensource\.org|^http:\/\/www\.d-project\.com|^http:\/\/www\.denso-wave\.com|^https?:\/\/(www\.)?(webrtc\.org|ietf\.org)\/|^https:\/\/github\.com\/cozmo\/jsQR|^http:\/\/www\.apache\.org/.test(u));
    assert.deepEqual(urls, [], `${f} references ${urls.join(', ')}`);
  }
});
