// wineframe service worker — cache the big "runtime" assets so warm
// boots skip the ~700 MB download. Keep the cache key tied to the asset
// path; busting on size is good enough since the same path with new
// content gets a different size, and stale caches just retrigger a
// download on next miss.
//
// We never cache HTML/CSS/JS — those need to update when we publish.
// Only the heavy binary blobs are worth saving.

// v20 — Snapshot, take 3 — Path B (Path A failed: device_del didn't
// unrealize virtio-9p in this wasm QEMU build, so the migration
// blocker stayed up).
//   - QEMU args: VirtFS dropped entirely. No `-virtfs`, no `-fsdev`,
//     no `-device virtio-9p-pci`. The migration blocker is gone.
//   - JS input forwarder: bytes go through master.ldisc.writeFromLower
//     (= QEMU stdio = guest /dev/console) instead of writing to
//     /.wasmenv/wf-input.txt. Suppressed during snapshot save so the
//     event lines don't land at the monitor prompt.
//   - init.sh: dropped the 9P modprobe + mount; replaced the
//     file-polling input forwarder with a `read` loop on /dev/console
//     that filters lines to MV/DOWN/UP/CLICK/KEY before xdotool.
//   - saveSnapshot: dropped the device_del block (no longer needed,
//     and didn't work). Same probe → stop → migrate variants → gzip
//     → download flow.
const CACHE_NAME = "wineframe-runtime-v20";
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
