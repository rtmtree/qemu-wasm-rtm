// QEMU-wasm runtime glue.
//
// Flow:
//   1. probeRuntime() in loader.js has already verified assets exist.
//   2. We append the emscripten <script src="load-kernel.js"> etc. (classic,
//      non-module) so they register their FS preload plugins globally.
//   3. In preRun, we also fetch base-image.img.gz, decompress via
//      DecompressionStream, and write it into the virtual FS as
//      /pack-rootfs/disk-rootfs.img — bypassing the ~1.8 GB
//      file_packager bundle which browsers can't handle.
//   4. Start QEMU with kernel/initrd/rootfs drive + socket NIC pointing
//      at the bridge worker (currently stubbed).

const ASSETS = {
  emModule:  "./assets/qemu-system-x86_64.js",
  rootfsGz:  "./assets/base-image.img.gz",
  loadJS:    [
    "./assets/load-kernel.js",
    "./assets/load-initramfs.js",
    "./assets/load-rom.js",
  ],
};

function buildArgs({ appName, exe }) {
  return [
    "-nographic",
    "-M", "pc",
    "-m", "1024M",
    "-accel", "tcg,tb-size=500",
    "-L", "/pack-rom/",
    "-kernel", "/pack-kernel/vmlinuz-virt",
    "-initrd", "/pack-initramfs/initramfs-virt",
    "-append", [
      "console=ttyS0",
      // quiet + loglevel=0 mute kernel printk output so the framebuffer
      // pump (which shares /dev/console) gets clean serial bandwidth
      // instead of competing with dmesg.
      "quiet",
      "loglevel=0",
      "noautodetect",
      "hostname=wineframe",
      `wf.app=${appName}`,
      `wf.exe=${exe}`,
      "root=/dev/vda",
      "rw",
      // Skip the slow IDE/ATA controller probe — we use virtio-blk only.
      "libata.force=disable",
      "nomodeset",
      "vga=normal",
      // ACPI's PCI IRQ routing fails for virtio devices on the Emscripten
      // qemu-system-pc build ("can't derive routing for PCI INT A"),
      // hanging udev for ~30 s per device. Force the kernel to use the
      // BIOS routing tables instead.
      "acpi=noirq",
      "pci=noacpi",
    ].join(" "),
    "-drive", "id=root,file=/pack-rootfs/disk-rootfs.img,format=raw,if=none",
    "-device", "virtio-blk-pci,drive=root",
    "-virtfs", "local,path=/.wasmenv,mount_tag=wasm0,security_model=mapped-file,id=wasm0",
    "-netdev", "socket,id=vmnic,connect=localhost:8888",
    "-device", "virtio-net-pci,netdev=vmnic",
  ];
}

// Inject a classic <script src="..."> and resolve on load. Used for the
// file_packager-generated load-*.js scripts which register FS preload
// plugins by poking a window-scoped Module object.
function appendScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`load script: ${src}`));
    document.head.appendChild(s);
  });
}

