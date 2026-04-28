// wineframe service worker — cache the big "runtime" assets so warm
// boots skip the ~700 MB download. Keep the cache key tied to the asset
// path; busting on size is good enough since the same path with new
// content gets a different size, and stale caches just retrigger a
// download on next miss.
//
// We never cache HTML/CSS/JS — those need to update when we publish.
// Only the heavy binary blobs are worth saving.

// v13 — Full round-4 revert after user reported 20+ min boot hangs.
// Back to the round-3 known-good baseline for everything that runs
// inside the guest (init.sh fb-pump cadence, watchdog defer,
// input-forwarder poll, plain wine launch with no nice, original
// pre-paint pattern) and for the QEMU args (tb-size 500, cmdline
// stripped of all R4 additions). Kept the JS-only round-5 progress
// UI improvements (phase model, exponential easing, % gauge,
// elapsed/remaining display, opacity 0.5 overlay).
const CACHE_NAME = "wineframe-runtime-v13";
const CACHEABLE = [
  /\/assets\/base-image\.img\.gz$/,
  /\/assets\/wine-prefix\.img\.gz$/,
  /\/assets\/qemu-system-x86_64\.wasm$/,
  /\/assets\/qemu-system-x86_64\.worker\.js$/,
  /\/assets\/qemu-system-x86_64\.js$/,
  /\/assets\/load-(kernel|initramfs|rom)\.(js|data)$/,
  /\/assets\/vmlinuz-virt$/,
  /\/assets\/initramfs-virt$/,
  /\/bridge\/bridge\.wasm$/,
];

const isCacheable = (url) => {
  try { const u = new URL(url); return CACHEABLE.some((re) => re.test(u.pathname)); }
  catch { return false; }
};

self.addEventListener("install", (event) => {
  // Activate immediately so the first page load that registers us starts
  // benefiting on its own subsequent fetches.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Drop old cache versions.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (!isCacheable(req.url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(req, { ignoreVary: true, ignoreSearch: true });
    if (hit) {
      // Background refresh: if Content-Length differs from network HEAD,
      // we silently redownload next session. Cheap heuristic kept in
      // sync with `.size` sidecar bumps.
      return hit;
    }
    // Cache miss: fetch and store. Don't cache opaque or partial responses.
    const resp = await fetch(req);
    if (resp && resp.status === 200 && resp.type !== "opaque") {
      // Clone before consuming, since we need to return the response.
      cache.put(req, resp.clone()).catch(() => { /* quota / ignored */ });
    }
    return resp;
  })());
});
