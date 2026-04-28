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
  // Pre-built wineprefix as a standalone ext4 disk image, attached as
  // /dev/vdb. Splitting the prefix off the rootfs lets each MEMFS file
  // live in its own JS Uint8Array — V8 caps a single typed array around
  // ~1.9 GB on 64-bit Chrome, so the combined ~2.5 GB image we'd need
  // for a single-disk pre-extracted prefix doesn't fit, but two ~700 MB
  // arrays each fit comfortably. init.sh in the guest mounts /dev/vdb
  // and points WINEPREFIX at it, skipping the slow `tar -xzf` step.
  prefixGz:  "./assets/wine-prefix.img.gz",
  loadJS:    [
    "./assets/load-kernel.js",
    "./assets/load-initramfs.js",
    "./assets/load-rom.js",
  ],
};

function buildArgs({ appName, exe, restoreFromPath }) {
  const args = [
    "-nographic",
    "-M", "pc",
    "-m", "1024M",
    // R2 reverted again: tb-size is in MiB. With TOTAL_MEMORY=2300 MiB
    // (the wasm linear memory cap), bumping tb-size to 2000 leaves
    // only ~300 MiB for guest RAM + heap + everything else — wine
    // crashes with "memory access out of bounds" mid-init.
    //
    // R4-1 reverted: tried 768 to give the TCG cache more room for
    // wine's DLL load loop. User reported 20+ min hang on cold boot;
    // suspect transient OOM under contention with guest RAM + heap.
    // Back to the round-3 known-good 500 MiB.
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
      // R-K1 reverted: lpj=1000000 caused wine to hang at AGS init.
      // Under TCG the actual calibrated lpj is much lower than 1e6,
      // so forcing 1e6 made driver delay loops 5-10x too short and
      // broke timing-sensitive interactions (likely virtio-blk
      // or wineserver synchronization). Let kernel calibrate.
      // R-K2: skip CPU vulnerability mitigations (Spectre, Meltdown,
      // L1TF, MDS). Each mitigation runs a tiny init that costs cycles
      // under TCG; the wasm sandbox already isolates us. Saves ~1-3s.
      "mitigations=off",
      // R-K3: skip kernel ASLR. Address randomization adds startup
      // entropy work; we don't need it inside a wasm sandbox.
      "nokaslr",
      // R-K4 reverted: tsc=reliable + clocksource=tsc caused wine to
      // hang at AGS init. Under TCG TSC frequency reads aren't
      // strictly monotonic across the wasm-wrapped vCPU and wine's
      // time queries seemingly stall. Let kernel pick clocksource.
      // R-K5: trust CPU RNG. Skips waiting for entropy at boot
      // (random subsystem can stall for 5-30s under TCG without this).
      "random.trust_cpu=on",
      // R-K6: skip memory zeroing on alloc/free. We don't need the
      // security guarantee inside the wasm sandbox.
      "init_on_alloc=0",
      "init_on_free=0",
      // R-K7: turn off audit + apparmor + selinux that ship enabled
      // on Debian. None of them help us; init costs a few seconds.
      "audit=0",
      "selinux=0",
      "apparmor=0",
      // R-K8: skip kernel hung-task watchdog and softlockup detector.
      // Under TCG many tasks legitimately appear "hung" and the
      // detectors fire periodic check-ins that steal cycles.
      "nowatchdog",
      "nosoftlockup",
      // R-K9: disable IPv6 — wine and AGS only need IPv4 (and the
      // bridge worker only speaks IPv4). Skips ~1s of probing.
      "ipv6.disable=1",
      // R4-2 fully reverted: even the "safe" tweaks (transparent_hugepage,
      // printk.time) are out now. The user reported a 20-min hang and
      // we want the cleanest possible round-3 baseline to compare
      // against. Re-add one at a time only after verifying each.
    ].join(" "),
    // R-Q1: drop HPET emulation. Linux probes for it; we don't need it.
    "-no-hpet",
    // R-Q2 reverted: -rtc clock=vm broke wine init under TCG (caused
    // a hang at AGS first paint). Wine queries time via QueryPerf-
    // Counter / GetSystemTime which under wine maps to gettimeofday;
    // the VM clock didn't advance the way wine expected. Stay on
    // host wallclock.
    // R-Q3 reverted: cache=unsafe + aio=threads broke wine init in
    // the wasm QEMU build. The thread-pool AIO + skipped fsync
    // barriers seems to confuse virtio-blk under PROXY_TO_PTHREAD.
    // Default cache (writeback) + native aio is safer.
    "-drive", "id=root,file=/pack-rootfs/disk-rootfs.img,format=raw,if=none",
    "-device", "virtio-blk-pci,drive=root",
    "-drive", "id=prefix,file=/pack-prefix/wine-prefix.img,format=raw,if=none",
    "-device", "virtio-blk-pci,drive=prefix",
    "-netdev", "socket,id=vmnic,connect=localhost:8888",
    "-device", "virtio-net-pci,netdev=vmnic",
  ];
  // R7 (Path B): VirtFS is GONE permanently. virtio-9p registers an
  // unconditional migration blocker the moment it's realized, and
  // hot-unplug to remove the blocker (Path A) didn't work in this
  // wasm QEMU build — likely because we have acpi=noirq + pci=noacpi
  // in the kernel cmdline, which disables the ACPI hot-eject path
  // the guest uses to ack a device_del. Without an ack, QEMU never
  // unrealizes the device.
  //
  // Input is now forwarded over the same stdio chardev we already
  // use (master.ldisc.writeFromLower → guest /dev/console). See
  // startInputForward() and init.sh's input forwarder.
  if (restoreFromPath) {
    // Boot paused, then load a saved migration stream from MEMFS.
    // QEMU runs the VM automatically once the incoming stream finishes.
    args.push("-incoming", `file:${restoreFromPath}`);
  }
  return args;
}

