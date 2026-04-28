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
    // crashes with "memory access out of bounds" mid-init. 500 MiB
    // cache fits comfortably and was the original choice for this
    // reason.
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
    "-virtfs", "local,path=/.wasmenv,mount_tag=wasm0,security_model=mapped-file,id=wasm0",
    "-netdev", "socket,id=vmnic,connect=localhost:8888",
    "-device", "virtio-net-pci,netdev=vmnic",
  ];
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
      restoreBytes = new Uint8Array(await r.arrayBuffer());
      log(`[runtime] snapshot is ${(restoreBytes.length/1024/1024).toFixed(1)} MiB`);
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

  for (const src of ASSETS.loadJS) await appendScript(src);

  // 1. Start the bridge worker (stub — will hand off once bridge.wasm
  // transport is wired).
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

  // 6. Input forwarding — canvas mouse/key events get appended as text
  // lines to /.wasmenv/wf-input.txt (which the guest sees over 9P at
  // /var/host/wf-input.txt). A daemon there reads new lines and replays
  // them via xdotool to the X server.
  startInputForward(Module, log);

  // 7. Snapshot save/load wiring.
  wireSnapshotButtons({ Module, master, slave, appName, log });

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
function wireSnapshotButtons({ Module, master, slave, appName, log }) {
  const FS = Module.FS;
  const SAVE_PATH_GUEST = "/tmp/snap.bin";          // path inside guest
  const SAVE_PATH_HOST  = "/.wasmenv/snap.bin";     // path in MEMFS (9P share)
  const saveBtn   = document.querySelector("#snap-save");
  const loadBtn   = document.querySelector("#snap-load");
  const statusEl  = document.querySelector("#snap-status");
  if (!saveBtn || !loadBtn || !statusEl) return;

  const setStatus = (text, kind = "") => {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
  };

  // Send raw bytes to QEMU's stdin (= the pty master's input side).
  // master is the xterm-pty Master; calling `write` on it injects bytes
  // as if a user had typed them, which Emscripten's TTY then surfaces
  // to QEMU on stdin.
  const sendStdin = (bytes) => {
    if (!master) return;
    if (typeof bytes === "string") {
      const arr = new Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      master.write(arr);
    } else {
      master.write(Array.from(bytes));
    }
  };
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

  async function saveSnapshot() {
    saveBtn.disabled = true;
    loadBtn.disabled = true;
    setStatus("entering monitor…", "busy");

    try {
      // 1. Switch to monitor (Ctrl-A, c). After this, fb-pump's serial
      //    writes are queued by QEMU until we switch back, so they
      //    won't corrupt monitor output.
      sendStdin("\x01c");
      // The monitor prints "(qemu) " when ready.
      try { await waitForMonitorMarker(["(qemu)"], 3000); }
      catch { /* maybe already in monitor — keep going */ }

      // 2. Stop the VM so the snapshot is consistent.
      setStatus("pausing VM…", "busy");
      sendStdin("stop\n");
      await sleep(150);

      // 3. Make sure /tmp/snap.bin doesn't exist on the host MEMFS,
      //    so we can detect when migrate finishes by polling its size.
      try { FS.unlink(SAVE_PATH_HOST); } catch {}

      // 4. Migrate to a file. Try `file:` first (file backend), fall
      //    back to `exec:` if that's not in this build.
      // The guest writes to /tmp/snap.bin which is guest-local (NOT
      //    9P-shared by default), so we need to write to a 9P-shared
      //    path. /var/host/* on the guest is 9P-mapped to /.wasmenv/*
      //    on the host. So have the guest write into /var/host/snap.bin,
      //    which appears on the host at /.wasmenv/snap.bin.
      // BUT init.sh notes "9P writes are broken in this qemu-wasm
      //    build" — so guest-side writes via 9P won't propagate to the
      //    host MEMFS. Workaround: write the migrate stream to the
      //    guest's /tmp/snap.bin first, and accept that we can't read
      //    it back without a working 9P write path.
      //
      // For the actual MVP, we tell QEMU to write directly to a host
      // path via the `file:` URI. Since the host filesystem visible to
      // QEMU is its own MEMFS, /pack-snap/snap.bin resolves to MEMFS.
      try { FS.mkdir("/pack-snap"); } catch {}
      const HOST_PACK = "/pack-snap/snap.bin";
      try { FS.unlink(HOST_PACK); } catch {}

      setStatus("running migrate…", "busy");
      sendStdin(`migrate "file:${HOST_PACK}"\n`);

      // 5. Poll the host MEMFS file size — when it stops growing for
      //    a few ticks, migrate is done.
      let prev = -1, stable = 0, lastSize = 0;
      for (let i = 0; i < 600; i++) {  // up to ~5 min
        let sz = 0;
        try { sz = FS.stat(HOST_PACK).size; } catch {}
        if (sz > 0) {
          setStatus(`migrating: ${(sz/1024/1024).toFixed(1)} MB`, "busy");
          if (sz === prev) stable++; else { prev = sz; stable = 0; }
          if (stable >= 6) { lastSize = sz; break; }
        }
        await sleep(500);
      }
      if (lastSize === 0) {
        // No bytes appeared — migrate file: backend probably not in this
        // build. Surface the QEMU error log.
        setStatus("migrate produced 0 bytes — see console", "err");
        log("[snap] migrate \"file:…\" returned no data. The wasm QEMU build may not support the file: URI. Check the xterm for monitor errors.");
        // Attempt to leave the VM in a runnable state.
        sendStdin("cont\n");
        sendStdin("\x01c");  // back to serial
        return;
      }

      setStatus(`packing ${(lastSize/1024/1024).toFixed(1)} MB…`, "busy");
      const snapBytes = FS.readFile(HOST_PACK);

      // 6. Resume the VM and switch monitor back to serial so frames
      //    flow to xterm again.
      sendStdin("cont\n");
      await sleep(100);
      sendStdin("\x01c");

      // 7. Trigger browser download.
      const blob = new Blob([snapBytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `wineframe-${appName}.snap`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setStatus(`saved (${(lastSize/1024/1024).toFixed(1)} MB)`, "ok");
      log(`[snap] saved ${lastSize} bytes → wineframe-${appName}.snap`);
    } catch (e) {
      setStatus(`save failed: ${e.message || e}`, "err");
      log(`[snap] save failed: ${e.message || e}`);
      // Best-effort: try to leave VM running and back on the serial mux.
      try { sendStdin("cont\n"); sendStdin("\x01c"); } catch {}
    } finally {
      saveBtn.disabled = false;
      loadBtn.disabled = false;
    }
  }

  async function loadSnapshot() {
    saveBtn.disabled = true;
    loadBtn.disabled = true;
    setStatus("checking snapshot…", "busy");
    try {
      // Convention: place the snapshot file at site/assets/<app>.snap
      // (i.e., served at ./assets/<app>.snap). On click we set a
      // sessionStorage flag and reload — the new page run will pick up
      // the snapshot before QEMU starts and add `-incoming` to its args.
      const url = `./assets/${appName}.snap`;
      const head = await fetch(url, { method: "HEAD" }).catch(() => null);
      if (!head || !head.ok) {
        setStatus(`no snapshot at ${url}`, "err");
        log(`[snap] no snapshot at ${url} — Save Snapshot first, then drop the file into site/assets/`);
        return;
      }
      const sz = Number(head.headers.get("Content-Length") || 0);
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

function startInputForward(Module, log) {
  const canvas = document.querySelector("#fb");
  if (!canvas) return;
  const FS = Module.FS;
  const PATH = "/.wasmenv/wf-input.txt";

  // Create the file fresh so the guest daemon's "skip already-read
  // bytes" counter starts at 0.
  try { FS.writeFile(PATH, ""); } catch (e) {
    log(`[input] could not create ${PATH}: ${e.message || e}`);
    return;
  }

  // Open once for append-style writes
  let stream;
  try { stream = FS.open(PATH, "a"); }
  catch (e) {
    log(`[input] could not open ${PATH} for append: ${e.message || e}`);
    return;
  }

  // Continuous mousemove tracking is intentionally OFF: every mousemove
  // would write to MEMFS and the guest's 200 ms poll would chase each
  // event through xdotool, eating CPU that the wine guest could be
  // using to boot. Instead we send only on click (snap-and-tap) plus
  // explicit nudges from the on-page D-pad.
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
  const enc = new TextEncoder();

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 30);
  }
  function flush() {
    flushTimer = null;
    if (!writeQueue) return;
    const bytes = enc.encode(writeQueue);
    try {
      const sz = FS.stat(PATH).size;
      // Use FS.write at end-of-file offset for explicit append
      FS.write(stream, bytes, 0, bytes.length, sz);
      totalBytes += bytes.length;
      totalEvents += writeQueue.split("\n").length - 1;
    } catch (e) {
      // Re-open if stream went stale
      try {
        FS.close(stream);
      } catch {}
      try { stream = FS.open(PATH, "a"); } catch {}
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
