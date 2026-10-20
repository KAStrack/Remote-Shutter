// Translations. Static text in index.html carries data-i18n* attributes;
// everything set from JS goes through t(). Add a language by adding a file to
// locales/ with the same keys and listing it in LOCALES.
import en from './locales/en.js';
import zhHans from './locales/zh-Hans.js';

export const LOCALES = { en, 'zh-Hans': zhHans };
const STORAGE_KEY = 'rs-lang';

let current = 'en';

// First of the user's preferred languages that we support. Simplified
// Chinese covers zh, zh-CN, zh-SG and zh-Hans-*; Traditional Chinese
// (zh-TW, zh-HK, zh-MO, zh-Hant-*) isn't covered, so it falls through.
export function pickLanguage(preferred = [], stored = null) {
  if (stored && LOCALES[stored]) return stored;
  for (const tag of preferred) {
    const t = String(tag).toLowerCase();
    if (t === 'en' || t.startsWith('en-')) return 'en';
    if (t === 'zh' || t.startsWith('zh-hans') || t === 'zh-cn' || t === 'zh-sg' || t === 'zh-my') return 'zh-Hans';
  }
  return 'en';
}

export function lang() {
  return current;
}

// Locale for dates and numbers (undefined = the browser's own).
export function locale() {
  return current === 'zh-Hans' ? 'zh-CN' : undefined;
}

export function t(key, vars = {}) {
  const text = LOCALES[current][key] ?? en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

const vars = (json) => (json ? JSON.parse(json) : {});

// Fill in every data-i18n* attribute under root.
export function translatePage(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n, vars(el.dataset.i18nVars));
  // Dictionary values are part of the app (not user input); only <strong> is used.
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel, vars(el.dataset.i18nLabelVars)));
  for (const el of root.querySelectorAll('[data-i18n-alt]')) el.setAttribute('alt', t(el.dataset.i18nAlt));
}

// Set an element's text from a key, remembering the key (and values) so a
// later language switch shows the same state in the new language.
export function setText(el, key, values) {
  el.dataset.i18n = key;
  if (values) el.dataset.i18nVars = JSON.stringify(values);
  else delete el.dataset.i18nVars;
  el.textContent = t(key, values);
}

// Same for aria-label.
export function setLabel(el, key, values) {
  el.dataset.i18nLabel = key;
  if (values) el.dataset.i18nLabelVars = JSON.stringify(values);
  else delete el.dataset.i18nLabelVars;
  el.setAttribute('aria-label', t(key, values));
}

export function setLanguage(code, { remember = false } = {}) {
  current = LOCALES[code] ? code : 'en';
  document.documentElement.lang = current;
  document.title = t('app.title');
  translatePage();
  if (remember) {
    try { localStorage.setItem(STORAGE_KEY, current); } catch { /* private mode */ }
  }
}

export function initLanguage() {
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* private mode */ }
  setLanguage(pickLanguage(navigator.languages?.length ? navigator.languages : [navigator.language], stored));
}
