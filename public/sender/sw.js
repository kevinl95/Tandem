// Tandem sender service worker: makes the page installable and able to open
// offline. Network first, so a new deploy is never hidden behind a stale
// cache; the cache only answers when the network can't.
const CACHE = "tandem-sender";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Leave the APK download alone rather than caching 20+ MB.
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/downloads/")) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? Response.error())),
  );
});