// Read the decompressed size from a sidecar text file written at
// publish time. We can't rely on Range requests against Python's
// built-in http.server (no Range support), and reading the gzip ISIZE
// trailer over a non-Range fetch would download the whole 565 MB blob
// just to look at the last 4 bytes.
//
// The size is pre-allocated as a single Uint8Array via FS.ftruncate so
// MEMFS doesn't trigger its 1.86 GB doubling-growth cliff (V8 caps a
// single TypedArray around 2 GB).
async function getDecompressedSize(url) {
  const sidecar = url + ".size";
  try {
    const r = await fetch(sidecar);
    if (!r.ok) return 0;
    const text = (await r.text()).trim();
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

// Stream a gzipped URL straight into Emscripten's MEMFS, never holding
// the whole decompressed tree in JS heap. Peak memory ≈ rootfs size, not
// 2× rootfs size as the previous version had.
async function streamGzToFS({ url, fsPath, FS, log }) {
  log(`[runtime] GET ${url}`);

  // Fetch the sidecar size file first so we can pre-allocate the MEMFS
  // file once and avoid the 2×-doubling growth cliff.
  const finalSize = await getDecompressedSize(url).catch(() => 0);
  if (finalSize) log(`[runtime] rootfs target: ${fmt(finalSize)} (from .size sidecar)`);
  else            log(`[runtime] no .size sidecar — MEMFS may hit growth cliff`);

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  const contentLength = Number(resp.headers.get("Content-Length") || 0);

  let downloaded = 0;
  let lastDl = 0;
  const reportEvery = Math.max(1 << 20, Math.floor(contentLength / 20));
  const tee = new TransformStream({
    transform(chunk, controller) {
      downloaded += chunk.length;
      if (downloaded - lastDl >= reportEvery) {
        log(`[runtime] ${url} ${fmt(downloaded)} / ${fmt(contentLength)}`);
        lastDl = downloaded;
      }
      controller.enqueue(chunk);
    },
  });

  const decompressed = resp.body.pipeThrough(tee).pipeThrough(new DecompressionStream("gzip"));

  const dirSlash = fsPath.lastIndexOf("/");
  if (dirSlash > 0) {
    const dir = fsPath.slice(0, dirSlash);
    try { FS.mkdir(dir); } catch { /* exists */ }
  }
  const stream = FS.open(fsPath, "w+");
  if (finalSize) {
    // FS.ftruncate pre-allocates the underlying Uint8Array via
    // MEMFS.expandFileStorage(node, finalSize) — single allocation.
    try { FS.ftruncate(stream.fd, finalSize); }
    catch (e) { log(`[runtime] ftruncate(${finalSize}) failed: ${e.message || e}`); }
  }
  let written = 0;
  let lastWr = 0;
  const reader = decompressed.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      FS.write(stream, value, 0, value.length, written);
      written += value.length;
      if (written - lastWr >= 64 * 1024 * 1024) {
        log(`[runtime] wrote ${fmt(written)} of rootfs to MEMFS`);
        lastWr = written;
      }
    }
  } finally {
    FS.close(stream);
  }
  log(`[runtime] rootfs in MEMFS: ${fmt(written)}`);
  return written;
}

