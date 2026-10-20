// Every language has every string, the page and code only use keys that
// exist, and language detection picks Simplified Chinese only when it should.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, pickLanguage } from '../../docs/js/i18n.js';

const docs = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs');
const en = LOCALES.en;
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

for (const [code, dict] of Object.entries(LOCALES)) {
  test(`${code}: same keys and placeholders as English`, () => {
    assert.deepEqual(Object.keys(dict).sort(), Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      assert.deepEqual(placeholders(dict[key]), placeholders(en[key]), key);
      assert.ok(dict[key].trim(), `${key} is empty`);
    }
  });

  test(`${code}: markup only in *Html keys, and only <strong>`, () => {
    for (const [key, value] of Object.entries(dict)) {
      const tags = [...value.matchAll(/<\/?([a-z]+)[^>]*>/gi)].map((m) => m[1].toLowerCase());
      if (key.endsWith('Html')) assert.ok(tags.every((t) => t === 'strong'), key);
      else assert.deepEqual(tags, [], key);
    }
  });
}

test('every key used in index.html exists', () => {
  const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-html|-label|-alt)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 50);
  for (const k of keys) assert.ok(k in en, k);
});

test('every literal key used in the code exists', () => {
  const files = ['app.js', 'ui.js', 'capture.js', 'roles/camera.js', 'roles/viewer.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(docs, 'js', f), 'utf8');
    const keys = [
      ...src.matchAll(/\bt\('([\w.]+)'/g),
      ...src.matchAll(/set(?:Text|Label|Status)\([^,]+,\s*(?:'[\w-]+',\s*)?'([\w.]+)'/g),
      ...src.matchAll(/'((?:camera|viewer|status|sheet|home|common)\.\w+)'/g),
    ].map((m) => m[1]);
    for (const k of keys) assert.ok(k in en, `${f}: ${k}`);
  }
});

test('errors the camera sends to the viewer all have translations', () => {
  const src = fs.readFileSync(path.join(docs, 'js/roles/camera.js'), 'utf8');
  const codes = [...src.matchAll(/MSG\.ERROR, \{ code: '(\w+)' \}/g)].map((m) => m[1]);
  assert.ok(codes.length >= 3);
  for (const c of codes) assert.ok(`remote.${c}` in en, c);
});

test('language detection', () => {
  const cases = [
    [['zh-CN'], 'zh-Hans'],
    [['zh'], 'zh-Hans'],
    [['zh-Hans-CN'], 'zh-Hans'],
    [['zh-SG', 'en'], 'zh-Hans'],
    [['zh-TW'], 'en'],
    [['zh-HK', 'zh-CN'], 'zh-Hans'],
    [['zh-Hant-TW'], 'en'],
    [['en-GB', 'zh-CN'], 'en'],
    [['fr-FR', 'zh-CN'], 'zh-Hans'],
    [['fr-FR', 'de'], 'en'],
    [[], 'en'],
  ];
  for (const [prefs, want] of cases) assert.equal(pickLanguage(prefs), want, prefs.join(','));
  assert.equal(pickLanguage(['zh-CN'], 'en'), 'en', 'a chosen language wins');
  assert.equal(pickLanguage(['en'], 'zh-Hans'), 'zh-Hans');
  assert.equal(pickLanguage(['zh-CN'], 'xx'), 'zh-Hans', 'ignores unknown stored values');
});
