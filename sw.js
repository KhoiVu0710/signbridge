// Offline support: the app shell is fetched network-first (so updates show up),
// large immutable assets (MediaPipe, fonts, model, animations) cache-first.
// Paths are relative to this file so the app also works under a subpath (GitHub Pages).
const CACHE = "signbridge-web-v5";
const SHELL = ["./", "index.html", "styles.css", "manifest.webmanifest", "icons/icon.svg",
  "js/app.js", "js/recognizer.js", "js/lookup.js", "js/phrases.js", "js/camera.js", "js/speech.js",
  "js/study.js", "js/viewer3d.js", "js/compose.js", "js/personal.js", "js/letters.js", "js/vnspell.js", "js/spell.js", "js/lettertest.js",
  "icons/icon-192.png"];
const BASE = new URL("./", self.location).pathname;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  const path = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : url.pathname;
  const immutable = path.startsWith("vendor/") || path.startsWith("media/animations/");
  if (immutable) {
    event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
      return response;
    })));
  } else {
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => caches.match(event.request)));
  }
});
