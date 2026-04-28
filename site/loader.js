// wineframe loader — boxedwine-style URL UX for QEMU-wasm.
//
// Flow:
//   1. Parse ?app=<name>&p=<Game.exe> (or show launcher).
//   2. Fetch games/<name>.zip (or accept a dropped file).
//   3. Stage the zip for the 9P/zip mount bridge.
//   4. Boot QEMU-wasm with the Alpine+Wine64 base image.
//   5. Guest mounts /mnt/app (zip), /home (OPFS), runs `wine64 /mnt/app/<p>`.
//
// Heavy guest artifacts (qemu.wasm, base-image.img.gz) are produced by the
// Docker build pipeline and dropped under ./assets/. Until those exist the
// loader still renders the shell, validates the zip, and reports what's
// missing — so we can iterate the UX independently.

const $ = (sel) => document.querySelector(sel);
const screens = {
  launcher: $("#launcher"),
  runner:   $("#runner"),
  crash:    $("#crash"),
};

const status = (text, kind = "idle") => {
  const el = $("#status");
  el.textContent = text;
  el.dataset.kind = kind;
};

const show = (name) => {
  for (const [key, el] of Object.entries(screens)) {
    el.hidden = key !== name;
  }
};

// K12: boot progress overlay state.
//
// Stages and the log-line patterns we use to advance through them:
//
//   download    "[runtime] ./assets/...  N MiB / TOTAL MiB"  → progress %
//   decompress  "[runtime] wrote N MiB of rootfs to MEMFS"   → progress %
//   kernel      "[wineframe] runtime assets OK — starting guest"
//                 then "[wf] booted Linux ..."
//   wine        "[wf] launching wine explorer ..."
//   game        first decoded fb-pump frame (window.__wfFb.frames > 0)
//
// Once the canvas has actual content, the overlay hides itself.
const bootOverlay = {
  el:       $("#boot-overlay"),
  stageEl:  $("#bo-stage"),
  fillEl:   $("#bo-fill"),
  detailEl: $("#bo-detail"),
  stage: "init",
  hidden: true,
  show() { this.el.hidden = false; this.hidden = false; },
  hide() { this.el.hidden = true; this.hidden = true; },
  set(stage, label, pct, detail) {
    this.stage = stage;
    this.stageEl.textContent = label;
    if (pct === null || pct === undefined) {
      this.fillEl.classList.add("indeterminate");
      this.fillEl.style.width = "32%";
    } else {
      this.fillEl.classList.remove("indeterminate");
      this.fillEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    }
    if (detail !== undefined) this.detailEl.textContent = detail;
  },
  // Drive the overlay from a single log line.
  consume(line) {
    if (this.hidden) return;
    let m;
    // Asset download: "[runtime] ./assets/foo.gz  123 MiB / 456 MiB"
    if ((m = line.match(/\[runtime\] \.\/assets\/[^ ]+\s+([\d.]+) MiB \/ ([\d.]+) MiB/))) {
      const cur = parseFloat(m[1]), tot = parseFloat(m[2]);
      this.set("download", "Downloading runtime…", (cur / tot) * 100,
               `${m[1]} / ${m[2]} MiB`);
      return;
    }
    // MEMFS write progress
    if ((m = line.match(/\[runtime\] wrote ([\d.]+) MiB of rootfs to MEMFS/))) {
      // The total is logged separately ("rootfs target: N MiB"). We
      // treat MEMFS writes as the same progress bar — by then download
      // is also tracked.
      this.set("decompress", "Decompressing into MEMFS…", null,
               `${m[1]} MiB written`);
      return;
    }
    if (line.includes("rootfs in MEMFS:")) {
      this.set("kernel", "Booting Linux…", null, "kernel + initramfs");
      return;
    }
    if (line.includes("[wf] booted Linux")) {
      this.set("init", "Setting up Xvfb + Wine…", null, "init.sh");
      return;
    }
    if (line.includes("[wf] launching wine explorer")) {
      this.set("wine", "Starting Wine — this is the slow part…", null,
               "AGS engine init under TCG");
      return;
    }
  },
};

const bootLog = {
  el: $("#boot-log"),
  lines: [],
  push(line) {
    this.lines.push(line);
    this.el.textContent = this.lines.join("\n");
    this.el.scrollTop = this.el.scrollHeight;
    bootOverlay.consume(line);
  },
  clear() { this.lines = []; this.el.textContent = ""; },
};

function parseQuery() {
  const q = new URLSearchParams(location.search);
  return {
    app: q.get("app"),
    p:   q.get("p") || "",
    net: q.get("net") || "browser",
  };
}