function fmt(n) {
  if (!n) return "?";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

export async function startRuntime({ stage, appName, exe, log, terminalEl }) {
  log("[runtime] loading file-packager preload scripts");

  // window.Module is what the load-*.js scripts look for.
  // We set it up before appending them.
  const Module = {
    preRun: [],
    arguments: buildArgs({ appName, exe }),
    mainScriptUrlOrBlob: new URL(ASSETS.emModule, location.href).href,
    // file_packager.py emits scripts that fetch their .data sibling using
    // a path relative to the document, not the script. Without locateFile,
    // load-kernel.js asks for /load-kernel.data instead of
    // /assets/load-kernel.data. This rewrites both the .data lookups and
    // the wasm/worker fetches into the assets/ dir.
    locateFile: (path, prefix) => {
      if (path.endsWith(".data") || path.endsWith(".wasm") ||
          path.endsWith(".worker.js") || path.endsWith(".js")) {
        return new URL("./assets/" + path, location.href).href;
      }
      return prefix + path;
    },
    print:    (s) => log(s),
    printErr: (s) => log(s),
  };
  window.Module = Module;

  for (const src of ASSETS.loadJS) await appendScript(src);

  // 1. Start the bridge worker (stub — will hand off once bridge.wasm
  // transport is wired).
  const bridge = await startBridge({ stage, log });
  Module.websocket = { url: bridge.url };

  // 2. Stream the rootfs straight into MEMFS at preRun time. We hold an
  // Emscripten run dependency open until the stream completes so the
  // module's main() is suspended on our async write.
  Module.preRun.push((m) => {
    m.addRunDependency("rootfs-stream");
    try { m.FS.mkdir("/.wasmenv"); } catch {}
    m.FS.writeFile("/.wasmenv/app", JSON.stringify({ appName, exe }));
    streamGzToFS({
      url:    ASSETS.rootfsGz,
      fsPath: "/pack-rootfs/disk-rootfs.img",
      FS:     m.FS,
      log,
    })
      .then(() => m.removeRunDependency("rootfs-stream"))
      .catch((e) => {
        log(`[runtime] rootfs stream failed: ${e.message || e}`);
        m.removeRunDependency("rootfs-stream");
      });
  });

  // 3. xterm + xterm-pty for the console.
  await Promise.all([
    import("https://unpkg.com/xterm@5.3.0/lib/xterm.js"),
    import("https://unpkg.com/xterm-pty/index.js"),
  ]);
  const xterm = new window.Terminal({
    fontSize: 12,
    theme: { background: "#000" },
    convertEol: true,
    scrollback: 50000,
  });
  xterm.open(terminalEl);
  const { master, slave } = window.openpty();
  xterm.loadAddon(master);
  Module.pty = slave;
  // Expose for introspection.
  window.__wfTerm = xterm;
  window.__wfPty  = { master, slave };

  // 4. Boot.
  log(`[runtime] instantiating qemu-system-x86_64 (app=${appName}, exe=${exe})`);
  const initEmscriptenModule = (await import(ASSETS.emModule)).default;
  const instance = await initEmscriptenModule(Module);

  const oldPoll = Module.TTY.stream_ops.poll;
  Module.TTY.stream_ops.poll = function (stream, timeout) {
    if (!slave.readable) {
      return (slave.readable ? 1 : 0) | (slave.writable ? 4 : 0);
    }
    return oldPoll.call(stream, timeout);
  };

  // 5. Framebuffer pump. The guest's init.sh streams Xvfb's screen
  // buffer to /var/host/fb.raw via a 9P share. That host path resolves
  // to /.wasmenv/fb.raw inside Emscripten's MEMFS. Poll it and blit to
  // <canvas id="fb">.
  startFramebufferPump(Module, log);

  return { instance, bridge };
}

function startFramebufferPump(Module, log) {
  const canvas = document.querySelector("#fb");
  if (!canvas) { log("[runtime] no #fb canvas, skipping fb pump"); return; }
  const ctx = canvas.getContext("2d");

  // Frames are emitted by the guest's fb-pump via /dev/console as:
  //   ~~WFFB:N:SZ~~<base64-of-Xvfb_screen0>~~ENDWFFB:N~~\n
  // where N is a sequence number and SZ is the raw byte count.
  //
  // xterm-pty's `term.onWriteParsed` is a notification event (called with
  // undefined args) — the actual byte stream flows through `slave.write`
  // as arrays of char codes, one chunk at a time. We monkey-patch
  // slave.write to mirror the bytes into our parser without breaking the
  // terminal display.
  const pty = window.__wfPty;
  if (!pty?.slave?.write) {
    log("[fb-pump] no pty.slave.write available — fb pump disabled");
    return;
  }

  let buf = "";
  let frames = 0, lastReport = 0, bytesSeen = 0;
  // Match Xvfb -screen 0 320x240x24 in init.sh. The fbdir file is XWD
  // format: ~3232 bytes of header + colormap, then the raw pixel data.
  const W = 320, H = 240, BPP = 4, PIX = W * H * BPP;
  // Frame body is 320*240*4 = 307200 bytes pixel + ~3232 header = 310432.
  // We accept any frame >= PIX bytes and slice the trailing pixels.
  const startRe = /~~WFFB:(\d+):(\d+)~~/;
  const endRe   = /~~ENDWFFB:(\d+)~~/;

  // Pre-size canvas so it shows up in the DOM at the right aspect.
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;

  window.__wfFb = {
    get frames() { return frames; },
    get bufLen() { return buf.length; },
    get bytesSeen() { return bytesSeen; },
  };

  function ingest(chunkStr) {
    buf += chunkStr;
    // Bound buffer to avoid OOM. 320x240 frames are ~410KB base64 so keep
    // ~16MB / ~30 frames worth of slack.
    if (buf.length > 16 * 1024 * 1024) buf = buf.slice(-8 * 1024 * 1024);

    while (true) {
      const sm = startRe.exec(buf);
      if (!sm) break;
      const startIdx = sm.index;
      const tail = buf.slice(startIdx + sm[0].length);
      const em = endRe.exec(tail);
      if (!em) break; // wait for more data
      const seq = sm[1];
      const sz  = parseInt(sm[2], 10);
      const b64Raw = tail.slice(0, em.index);
      const b64 = b64Raw.replace(/[^A-Za-z0-9+/=]/g, "");
      buf = tail.slice(em.index + em[0].length);

      try {
        const bin = atob(b64);
        if (bin.length < PIX) {
          if (frames < 5) log(`[fb-pump] frame ${seq} short: got ${bin.length} need ${PIX} (sz hdr=${sz})`);
          continue;
        }
        // Xvfb fbdir is XWD format. Pixel data is at offset (bin.length - PIX).
        // For our 160x120x24 case, bin.length is 80032 and PIX is 76800,
        // so the pixel data starts at offset 3232 (the XWD header+colormap).
        const off = bin.length - PIX;
        const img = ctx.createImageData(W, H);
        const px = img.data;
        // XWD with depth 24 / bpp 32 stores pixels as 0xAARRGGBB in
        // host byte order (typically little-endian: B, G, R, pad). Map
        // BGRA -> RGBA for the canvas.
        for (let i = 0, j = off; i < PIX; i += 4, j += 4) {
          px[i + 0] = bin.charCodeAt(j + 2); // R
          px[i + 1] = bin.charCodeAt(j + 1); // G
          px[i + 2] = bin.charCodeAt(j + 0); // B
          px[i + 3] = 255;                    // A
        }
        ctx.putImageData(img, 0, 0);
        frames++;
        if (frames <= 5 || frames % 10 === 0) {
          log(`[fb-pump] frame ${seq} (#${frames}) decoded ok`);
        }
      } catch (e) {
        if (frames < 5) log(`[fb-pump] frame ${seq} atob failed: ${e.message}`);
      }
    }
    const now = Date.now();
    if (now - lastReport > 5000) {
      log(`[fb-pump] decoded=${frames} bytesSeen=${bytesSeen} buffered=${buf.length}`);
      lastReport = now;
    }
  }

  // Wrap slave.write — the guest's TTY writes flow through here as
  // arrays of char codes (one or more bytes per call). Mirror the bytes
  // into our parser before forwarding to the original implementation.
  const slave = pty.slave;
  const orig = slave.write.bind(slave);
  slave.write = function(data) {
    if (Array.isArray(data) && data.length) {
      // String.fromCharCode.apply is fine for arrays up to ~65k.
      let s = "";
      for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
      bytesSeen += data.length;
      ingest(s);
    } else if (typeof data === "string") {
      bytesSeen += data.length;
      ingest(data);
    }
    return orig(data);
  };
  log(`[fb-pump] wrapped pty.slave.write; watching for ~~WFFB:N:SZ~~ markers`);
}

async function startBridge({ stage, log }) {
  const worker = new Worker("./bridge/worker.js", { type: "module" });
  const ready = new Promise((resolve, reject) => {
    const onMsg = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.kind === "bridge/ready") {
        worker.removeEventListener("message", onMsg);
        resolve(d);
      } else if (d.kind === "bridge/error") {
        worker.removeEventListener("message", onMsg);
        reject(new Error(d.error));
      } else if (d.kind === "bridge/log") {
        log(`[bridge] ${d.line}`);
      }
    };
    worker.addEventListener("message", onMsg);
  });

  worker.postMessage({
    kind: "bridge/init",
    zip: stage.blob,
    entries: stage.entries,
    exe: stage.exe,
  });

  try {
    const info = await ready;
    return { worker, url: info.socketUrl };
  } catch (e) {
    log(`[bridge] ${e.message} — continuing without net stack`);
    return { worker, url: "ws://localhost:9999/" }; // QEMU will fail to connect; guest just won't have net
  }
}
