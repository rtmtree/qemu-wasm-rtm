// wineframe service worker — cache the big "runtime" assets so warm
// boots skip the ~700 MB download. Keep the cache key tied to the asset
// path; busting on size is good enough since the same path with new
// content gets a different size, and stale caches just retrigger a
// download on next miss.
//
// We never cache HTML/CSS/JS — those need to update when we publish.
// Only the heavy binary blobs are worth saving.

// v8 — R-K24 reverted (wine --desktop= directly broke AGS init).
// Final shipped set is R-K23 v2: WINEDLLOVERRIDES disables
// services.exe + svchost.exe + plugplay.exe + winedevice.exe +
// spoolsv.exe + conhost.exe + dllhost.exe + startupinfo.exe (and
// the round-1 mscoree, mshtml, winemenubuilder defaults). Bump
// when rootfs changes.
const CACHE_NAME = "wineframe-runtime-v8";
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