async function loadManifest() {
  try {
    const r = await fetch("./games/manifest.json", { cache: "no-store" });
    if (!r.ok) throw new Error(`manifest ${r.status}`);
    return await r.json();
  } catch (e) {
    return { games: [] };
  }
}

function renderGameList(manifest) {
  const ul = $("#game-list");
  ul.innerHTML = "";
  if (!manifest.games.length) {
    const li = document.createElement("li");
    li.innerHTML = `<span><small>No bundled games yet — drop a zip below or place files in <code>games/</code>.</small></span>`;
    ul.appendChild(li);
    return;
  }
  for (const g of manifest.games) {
    const li = document.createElement("li");
    const href = g.href || `?app=${encodeURIComponent(g.app)}&p=${encodeURIComponent(g.exe)}`;
    li.innerHTML = `
      <a href="${href}">${g.title || g.app}</a>
      <small>${g.exe}</small>
    `;
    ul.appendChild(li);
  }
}

function wireDropZone() {
  const zone = $("#drop");
  const input = $("#file");

  zone.addEventListener("click", () => input.click());

  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    if (f) await runFromBlob(f, guessExeFromName(f.name));
  });

  for (const ev of ["dragenter", "dragover"]) {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add("drag");
    });
  }
  for (const ev of ["dragleave", "drop"]) {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove("drag");
    });
  }
  zone.addEventListener("drop", async (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) await runFromBlob(f, guessExeFromName(f.name));
  });
}

function guessExeFromName(zipName) {
  // If a dropped file is "DinoWalkSim.zip" we'll guess "DinoWalkSim.exe".
  // The zip probe will correct this if needed.
  return zipName.replace(/\.zip$/i, "") + ".exe";
}

async function runFromBlob(blob, preferredExe, appName = "local") {
  status("loading zip…", "busy");
  show("runner");
  bootLog.clear();
  bootLog.push(`[wineframe] staging ${formatBytes(blob.size)} zip`);

  const stage = await stageZip(blob, preferredExe);
  if (!stage.ok) return crash(stage.err);
  stage.appName = appName;

  bootLog.push(`[wineframe] entry: ${stage.exe}`);
  await boot(stage);
}

async function runFromUrl(app, p) {
  show("runner");
  bootLog.clear();

  // Per-app manifest: games/<app>/manifest.json. Presence of
  // renderer:"native" routes to a JS game module instead of the QEMU
  // path — used for demos and while the wine stack is being wired.
  const appManifest = await fetch(`./games/${encodeURIComponent(app)}/manifest.json`)
    .then((r) => r.ok ? r.json() : null)
    .catch(() => null);

  if (appManifest && appManifest.renderer === "native" && appManifest.entry) {
    status("loading native renderer…", "busy");
    bootLog.push(`[wineframe] native renderer: ${appManifest.entry}`);
    try {
      const mod = await import(appManifest.entry);
      $("#phase").textContent = appManifest.title || app;
      $("#boot-log").classList.add("hidden");
      mod.run({
        canvas: $("#fb"),
        log:    (line) => bootLog.push(line),
        onExit: () => {
          history.pushState({}, "", location.pathname);
          $("#boot-log").classList.remove("hidden");
          show("launcher");
          status("idle");
        },
      });
      status("running", "ok");
    } catch (e) {
      crash(`native renderer failed: ${e.message || e}`);
    }
    return;
  }

  // "Baked" games skip the zip fetch — the exe is pre-installed in
  // /opt/app/ inside the QEMU guest rootfs and init.sh runs it directly.
  if (appManifest && appManifest.baked) {
    status("booting QEMU…", "busy");
    bootLog.push(`[wineframe] baked app: ${appManifest.exe || "(auto-detect)"}`);
    const stage = {
      blob: new Blob([], { type: "application/zip" }),
      entries: [],
      exe: appManifest.exe || "",
      appName: app,
    };
    await boot(stage);
    return;
  }

  status(`fetching ${app}.zip…`, "busy");
  bootLog.push(`[wineframe] GET games/${app}.zip`);

  try {
    const r = await fetch(`./games/${encodeURIComponent(app)}.zip`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    bootLog.push(`[wineframe] fetched ${formatBytes(blob.size)}`);
    const stage = await stageZip(blob, p || `${app}.exe`);
    if (!stage.ok) return crash(stage.err);
    stage.appName = app;
    bootLog.push(`[wineframe] entry: ${stage.exe}`);
    await boot(stage);
  } catch (e) {
    crash(`could not load games/${app}.zip: ${e.message}`);
  }
}

// stageZip holds the zip bytes in memory and surfaces metadata the 9P
// bridge will later stream to the guest. We deliberately don't decompress
// the full archive client-side — the zip stays compressed, and the 9P
// server (Go-on-WASI) will serve entries on demand.
async function stageZip(blob, preferredExe) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const eocd = findEOCD(buf);
  if (!eocd) return { ok: false, err: "not a zip file (no EOCD signature)" };

  const entries = readCentralDirectory(buf, eocd);
  if (!entries.length) return { ok: false, err: "zip is empty" };

  // Pick the exe: exact preferred match > case-insensitive > first .exe
  const pick = chooseExe(entries, preferredExe);
  if (!pick) return { ok: false, err: "no .exe found in zip" };

  window.__wineframeStage = { blob, entries, exe: pick };
  return { ok: true, exe: pick, entries, blob, appName: null };
}

