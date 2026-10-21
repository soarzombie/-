// Offline support: the app shell is cached so measuring works without signal.
// Bump VERSION whenever any cached file changes so phones pick up the update.
const VERSION = 'v0.10.0';
const CACHE = `noise-meter-${VERSION}`;
const FILES = [
  './',
  'index.html',
  'js/analysis.js',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/audio.js',
  'js/dsp.js',
  'js/format.js',
  'js/levelbar.js',
  'js/level-processor.js',
  'js/meter.js',
  'js/octave.js',
  'js/presets.js',
  'js/settings.js',
  'js/share.js',
  'js/spectrogram.js',
  'js/spectrum.js',
  'js/timeline.js',
  'js/store.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('noise-meter-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)),
  );
});