// Inject a classic <script src="..."> and resolve on load. Used for the
// file_packager-generated load-*.js scripts which register FS preload
// plugins by poking a window-scoped Module object.
//
// R4-12: explicit s.async = false preserves execution order even when
// multiple scripts are appended back-to-back (which we now do in
// parallel via Promise.all). Without this, dynamically-inserted scripts
// default to async=true and execute in the order they finish
// downloading — fine in isolation but a recipe for race conditions if
// any of these load-*.js files share state.
function appendScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`load script: ${src}`));
    document.head.appendChild(s);
  });
}

// Inject bytes into QEMU's stdin via xterm-pty's line discipline. The
// older xterm-pty API exposed `master.write` directly; the current API
// expects clients to call `master.ldisc.writeFromLower([...bytes])`,
// which is the exact path xterm uses when activated as an addon. Slave
// reads pick the bytes up and emscripten's TTY surfaces them to QEMU.
function makeWriteStdin(master) {
  return (bytes) => {
    if (!master?.ldisc?.writeFromLower) return;
    let arr;
    if (typeof bytes === "string") {
      arr = new Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    } else {
      arr = Array.from(bytes);
    }
    master.ldisc.writeFromLower(arr);
  };
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
    let r;
    const preloaded = window.__wfPreload?.[sidecar];
    if (preloaded) {
      r = await preloaded;
      window.__wfPreload[sidecar] = null;
    } else {
      r = await fetch(sidecar);
    }
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
//
// R-K16: prefer a pre-flighted Response from window.__wfPreload so the
// fetch we kicked off in loader.js isn't redone here. See loader.js's
// preloadRuntimeAssets() for the producer side.
async function streamGzToFS({ url, fsPath, FS, log }) {
  log(`[runtime] GET ${url}`);

  // Fetch the sidecar size file first so we can pre-allocate the MEMFS
  // file once and avoid the 2×-doubling growth cliff.
  const finalSize = await getDecompressedSize(url).catch(() => 0);
  if (finalSize) log(`[runtime] rootfs target: ${fmt(finalSize)} (from .size sidecar)`);
  else            log(`[runtime] no .size sidecar — MEMFS may hit growth cliff`);

  let resp;
  const preloaded = window.__wfPreload?.[url];
  if (preloaded) {
    log(`[runtime] reusing preloaded fetch for ${url}`);
    try {
      resp = await preloaded;
      // Each Response can only be consumed once; null out the slot so
      // a re-call (shouldn't happen) doesn't double-await.
      window.__wfPreload[url] = null;
    } catch (e) {
      log(`[runtime] preloaded fetch failed: ${e.message || e} — refetching`);
      resp = await fetch(url);
    }
  } else {
    resp = await fetch(url);
  }
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

export async function startRuntime({ stage, appName, exe, log, terminalEl, restoreUrl }) {
  log("[runtime] loading file-packager preload scripts");

  // If we were asked to restore from a snapshot, pre-fetch its bytes
  // here so we can write them into MEMFS during preRun (before main()
  // sees the `-incoming file:…` argument).
  const RESTORE_PATH = "/pack-snap/snap.bin";
  let restoreBytes = null;
  if (restoreUrl) {
    log(`[runtime] fetching snapshot ${restoreUrl}`);
    try {
      const r = await fetch(restoreUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // R6: snapshot files are now gzipped on save. Stream-decompress
      // .gz files via DecompressionStream; uncompressed legacy `.snap`
      // files load directly.
      const isGz = restoreUrl.endsWith(".gz");
      let stream = r.body;
      if (isGz) {
        log(`[runtime] decompressing gzipped snapshot stream`);
        stream = stream.pipeThrough(new DecompressionStream("gzip"));
      }
      const ab = await new Response(stream).arrayBuffer();
      restoreBytes = new Uint8Array(ab);
      log(`[runtime] snapshot is ${(restoreBytes.length/1024/1024).toFixed(1)} MiB${isGz ? " (decompressed)" : ""}`);
    } catch (e) {
      log(`[runtime] snapshot fetch failed: ${e.message || e} — booting normally`);
      restoreBytes = null;
    }
  }

  // window.Module is what the load-*.js scripts look for.
  // We set it up before appending them.
  const Module = {
    preRun: [],
    arguments: buildArgs({ appName, exe, restoreFromPath: restoreBytes ? RESTORE_PATH : null }),
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

  // R4-12 reverted (boot-hang regression): back to serial script load
  // followed by serial bridge spin-up. Parallel was a marginal win on
  // a working boot but a possible source of subtle race conditions
  // when load-*.js scripts mutate the shared Module object.
  for (const src of ASSETS.loadJS) await appendScript(src);
  const bridge = await startBridge({ stage, log });
  Module.websocket = { url: bridge.url };

  // 2. Stream the rootfs + wineprefix images straight into MEMFS at
  // preRun time. We hold one run dependency per image so the module's
  // main() is suspended until both are written. Streams run in
  // parallel so the prefix arrives during/before the rootfs decompress
  // finishes.
  Module.preRun.push((m) => {
    try { m.FS.mkdir("/.wasmenv"); } catch {}
    m.FS.writeFile("/.wasmenv/app", JSON.stringify({ appName, exe }));

    const stream = (key, url, fsPath) => {
      m.addRunDependency(key);
      streamGzToFS({ url, fsPath, FS: m.FS, log })
        .then(() => m.removeRunDependency(key))
        .catch((e) => {
          log(`[runtime] ${key} failed: ${e.message || e}`);
          m.removeRunDependency(key);
        });
    };

    stream("rootfs-stream", ASSETS.rootfsGz, "/pack-rootfs/disk-rootfs.img");
    stream("prefix-stream", ASSETS.prefixGz, "/pack-prefix/wine-prefix.img");

    if (restoreBytes) {
      try { m.FS.mkdir("/pack-snap"); } catch {}
      m.FS.writeFile(RESTORE_PATH, restoreBytes);
      log(`[runtime] preloaded snapshot at ${RESTORE_PATH}`);
    }
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

  // 6. Input forwarding — canvas mouse/key events flow as text lines
  // ("MV X Y", "DOWN btn", etc.) over the stdio chardev (= QEMU's
  // serial in mux mode) into the guest's /dev/console, where init.sh's
  // input forwarder reads them and dispatches via xdotool. Same path
  // we use for monitor commands during snapshot save.
  const writeStdin = makeWriteStdin(master);
  startInputForward(Module, log, writeStdin);

  // 7. Snapshot save/load wiring.
  wireSnapshotButtons({ Module, master, slave, appName, log, writeStdin });

  return { instance, bridge };
}

// QEMU snapshot via the HMP monitor.
//
// `-nographic` puts the monitor on the same stdio chardev as the serial
// console, multiplexed: Ctrl-A,c switches between them. We send commands
// by writing to the xterm-pty's `master` (which is QEMU's stdin), and
// briefly suspend the framebuffer pump so its output doesn't flood the
// pty while we're talking to the monitor.
//
// The actual snapshot is produced by `migrate "exec:cat > /tmp/snap.bin"`
// — this writes a full QEMU migration stream (guest RAM + device state)
// to a file in the guest, which the host can read via 9P.
//
// IMPORTANT CAVEAT: this approach is unproven on this wasm QEMU build.
// `--without-default-features` strips a lot — `migrate exec:` requires
// fork+exec which our wasm process can't do. If exec: fails, we'll fall
// back to `migrate "fd:N"` over a chardev pipe, or to the OPFS-backed
// disk-only path. Watch the snap-status text + console for the actual
// failure mode the first time it's tried.
function wireSnapshotButtons({ Module, master, slave, appName, log, writeStdin }) {
  const FS = Module.FS;
  const SAVE_PATH_GUEST = "/tmp/snap.bin";          // path inside guest
  const saveBtn   = document.querySelector("#snap-save");
  const loadBtn   = document.querySelector("#snap-load");
  const statusEl  = document.querySelector("#snap-status");
  if (!saveBtn || !loadBtn || !statusEl) return;

  const setStatus = (text, kind = "") => {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
  };

  // sendStdin is the snapshot-flow alias for the shared writeStdin —
  // makes the older snapshot code easier to read.
  const sendStdin = writeStdin;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Sniff QEMU's output for a marker (e.g., "(qemu)" prompt or
  // "Migration complete"). We add a temporary tap on slave.write.
  const waitForMonitorMarker = (markers, timeoutMs) => new Promise((resolve, reject) => {
    let buffer = "";
    let done = false;
    const orig = slave.write.bind(slave);
    const teardown = () => { slave.write = orig; };
    const timer = setTimeout(() => {
      if (done) return; done = true; teardown();
      reject(new Error(`timeout waiting for ${markers.join(" / ")}`));
    }, timeoutMs);
    slave.write = function (data) {
      const ret = orig(data);
      if (done) return ret;
      // Mirror the original tap path: array of char codes or string
      let s = "";
      if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
      } else if (typeof data === "string") s = data;
      buffer += s;
      if (buffer.length > 8192) buffer = buffer.slice(-4096);
      for (const m of markers) {
        if (buffer.includes(m)) {
          done = true; clearTimeout(timer); teardown();
          resolve({ marker: m, buffer });
          break;
        }
      }
      return ret;
    };
  });

  // Tap slave.write for the duration of a snapshot. Returns a getter
  // for the captured bytes-as-string so the caller can show / log
  // whatever QEMU echoed during the migrate flow. Kept separate from
  // waitForMonitorMarker because that one rebinds slave.write per call,
  // tearing down on first marker; we want a long-lived tap during the
  // entire migrate, with the option to log the whole transcript.
  //
  // CRITICAL: in `-nographic` (= `-serial mon:stdio`) mode, the guest's
  // serial output and the monitor's responses share one stdio chardev
  // and BOTH arrive at slave.write. Toggling Ctrl-A,c only changes
  // which frontend receives our STDIN bytes — it does not stop the
  // guest from emitting serial output. Our fb-pump in the guest writes
  // 410 KB of base64 every few seconds, which would otherwise drown
  // tiny monitor responses (a "(qemu)" prompt is 7 bytes; "QEMU 8.2.0
  // …" is ~50 bytes). We strip fb-pump's framed chunks from the tap
  // buffer so the monitor signal survives.
  function tapMonitorOutput() {
    let buf = "";
    const orig = slave.write.bind(slave);
    slave.write = function (data) {
      const ret = orig(data);
      let s = "";
      if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
      } else if (typeof data === "string") s = data;
      buf += s;
      // 1) Strip complete fb-pump frames in one pass (fast path).
      let prev = -1;
      while (prev !== buf.length) {
        prev = buf.length;
        buf = buf.replace(/~~WFFB:\d+:\d+~~[\s\S]*?~~ENDWFFB:\d+~~\n?/g, "");
      }
      // 2) Defensive: any run of 200+ consecutive base64 chars is an
      //    fb-pump frame body (complete or partial). Monitor responses
      //    don't have runs that long; "QEMU 8.2.0 monitor - type help"
      //    has spaces / punctuation throughout.
      buf = buf.replace(/[A-Za-z0-9+/=]{200,}/g, "");
      // 3) Strip orphan markers left over from partial frames that got
      //    cut by step 2.
      buf = buf.replace(/~~WFFB:\d+:\d+~~/g, "");
      buf = buf.replace(/~~ENDWFFB:\d+~~\n?/g, "");
      if (buf.length > 65536) buf = buf.slice(-32768);
      return ret;
    };
    return {
      get text() { return buf; },
      contains(needle) { return buf.includes(needle); },
      clear() { buf = ""; },
      stop() { slave.write = orig; },
    };
  }

  async function saveSnapshot() {
    saveBtn.disabled = true;
    loadBtn.disabled = true;
    setStatus("entering monitor…", "busy");
    // Tell startInputForward to swallow canvas mouse/key events for
    // the duration of the snapshot. Without this, a stray click while
    // the mux is on the monitor side would type "MV X Y\n" at the
    // monitor prompt and clutter the transcript with "unknown command"
    // errors.
    window.__wfSnapshotInProgress = true;

    // Long-lived tap so we can show whatever QEMU said if anything fails.
    const tap = tapMonitorOutput();
    const lastFew = (n = 200) => tap.text.slice(-n).replace(/\s+/g, " ").trim();

    // The HMP "(qemu) " prompt is the most reliable monitor-presence
    // signal. HMP's `info version` response is just the version
    // number (`8.2.0\n`), without a "QEMU" prefix — that prefix only
    // appears in the *welcome* banner shown when entering the monitor.
    // So we look for the prompt OR the version string, not "QEMU".
    const inMonitor = (s) =>
      /\(qemu\)/.test(s) || /\b\d+\.\d+\.\d+\b/.test(s);

    try {
      // 1. Probe the monitor with `info version` BEFORE toggling, in case
      //    we're already there. We strip ANSI line-editing escapes
      //    ([K = erase to EOL, [D = cursor left) before the regex —
      //    HMP's readline-style echo writes our typed line with cursor
      //    redraws, which would otherwise confuse simple regex matches.
      tap.clear();
      sendStdin("info version\n");
      await sleep(500);
      const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      const beforeProbe = stripAnsi(lastFew(500));
      const inMonitorAlready = inMonitor(beforeProbe);
      log(`[snap] mux probe (no toggle): ${beforeProbe || "(no echo)"}`);

      // 2. If we don't already see a monitor-flavoured response, switch
      //    via Ctrl-A,c. Send the two bytes separately (with a small
      //    gap) so even mux implementations that read a byte at a time
      //    process the prefix before the command char.
      if (!inMonitorAlready) {
        tap.clear();
        setStatus("entering monitor (Ctrl-A,c)…", "busy");
        sendStdin("\x01");
        await sleep(50);
        sendStdin("c");
        await sleep(50);
        sendStdin("\n"); // newline forces the prompt to redraw on most builds
        // Wait up to 3 s for the welcome banner ("QEMU x.x.x …") OR
        // the "(qemu)" prompt to appear.
        let sawPrompt = false;
        for (let i = 0; i < 30; i++) {
          const txt = stripAnsi(tap.text);
          if (/\(qemu\)/.test(txt) || /QEMU\s+\d+\.\d+\.\d+/.test(txt)) {
            sawPrompt = true; break;
          }
          await sleep(100);
        }
        log(`[snap] after Ctrl-A,c: ${stripAnsi(lastFew(300))}`);
        if (!sawPrompt) {
          log(`[snap] WARNING: never saw "(qemu)" prompt — Ctrl-A,c may not toggle the mux in this wasm QEMU build. Continuing anyway.`);
        }
      } else {
        log(`[snap] already in monitor — skipping Ctrl-A,c`);
      }

      // 3. Re-probe with `info version` to confirm bytes reach the
      //    monitor. The response is `<version>\n` followed by a fresh
      //    `(qemu) ` prompt — either is sufficient evidence.
      tap.clear();
      sendStdin("info version\n");
      await sleep(500);
      const probe2 = stripAnsi(lastFew(500));
      log(`[snap] post-toggle probe: ${probe2 || "(no echo)"}`);
      if (!inMonitor(probe2)) {
        setStatus("monitor unreachable — see log", "err");
        log(`[snap] FAIL: no "(qemu)" prompt or version number after "info version". Bytes are reaching the guest serial, not the monitor. Tap captured: ${tap.text.length} bytes`);
        return;
      }

      // 4. Pause the VM so the snapshot is consistent.
      setStatus("pausing VM…", "busy");
      tap.clear();
      sendStdin("stop\n");
      await sleep(300);
      log(`[snap] after stop: ${lastFew(200)}`);

      // 5. Migrate to a host-side MEMFS path. We use QEMU's own MEMFS
      //    (`/pack-snap/snap.bin`), which is QEMU-process-local.
      //    Note: in path B (R7) there's no -virtfs, so the migration
      //    blocker that thwarted earlier attempts is gone.
      try { FS.mkdir("/pack-snap"); } catch {}
      const HOST_PACK = "/pack-snap/snap.bin";
      try { FS.unlink(HOST_PACK); } catch {}

      // Try a few migrate variants in order — QEMU's HMP parser has
      // accepted slightly different syntaxes across versions, and this
      // wasm build is `--without-default-features` so some backends
      // are stripped.
      const variants = [
        `migrate -d file:${HOST_PACK}`,
        `migrate file:${HOST_PACK}`,
        `migrate "file:${HOST_PACK}"`,
      ];
      let lastSize = 0;
      let usedVariant = "";
      for (const cmd of variants) {
        try { FS.unlink(HOST_PACK); } catch {}
        setStatus(`running ${cmd}…`, "busy");
        tap.clear();
        sendStdin(cmd + "\n");
        let sawError = false;
        let prev = -1, stable = 0;
        for (let i = 0; i < 30; i++) { // 15 s per variant
          let sz = 0;
          try { sz = FS.stat(HOST_PACK).size; } catch {}
          if (sz > 0) {
            setStatus(`migrating: ${(sz/1024/1024).toFixed(1)} MB`, "busy");
            if (sz === prev) stable++; else { prev = sz; stable = 0; }
            if (stable >= 6) { lastSize = sz; usedVariant = cmd; break; }
          } else {
            const t = tap.text;
            if (t.includes("unknown command") || t.includes("Unknown command")
                || t.includes("Migration failed") || t.includes("error:")) {
              sawError = true;
              log(`[snap] variant "${cmd}" rejected: ${lastFew(300)}`);
              break;
            }
            if (i % 4 === 0) {
              const tail = lastFew(120);
              if (tail) setStatus(`waiting (${tail})`, "busy");
            }
          }
          await sleep(500);
        }
        if (lastSize > 0) break;
        if (!sawError) {
          log(`[snap] variant "${cmd}" produced 0 bytes after 15 s — trying next`);
        }
      }
      if (lastSize === 0) {
        const tail = lastFew(800);
        setStatus(`migrate failed — see log`, "err");
        log(`[snap] all migrate variants failed. Last 800 bytes of monitor transcript:`);
        log(`[snap]   ${tail || "(empty — monitor returned nothing)"}`);
        log(`[snap] If you see no "QEMU 8.2.0" anywhere in this session, Ctrl-A,c isn't toggling the mux. If you see the version but no migrate output, "migrate file:" probably isn't compiled into this wasm QEMU build (--without-default-features strips many backends).`);
        // Attempt to leave the VM in a runnable state.
        try { sendStdin("cont\n"); sendStdin("\x01c"); } catch {}
        return;
      }

      setStatus(`packing ${(lastSize/1024/1024).toFixed(1)} MB…`, "busy");
      log(`[snap] success via "${usedVariant}" — ${lastSize} bytes`);
      const snapBytes = FS.readFile(HOST_PACK);

      // 6. Resume the VM and switch monitor back to serial so frames
      //    flow to xterm again. (Note: input via 9P is dead now since
      //    we device_del'd the VirtFS share. The user can keep watching
      //    but can't interact. Reload to load the snapshot for full
      //    play.)
      sendStdin("cont\n");
      await sleep(100);
      sendStdin("\x01c");

      // 7. Compress with gzip via DecompressionStream's twin. QEMU
      //    migration files have a lot of structural redundancy and
      //    typically compress 2-3x. A 200 MiB raw snapshot lands at
      //    ~70 MiB compressed.
      setStatus(`compressing…`, "busy");
      const t0 = Date.now();
      const compressedBuffer = await new Response(
        new Blob([snapBytes]).stream().pipeThrough(new CompressionStream("gzip"))
      ).arrayBuffer();
      const compressedSize = compressedBuffer.byteLength;
      log(`[snap] gzip: ${lastSize} → ${compressedSize} bytes `
          + `(${((compressedSize / lastSize) * 100).toFixed(0)}%) in ${Date.now() - t0} ms`);

      // 8. Trigger browser download.
      const blob = new Blob([compressedBuffer], { type: "application/gzip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `wineframe-${appName}.snap.gz`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      // 9. Free the MEMFS copy of the snapshot — keeping it tied up
      //    ~200 MB of MEMFS that nothing else uses.
      try { FS.unlink(HOST_PACK); } catch {}

      setStatus(`saved ${(compressedSize/1024/1024).toFixed(1)} MB (raw ${(lastSize/1024/1024).toFixed(1)} MB)`, "ok");
      log(`[snap] saved → wineframe-${appName}.snap.gz (${compressedSize} bytes gz, ${lastSize} bytes raw)`);
      log(`[snap] NOTE: input via 9P is dead in this session (we device_del'd VirtFS to allow migrate). Reload the page and use Load Snapshot to restore + resume with input working.`);
    } catch (e) {
      setStatus(`save failed: ${e.message || e}`, "err");
      log(`[snap] save failed: ${e.message || e}`);
      // Best-effort: try to leave VM running and back on the serial mux.
      try { sendStdin("cont\n"); sendStdin("\x01c"); } catch {}
    } finally {
      // CRITICAL: release the slave.write override so fb-pump's tap and
      // the xterm display see traffic again. Without this we'd silently
      // leak the closure on every snapshot attempt.
      try { tap.stop(); } catch {}
      window.__wfSnapshotInProgress = false;
      saveBtn.disabled = false;
      loadBtn.disabled = false;
    }
  }

  async function loadSnapshot() {
    saveBtn.disabled = true;
    loadBtn.disabled = true;
    setStatus("checking snapshot…", "busy");
    try {
      // Convention: place the snapshot file at site/assets/<app>.snap.gz
      // (preferred — that's what Save Snapshot now produces) or the
      // legacy uncompressed `.snap`. On click we set a sessionStorage
      // flag and reload — the new page run will pick up the snapshot
      // before QEMU starts and add `-incoming` to its args.
      const candidates = [
        `./assets/${appName}.snap.gz`,
        `./assets/${appName}.snap`,
      ];
      let url = null;
      let sz = 0;
      for (const c of candidates) {
        const head = await fetch(c, { method: "HEAD" }).catch(() => null);
        if (head && head.ok) {
          url = c;
          sz = Number(head.headers.get("Content-Length") || 0);
          break;
        }
      }
      if (!url) {
        setStatus(`no snapshot found`, "err");
        log(`[snap] no snapshot at ${candidates.join(" or ")} — Save Snapshot first, then drop the file into site/assets/`);
        return;
      }
      sessionStorage.setItem("wf-restore-from", url);
      setStatus(`reloading with snapshot (${(sz/1024/1024).toFixed(1)} MB)…`, "busy");
      log(`[snap] restoring from ${url} on next boot`);
      // Reload the page; loader.js / runtime.js will detect the flag and
      // pre-load the snapshot into MEMFS + add `-incoming` to QEMU args.
      setTimeout(() => location.reload(), 400);
    } catch (e) {
      setStatus(`load failed: ${e.message || e}`, "err");
      log(`[snap] load failed: ${e.message || e}`);
    } finally {
      saveBtn.disabled = false;
      loadBtn.disabled = false;
    }
  }

  saveBtn.addEventListener("click", saveSnapshot);
  loadBtn.addEventListener("click", loadSnapshot);

  // Expose for console debugging.
  window.__wfSnap = { saveSnapshot, loadSnapshot, sendStdin };
}

function startInputForward(Module, log, writeStdin) {
  const canvas = document.querySelector("#fb");
  if (!canvas) return;

  // R7: input is now sent over QEMU's stdio (= /dev/console in the
  // guest) instead of via 9P file polling. Same lines as before
  // (`MV X Y\n`, `DOWN btn\n`, `UP btn\n`, `KEY name\n`); init.sh's
  // input forwarder reads them with a blocking `read line` loop on
  // /dev/console and dispatches via xdotool. Switching transports
  // lets us drop -virtfs entirely, which lifts QEMU's hard-coded
  // migration blocker — without this Save Snapshot can't migrate.
  let writeQueue = "";
  let flushTimer = null;
  let totalBytes = 0;
  let totalEvents = 0;
  let firstDownLogged = false;
  let firstKeyLogged = false;
  // Tracked virtual cursor — the position the D-pad is "holding" between
  // canvas clicks. Initialised to the canvas centre.
  let cursorX = Math.floor(canvas.width / 2);
  let cursorY = Math.floor(canvas.height / 2);

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 30);
  }
  function flush() {
    flushTimer = null;
    if (!writeQueue) return;
    // Don't shove input bytes at QEMU while a snapshot save is mid-
    // flight — the mux is on the monitor side then, and our event
    // lines would be parsed as monitor commands.
    if (window.__wfSnapshotInProgress) {
      writeQueue = "";
      return;
    }
    if (typeof writeStdin === "function") {
      try {
        writeStdin(writeQueue);
        totalBytes += writeQueue.length;
        totalEvents += writeQueue.split("\n").length - 1;
      } catch (e) {
        if (totalEvents < 3) log(`[input] writeStdin failed: ${e.message || e}`);
      }
    }
    writeQueue = "";
  }

  function canvasCoord(e) {
    const r = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(canvas.width - 1,
      Math.floor((e.clientX - r.left) * canvas.width / r.width)));
    const y = Math.max(0, Math.min(canvas.height - 1,
      Math.floor((e.clientY - r.top) * canvas.height / r.height)));
    return [x, y];
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Emit MV to the current (cursorX, cursorY). Used by both the canvas
  // click handler (which sets the cursor first) and the D-pad arrows.
  function emitMove() {
    writeQueue += `MV ${cursorX} ${cursorY}\n`;
    scheduleFlush();
    updateIndicator();
  }
  function emitClick(btn) {
    if (!firstDownLogged) {
      firstDownLogged = true;
      log(`[input] first click btn=${btn} at (${cursorX},${cursorY})`);
    }
    writeQueue += `MV ${cursorX} ${cursorY}\nDOWN ${btn}\nUP ${btn}\n`;
    scheduleFlush();
    updateIndicator();
  }

  // Visual cursor indicator — a CSS-positioned arrow on top of the
  // canvas so the user sees a cursor that follows their input. Xvfb
  // doesn't render the X server cursor into its framebuffer (cursors
  // are server-side via XFixes), and AGS' title screen draws no
  // cursor sprite, so without this overlay the user has no visual
  // feedback even though the X cursor IS being moved underneath. This
  // overlay IS the visible cursor; the actual click target inside the
  // emulator follows it 1:1.
  let indicator = null;
  function ensureIndicator() {
    if (indicator) return;
    const screen = canvas.parentElement;
    if (!screen) return;
    indicator = document.createElement("div");
    indicator.id = "wf-cursor";
    // SVG arrow — matches the standard X11 / Win32 default cursor shape
    // so it reads as a cursor rather than a generic marker.
    // Bright yellow fill + thick black outline so it stays readable on
    // any background and is unmistakable vs. the OS browser cursor.
    indicator.innerHTML = '<svg viewBox="0 0 16 16" width="18" height="18">' +
      '<path d="M2 2 L2 13 L5.5 10 L8 14 L10 13 L7.5 9 L12 9 Z" ' +
      'fill="#ffd84a" stroke="#000000" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    screen.appendChild(indicator);
  }
  function updateIndicator() {
    ensureIndicator();
    if (!indicator) return;
    const r = canvas.getBoundingClientRect();
    const sr = canvas.parentElement.getBoundingClientRect();
    const px = (r.left - sr.left) + cursorX * (r.width / canvas.width);
    const py = (r.top  - sr.top ) + cursorY * (r.height / canvas.height);
    indicator.style.left = `${px}px`;
    indicator.style.top  = `${py}px`;
  }

  canvas.addEventListener("mousedown", (e) => {
    const [x, y] = canvasCoord(e);
    cursorX = x; cursorY = y;
    emitClick(e.button + 1);
    e.preventDefault();
  });
  // mouseup is intentionally unused — emitClick already issues DOWN+UP.
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // D-pad: 4 direction buttons + a click button. Each direction nudges
  // the tracked cursor by `step` px; holding repeats every 80 ms.
  const dpad = document.querySelector("#dpad");
  if (dpad) {
    const STEP = 8;
    const nudge = (dx, dy) => {
      cursorX = clamp(cursorX + dx, 0, canvas.width  - 1);
      cursorY = clamp(cursorY + dy, 0, canvas.height - 1);
      emitMove();
    };
    const dirs = {
      "up":    [ 0, -STEP],
      "down":  [ 0,  STEP],
      "left":  [-STEP, 0],
      "right": [ STEP, 0],
    };
    for (const btn of dpad.querySelectorAll("[data-dir]")) {
      const dir = btn.dataset.dir;
      let timer = null;
      const start = (e) => {
        e.preventDefault();
        if (dir === "click") { emitClick(1); return; }
        if (!dirs[dir]) return;
        nudge(...dirs[dir]);
        // Hold-to-repeat after a short delay
        timer = setTimeout(function rep() {
          if (!dirs[dir]) return;
          nudge(...dirs[dir]);
          timer = setTimeout(rep, 80);
        }, 200);
      };
      const stop = (e) => { e?.preventDefault?.(); if (timer) { clearTimeout(timer); timer = null; } };
      btn.addEventListener("mousedown", start);
      btn.addEventListener("touchstart", start, { passive: false });
      btn.addEventListener("mouseup", stop);
      btn.addEventListener("mouseleave", stop);
      btn.addEventListener("touchend", stop);
      btn.addEventListener("touchcancel", stop);
    }
    // Place the indicator at the initial centre.
    setTimeout(updateIndicator, 0);
  }

  // Make the canvas grab focus on click so keys go to it.
  // Hide the OS cursor over the canvas — the yellow arrow overlay IS
  // the visible cursor, and showing both side-by-side is confusing.
  canvas.tabIndex = 0;
  canvas.style.cursor = "none";
  canvas.style.outline = "none";

  canvas.addEventListener("keydown", (e) => {
    // Map common keys to xdotool key names
    const map = {
      "Enter": "Return", "Escape": "Escape", "Tab": "Tab",
      "Backspace": "BackSpace", " ": "space",
      "ArrowUp": "Up", "ArrowDown": "Down",
      "ArrowLeft": "Left", "ArrowRight": "Right",
    };
    const k = map[e.key] || e.key;
    if (k.length > 0) {
      if (!firstKeyLogged) {
        firstKeyLogged = true;
        log(`[input] first keydown key=${k}`);
      }
      writeQueue += `KEY ${k}\n`;
      scheduleFlush();
    }
    e.preventDefault();
  });

  log("[input] click-only mouse + keyboard + D-pad → /.wasmenv/wf-input.txt");
  window.__wfInput = {
    get queueLen() { return writeQueue.length; },
    get totalBytes() { return totalBytes; },
    get totalEvents() { return totalEvents; },
    get cursor() { return [cursorX, cursorY]; },
    nudge(dx, dy) { cursorX = clamp(cursorX + dx, 0, canvas.width - 1);
                    cursorY = clamp(cursorY + dy, 0, canvas.height - 1);
                    emitMove(); },
    click(btn = 1) { emitClick(btn); },
  };
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
      // R-K22: build the string via fromCharCode in chunks of 16 K so
      // V8 can fast-path each chunk. The original char-by-char concat
      // was O(N²) in V8's slow string concat path for the ~410 KB
      // base64 frame body bursts.
      const arr = data;
      const len = arr.length;
      let s = "";
      for (let off = 0; off < len; off += 16384) {
        const sliceEnd = Math.min(off + 16384, len);
        s += String.fromCharCode.apply(null, arr.slice(off, sliceEnd));
      }
      bytesSeen += len;
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
