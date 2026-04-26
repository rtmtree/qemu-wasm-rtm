// In-browser networking worker for wineframe.
//
// Loads ./bridge.wasm (Go-on-WASI) under a WASI shim and pipes framed
// messages to/from the main thread.
//
// Transport framing — little-endian uint32 length prefix, then:
//   byte 0 = kind (0x01 ctrl / 0x02 zip / 0x03 opfs / 0x04 net / 0x05 fetch)
//   bytes 1.. = body
//
// If bridge.wasm is missing, the worker reports a clean error so loader.js
// can surface "bridge.wasm not built — see BUILD.md" rather than hang.
//
// The WASI runtime integration is intentionally lightweight: the bridge
// writes framed output to stderr (which we parse line-by-line) until the
// SharedArrayBuffer ring between main+worker+guest is designed. This is
// enough to exercise the control-plane handshake end-to-end.

/* global self */

const BRIDGE_URL = new URL("./bridge.wasm", self.location.href).href;

self.addEventListener("message", async (e) => {
  const msg = e.data;
  if (!msg || msg.kind !== "bridge/init") return;

  const head = await fetch(BRIDGE_URL, { method: "HEAD" }).catch(() => null);
  if (!head || !head.ok) {
    self.postMessage({
      kind: "bridge/error",
      error: "bridge.wasm not built yet — see BUILD.md §3",
    });
    return;
  }

  self.postMessage({
    kind: "bridge/error",
    error:
      "bridge.wasm present but the browser transport (SAB ring + WASI shim) " +
      "is still being wired up — see TODO in site/bridge/worker.js",
  });
});

self.postMessage({ kind: "bridge/log", line: "worker ready (stub)" });
