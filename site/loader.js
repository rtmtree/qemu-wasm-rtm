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

// Boot progress overlay (R5).
//
// Each phase has a target % at its end and a `typical` wall-clock duration
// in seconds. The bar fills smoothly within a phase via time-based
// interpolation: pct = phase.start + (phase.end − phase.start) · min(elapsed / typical, 0.97).
// When a real-world marker (log line or fb frame) confirms a phase
// transition, we snap forward to the next phase's start %. Phases never
// move backwards.
//
// Markers (in order, monotonic):
//   preload    → streaming  : "[runtime] GET ./assets/" (first asset fetch begins)
//   streaming  → kernel     : "rootfs in MEMFS:"        (decompress finished, kernel about to boot)
//   kernel     → init       : "[wf] booted "            (init.sh running inside guest)
//   init       → wine       : "[wf] launching wine"     (wine command issued)
//   wine       → game       : window.__wfFb.frames >= 2 (first content change after pre-paint)
//   game       → done       : window.__wfFb.frames >= 5 (steady frame flow → real game running)
//
// Phase targets calibrated against observed cold-boot. Booting Linux
// in particular has been observed running 5-15× the typical eta on
// some setups, so within-phase progress uses an exponential decay
// (1 - exp(-elapsed/eta * 1.2)): ~70 % of the phase span at elapsed=eta,
// ~91 % at 2·eta, ~97 % at 3·eta, asymptoting toward but never
// reaching 100 %. The bar always moves forward, even on slow boots.
const PHASES = [
  { id: "preload",    start: 0,  end: 5,   name: "Loading runtime",     eta: 3   },
  { id: "streaming",  start: 5,  end: 28,  name: "Streaming assets",    eta: 45  },
  { id: "kernel",     start: 28, end: 38,  name: "Booting Linux",       eta: 60  },
  { id: "init",       start: 38, end: 48,  name: "Setting up Wine",     eta: 12  },
  { id: "wine",       start: 48, end: 78,  name: "Loading Wine DLLs",   eta: 130 },
  { id: "game",       start: 78, end: 99,  name: "Loading game",        eta: 90  },
];

