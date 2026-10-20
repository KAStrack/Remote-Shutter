// Offline app shell. Bump VERSION whenever any file below changes, so phones
// pick up the new release (the unit tests check this list matches docs/).
const VERSION = 'v2';
const CACHE = `remote-shutter-${VERSION}`;

const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'fonts/jost-latin-wght.woff2',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon.svg',
  'js/app.js',
  'js/capture.js',
  'js/protocol.js',
  'js/qr-worker.js',
  'js/qr.js',
  'js/roles/camera.js',
  'js/roles/viewer.js',
  'js/share.js',
  'js/signaling-codec.js',
  'js/ui.js',
  'js/webrtc.js',
  'vendor/jsQR.min.js',
  'vendor/qrcode-generator.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('remote-shutter-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Cache first: the whole app is static and versioned above. Pairing links
// carry their data in the #fragment, which never reaches the network or this
// handler, so navigations can always be served the cached index.html.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const lookup = request.mode === 'navigate' ? caches.match('index.html') : caches.match(request, { ignoreSearch: true });
  event.respondWith(lookup.then((hit) => hit || fetch(request)));
});
