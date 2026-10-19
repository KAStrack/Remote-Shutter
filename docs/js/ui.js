// Small DOM helpers shared by both roles.

export const $ = (id) => document.getElementById(id);

export function show(screen) {
  document.body.dataset.screen = screen;
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.dataset.screen !== screen;
  const heading = document.querySelector(`.screen[data-screen="${screen}"] h1, .screen[data-screen="${screen}"] h2`);
  heading?.setAttribute('tabindex', '-1');
}

export function currentScreen() {
  return document.body.dataset.screen;
}

let toastTimer = 0;
export function toast(text, ms = 2600) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// Status pill: state is one of connecting | live | warn | lost.
export function setStatus(id, state, text) {
  const el = $(id);
  el.dataset.state = state;
  el.querySelector('.status-text').textContent = text;
}

export function showProblem(title, text, retry) {
  $('problem-title').textContent = title;
  $('problem-text').textContent = text;
  const btn = $('btn-problem-retry');
  btn.hidden = !retry;
  problemRetry = retry || null;
  show('problem');
}
let problemRetry = null;
export function retryProblem() { problemRetry?.(); }

// The connection-trouble sheet. `waiting` adds a "Keep waiting" button for
// states that may still recover on their own.
export function showSheet({ title, text, hint = false, waiting = false }) {
  $('sheet-title').textContent = title;
  $('sheet-text').textContent = text;
  $('sheet-hint').hidden = !hint;
  $('btn-sheet-dismiss').hidden = !waiting;
  $('sheet').hidden = false;
}
export function hideSheet() { $('sheet').hidden = true; }

export function flash() {
  const el = $('flash');
  el.classList.remove('go');
  void el.offsetWidth; // restart the animation
  el.classList.add('go');
}

export function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
}

// Screen Wake Lock, re-acquired when the page becomes visible again (the
// browser releases it whenever the tab is hidden).
let wakeLock = null;
let wantWakeLock = false;
export async function keepAwake(on) {
  wantWakeLock = on;
  if (!('wakeLock' in navigator)) return;
  if (!on) {
    await wakeLock?.release().catch(() => {});
    wakeLock = null;
    return;
  }
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* low battery mode, or not visible yet */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantWakeLock) keepAwake(true);
});