function fmtClock(secs) {
  if (!isFinite(secs) || secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const bootOverlay = {
  el:       $("#boot-overlay"),
  stageEl:  $("#bo-stage"),
  fillEl:   $("#bo-fill"),
  detailEl: $("#bo-detail"),
  pctEl:    null, // created lazily on first show
  hidden: true,
  startTs: 0,
  phaseStartTs: 0,
  phaseIdx: 0,
  manualFraction: null, // when set, overrides time-based fraction (e.g. real download bytes)
  fillTimer: null,
  totalEta: PHASES.reduce((s, p) => s + p.eta, 0),
  framesPollTimer: null,

  show() {
    if (!this.hidden) return;
    this.el.hidden = false;
    this.hidden = false;
    this.startTs = Date.now();
    this.phaseStartTs = Date.now();
    this.phaseIdx = 0;
    this.manualFraction = null;
    this.ensurePctEl();
    this.startTickTimer();
    this.startFramesPoll();
    this.refresh();
  },

  hide() {
    if (this.hidden) return;
    this.el.hidden = true;
    this.hidden = true;
    if (this.fillTimer) { clearInterval(this.fillTimer); this.fillTimer = null; }
    if (this.framesPollTimer) { clearInterval(this.framesPollTimer); this.framesPollTimer = null; }
  },

  // Lazily insert a "<pct>% — m:ss elapsed" line below the stage label.
  // We do this in JS rather than HTML so older overlay markup (which lacks
  // the element) still works after a reload during development.
  ensurePctEl() {
    if (this.pctEl) return;
    const el = document.createElement("div");
    el.className = "bo-pct";
    el.id = "bo-pct";
    // Insert immediately after .bo-bar so the order is: stage / bar / pct / detail.
    const bar = this.el.querySelector(".bo-bar");
    bar.insertAdjacentElement("afterend", el);
    this.pctEl = el;
  },

  enterPhase(id) {
    const idx = PHASES.findIndex((p) => p.id === id);
    if (idx < 0 || idx <= this.phaseIdx) return;
    this.phaseIdx = idx;
    this.phaseStartTs = Date.now();
    this.manualFraction = null;
    this.refresh();
  },

  // Set a real-data fraction (0..1) within the current phase. Used for the
  // streaming phase where we have actual download bytes.
  setManual(fraction) {
    this.manualFraction = Math.max(0, Math.min(0.99, fraction));
    this.refresh();
  },

  setDetail(text) {
    if (this.hidden) return;
    if (text !== undefined) {
      this.detailEl.textContent = text;
      this.lastDetail = text;
    }
  },

  // Compute and apply the current bar % + texts.
  refresh() {
    if (this.hidden) return;
    const phase = PHASES[this.phaseIdx];
    const elapsedInPhase = (Date.now() - this.phaseStartTs) / 1000;
    let frac;
    if (this.manualFraction !== null) {
      frac = this.manualFraction;
    } else {
      // Exponential decay — bar always moves forward, asymptotes to 0.99.
      // At elapsed=eta the bar is ~70 % of the phase span; at 2·eta ~91 %;
      // at 5·eta ~99.7 %. Clamp at 0.99 to never overrun the next phase.
      const ratio = elapsedInPhase / phase.eta;
      frac = Math.min(1 - Math.exp(-ratio * 1.2), 0.99);
    }
    const pct = phase.start + (phase.end - phase.start) * frac;
    this.fillEl.classList.remove("indeterminate");
    this.fillEl.style.width = `${pct.toFixed(1)}%`;
    this.stageEl.textContent = phase.name + "…";
    // If we've been in this phase well past its eta AND it's been at
    // least 30 s, surface the wait so the user knows the bar isn't
    // frozen — it's just a long phase. Short phases (eta ~3 s) would
    // hit "2×" within seconds and produce noise; the absolute floor
    // keeps the hint useful only when there's a real wait.
    if (this.manualFraction === null
        && elapsedInPhase > phase.eta * 2
        && elapsedInPhase > 30) {
      const overage = Math.floor(elapsedInPhase / phase.eta * 10) / 10;
      this.detailEl.textContent =
        `${this.lastDetail || phase.name}  ·  taking ${overage.toFixed(1)}× the typical time`;
    }
    if (this.pctEl) {
      const elapsed = (Date.now() - this.startTs) / 1000;
      // Estimated remaining = sum of remaining phase etas, scaled by how
      // much of the current phase is left. Honest about uncertainty.
      let remaining = (1 - frac) * phase.eta;
      for (let i = this.phaseIdx + 1; i < PHASES.length; i++) {
        remaining += PHASES[i].eta;
      }
      this.pctEl.textContent = `${pct.toFixed(0)}%  ·  ${fmtClock(elapsed)} elapsed`
        + `  ·  ~${fmtClock(remaining)} remaining`;
    }
  },

  startTickTimer() {
    if (this.fillTimer) return;
    this.fillTimer = setInterval(() => this.refresh(), 500);
  },

  // Watch the framebuffer pump for content frames. We can't hide on the
  // first frame anymore — that's the pre-paint blue screen. Frames 2+ are
  // real content (wine desktop, AGS title).
  startFramesPoll() {
    if (this.framesPollTimer) return;
    this.framesPollTimer = setInterval(() => {
      const frames = window.__wfFb?.frames || 0;
      if (frames >= 2 && this.phaseIdx < PHASES.findIndex((p) => p.id === "game")) {
        this.enterPhase("game");
      }
      if (frames >= 5) {
        // Steady frame flow → real game is running. Hide the overlay.
        this.hide();
      }
    }, 500);
  },

  // Drive the overlay from a single log line.
  consume(line) {
    if (this.hidden) return;
    let m;
    // Streaming: rootfs.img.gz progress is the dominant signal — map its
    // download fraction onto the streaming phase's bar range.
    if ((m = line.match(/\[runtime\] \.\/assets\/base-image\.img\.gz\s+([\d.]+) MiB \/ ([\d.]+) MiB/))) {
      const cur = parseFloat(m[1]), tot = parseFloat(m[2]);
      this.enterPhase("streaming");
      if (tot > 0) this.setManual(cur / tot);
      this.setDetail(`asset stream: ${cur.toFixed(0)} / ${tot.toFixed(0)} MiB`);
      return;
    }
    // Other asset download lines (kernel, prefix) — use as a phase-enter
    // signal only.
    if (line.match(/\[runtime\] \.\/assets\/[^ ]+\s+[\d.]+ MiB \/ [\d.]+ MiB/)) {
      this.enterPhase("streaming");
      return;
    }
    if (line.match(/\[runtime\] GET \.\/assets\//)) {
      this.enterPhase("streaming");
      this.setDetail("opening fetch streams…");
      return;
    }
    if ((m = line.match(/\[runtime\] wrote ([\d.]+) MiB of rootfs to MEMFS/))) {
      this.enterPhase("streaming");
      // While MEMFS writes are accumulating we're still in the streaming
      // phase but past the pure-network portion — let the time-based
      // interpolation finish the bar.
      this.manualFraction = null;
      this.setDetail(`MEMFS: ${m[1]} MiB written`);
      return;
    }
    if (line.includes("rootfs in MEMFS:")) {
      this.enterPhase("kernel");
      this.setDetail("kernel decompress + initramfs");
      return;
    }
    if (line.match(/^\[wf\] booted /) || line.includes("[wf] booted ")) {
      this.enterPhase("init");
      this.setDetail("mounts, daemons, Xvfb pre-paint");
      return;
    }
    if (line.includes("[wf] mounted /dev/vdb")) {
      this.enterPhase("init");
      this.setDetail("wineprefix mounted");
      return;
    }
    if (line.includes("[wf] Xvfb starting")) {
      this.enterPhase("init");
      this.setDetail("X server starting…");
      return;
    }
    if (line.includes("[wf] pre-painted Xvfb")) {
      this.enterPhase("init");
      this.setDetail("pre-paint pattern written");
      return;
    }
    if (line.includes("[wf] fb-pump")) {
      this.enterPhase("init");
      this.setDetail("framebuffer pump online");
      return;
    }
    if (line.includes("[wf] launching wine")) {
      this.enterPhase("wine");
      this.setDetail("wineboot + DLL load (TCG-bound)");
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

// Expose for live debugging from the devtools console — the boot overlay
// is the user's only feedback during the multi-minute boot, so being able
// to drive its phase machine from the console is useful.
window.__wfBootOverlay = bootOverlay;

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

  // R5: bootOverlay manages its own tick + frames-poll once shown,
  // and self-hides when fb-pump emits real content frames (>=2; the
  // first frame is the pre-paint blue, not actual game content).
  bootOverlay.show();
  bootOverlay.setDetail("starting…");

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
  // R4-7: parallel probe + reuse preloaded GET responses where possible.
  // The original serial HEAD loop cost ~100-500 ms of latency before
  // runtime.js could even start. Now: if the preloaded GET promise has
  // already arrived (started by main() earlier), check its Response —
  // reading .ok / .status doesn't consume the body, so runtime.js can
  // still stream it via the same promise. For everything else, fire all
  // HEADs in parallel.
  const missing = [];
  const checks = await Promise.all(RUNTIME_FILES.map(async (f) => {
    const url = `./${f}`;
    const preloaded = window.__wfPreload?.[url];
    if (preloaded) {
      try { return await preloaded; } catch { /* fall through */ }
    }
    try { return await fetch(f, { method: "HEAD" }); } catch { return null; }
  }));
  for (let i = 0; i < RUNTIME_FILES.length; i++) {
    const r = checks[i];
    if (!r || !r.ok) missing.push(RUNTIME_FILES[i]);
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