function chooseExe(entries, preferred) {
  const exes = entries.filter((e) => /\.exe$/i.test(e.name) && !e.isDir);
  if (!exes.length) return null;
  if (preferred) {
    const exact = exes.find((e) => e.name === preferred);
    if (exact) return exact.name;
    const ci = exes.find((e) => e.name.toLowerCase() === preferred.toLowerCase());
    if (ci) return ci.name;
    const base = exes.find((e) => e.name.split("/").pop().toLowerCase() === preferred.toLowerCase());
    if (base) return base.name;
  }
  return exes[0].name;
}

// --- minimal zip central-directory reader (no decompression) -------------

function findEOCD(buf) {
  // 0x06054b50 — end of central directory record, searched from the tail.
  const MAX_COMMENT = 65536;
  const start = Math.max(0, buf.length - (22 + MAX_COMMENT));
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      const v = new DataView(buf.buffer, buf.byteOffset + i, 22);
      return {
        totalEntries: v.getUint16(10, true),
        cdSize:       v.getUint32(12, true),
        cdOffset:     v.getUint32(16, true),
      };
    }
  }
  return null;
}

function readCentralDirectory(buf, eocd) {
  const out = [];
  let off = eocd.cdOffset;
  const v = new DataView(buf.buffer, buf.byteOffset);
  for (let i = 0; i < eocd.totalEntries; i++) {
    if (v.getUint32(off, true) !== 0x02014b50) break; // central directory sig
    const method   = v.getUint16(off + 10, true);
    const compSize = v.getUint32(off + 20, true);
    const fullSize = v.getUint32(off + 24, true);
    const nameLen  = v.getUint16(off + 28, true);
    const extraLen = v.getUint16(off + 30, true);
    const cmtLen   = v.getUint16(off + 32, true);
    const local    = v.getUint32(off + 42, true);
    const name     = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    out.push({
      name,
      isDir: name.endsWith("/"),
      method,
      compSize,
      size: fullSize,
      localOffset: local,
    });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

// --- boot: load QEMU-wasm artifacts and start the guest ------------------

async function boot(stage) {
  status("booting QEMU…", "busy");
  $("#phase").textContent = "fetching runtime";

  // K12: show the loading overlay. It self-hides once the framebuffer
  // pump produces a real frame (polled below).
  bootOverlay.show();
  bootOverlay.set("download", "Loading runtime…", null, "starting…");
  // Poll for the first decoded frame; auto-hide when the canvas has
  // actual content from the guest.
  const overlayPoll = setInterval(() => {
    if (window.__wfFb?.frames > 0) {
      bootOverlay.hide();
      clearInterval(overlayPoll);
    }
  }, 500);

  const runtime = await probeRuntime();
  if (!runtime.ok) {
    bootLog.push("");
    bootLog.push("[wineframe] QEMU-wasm runtime is not built yet.");
    bootLog.push("");
    bootLog.push("Expected files under ./assets/:");
    for (const f of runtime.missing) bootLog.push(`  - ${f}`);
    bootLog.push("");
    bootLog.push("Run the Docker build (see BUILD.md) to produce them.");
    bootLog.push("The shell above is already functional — zip staged OK.");
    status("runtime missing", "error");
    $("#phase").textContent = "runtime missing";
    return;
  }

  bootLog.push("[wineframe] runtime assets OK — starting guest");
  $("#phase").textContent = "booting guest";

  const { startRuntime } = await import("./runtime.js");
  // If the previous page run left a "restore from this URL" flag (the
  // Load Snapshot button stores it before reload), pick that up. We
  // clear it immediately so a normal reload doesn't loop.
  const restoreUrl = sessionStorage.getItem("wf-restore-from") || null;
  if (restoreUrl) {
    sessionStorage.removeItem("wf-restore-from");
    bootLog.push(`[wineframe] restoring from ${restoreUrl}`);
  }
  try {
    // Also accept ?app=ONESHOT or ?app=LIGHTHOUSE without a zip — those
    // are baked into the rootfs.
    await startRuntime({
      stage,
      appName:   stage.appName || "app",
      exe:       stage.exe,
      log:       (line) => bootLog.push(line),
      terminalEl: $("#term"),
      restoreUrl,
    });
    status("running", "ok");
    $("#phase").textContent = "guest running";
  } catch (e) {
    bootLog.push(`[wineframe] runtime error: ${e.message || e}`);
    status("error", "error");
    $("#phase").textContent = "runtime error";
  }
}

const RUNTIME_FILES = [
  "assets/qemu-system-x86_64.wasm",
  "assets/qemu-system-x86_64.js",
  "assets/qemu-system-x86_64.worker.js",
  "assets/base-image.img.gz",
  "assets/wine-prefix.img.gz",
  "assets/load-kernel.js",
  "assets/load-kernel.data",
  "assets/load-initramfs.js",
  "assets/load-initramfs.data",
  "assets/load-rom.js",
  "assets/load-rom.data",
  "bridge/bridge.wasm",
];

async function probeRuntime() {
  const missing = [];
  for (const f of RUNTIME_FILES) {
    const r = await fetch(f, { method: "HEAD" }).catch(() => null);
    if (!r || !r.ok) missing.push(f);
  }
  return { ok: missing.length === 0, missing };
}

function crash(msg) {
  status("error", "error");
  $("#crash-log").textContent = String(msg);
  show("crash");
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

// --- entry ---------------------------------------------------------------

$("#back")?.addEventListener("click", () => {
  history.pushState({}, "", location.pathname);
  show("launcher");
  status("idle");
});
$("#crash-back")?.addEventListener("click", () => {
  history.pushState({}, "", location.pathname);
  show("launcher");
  status("idle");
});

// K5: register the service worker so the big runtime assets are
// cached on disk after the first cold boot. Subsequent visits hit the
// Cache API instead of the network.
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {
    // SW registration is opportunistic — no-op if the browser refuses.
  });
}

// R-K16 (early asset preload): kick off in-flight fetches for the
// heavy qemu runtime assets the moment we know the user wants the
// qemu path (URL has ?app=LIGHTHOUSE or any non-native app). This
// races the asset network fetches against the manifest fetch + JS
// module imports + runtime probe, so by the time runtime.js calls
// fetch() the request is already in the browser cache (or in-flight)
// and dedupes. Saves ~1-3s of serial latency on cold boot.
//
// We hold strong refs to the response promises on a global scratch
// object so runtime.js can grab them via window.__wfPreload[url]
// instead of re-fetching. If runtime.js doesn't pick them up they
// just become an unused cached fetch — still helps because the SW
// will store the bytes for the actual fetch.
function preloadRuntimeAssets() {
  const urls = [
    "./assets/base-image.img.gz",
    "./assets/wine-prefix.img.gz",
    "./assets/qemu-system-x86_64.wasm",
    "./assets/qemu-system-x86_64.js",
    "./assets/qemu-system-x86_64.worker.js",
    "./assets/load-kernel.js",
    "./assets/load-kernel.data",
    "./assets/load-initramfs.js",
    "./assets/load-initramfs.data",
    "./assets/load-rom.js",
    "./assets/load-rom.data",
    "./assets/base-image.img.gz.size",
    "./assets/wine-prefix.img.gz.size",
  ];
  window.__wfPreload = {};
  for (const url of urls) {
    try { window.__wfPreload[url] = fetch(url); } catch { /* opportunistic */ }
  }
}

(async function main() {
  const q = parseQuery();
  if (q.app) {
    // Per-app native renderer routing happens inside runFromUrl, but
    // by the time we know it's native we'd have wasted the preload.
    // Look at the manifest here cheaply (it's tiny + likely cached)
    // to decide. If we can't reach it (offline, error), assume qemu
    // path and preload — wasted bandwidth but only a few KB of risk.
    const m = await fetch(`./games/${encodeURIComponent(q.app)}/manifest.json`)
      .then((r) => r.ok ? r.json() : null).catch(() => null);
    if (!m || m.renderer !== "native") preloadRuntimeAssets();
    await runFromUrl(q.app, q.p);
  } else {
    const manifest = await loadManifest();
    renderGameList(manifest);
    wireDropZone();
    show("launcher");
    status("idle");
  }
})();
