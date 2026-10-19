// Saving photos. Browsers need a user tap, so this always runs from a click.
//
// iOS: the Web Share sheet with a File offers "Save Image" (to Photos). A
//   plain download only reaches the Files app, so share is the primary action.
// Android and others: a normal download (lands in Downloads, which Google
//   Photos and most galleries show). Share is offered as a second button
//   where the browser supports sharing files.

export function isIOS() {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support gives it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function photoFile(blob, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return new File([blob], `remote-shutter-${stamp}.jpg`, { type: blob.type || 'image/jpeg', lastModified: date.getTime() });
}

export function canShareFile(file) {
  try {
    return typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] }) === true;
  } catch {
    return false;
  }
}

export function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// Must be called synchronously from a tap (Safari drops the user gesture
// after any await), so the File has to exist already.
// Resolves to 'shared' | 'cancelled' | 'downloaded'.
export async function share(file) {
  try {
    // Files only: adding title or text makes iOS hide "Save Image".
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (err) {
    if (err?.name === 'AbortError') return 'cancelled';
    download(file);
    return 'downloaded';
  }
}

// The primary "Save" action for this platform.
export function save(file) {
  if (isIOS() && canShareFile(file)) return share(file);
  download(file);
  return Promise.resolve('downloaded');
}

// Whether to show a separate "Share…" button next to Save.
export function offerSeparateShare(file) {
  return !isIOS() && canShareFile(file);
}
