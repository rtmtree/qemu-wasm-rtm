# plan-speed-game-boot — speed up the cold boot, no snapshots, no native JS

Scope: keep the QEMU + Linux + Wine stack. Make the *real* cold boot
faster by trimming what's slow, not by skipping it.

## Where the time actually goes (cold boot, ~5–10 min)

```
phase                         time      knob
────────────────────────────  ────────  ───────────────────────────────
asset download (1.1 GB total) 30–90 s   compression, asset size, cache
gzip → MEMFS                  30–60 s   compression algorithm, parallel
kernel + initramfs            20–40 s   smaller kernel, leaner init
wf-init (Xvfb, daemons, …)    20–60 s   drop diagnostics, parallelise
Wine init (services, DLLs)    180–360 s strip prefix, disable services
AGS engine init               30–120 s  driver, audio, color depth
fb-pump first frame           0–3 s     pump cadence
```

The big lump is **Wine init** — half of total boot. Most of that is
opaque to us (it's Wine's services/explorer.exe init under TCG), but
~25–40 % is time we *spend on things AGS doesn't use* and can disable.

## Knobs, ranked by **real seconds saved per hour of effort**

Ordered so you can pick from the top and stop when boot is fast enough.

### K1. Disable Wine's RPC / services stack  ★ biggest single win

Today's `wine.err` is dominated by:

```
err:service:process_send_command service protocol error !
err:ole:start_rpcss Failed to start RpcSs service
err:service:device_notify_proc failed to open RPC handle
```

`services.exe` and `RpcSs` retry-and-fail for **30–60 seconds** before
Wine gives up and lets the app launch. AGS doesn't use any of them.

**Fix**: in the wineprefix, set DLL overrides + disable the service.
Either via registry (`HKCU\Software\Wine\DllOverrides`) baked into
`wine-skel.tar.gz`, or via env vars in init.sh:

```sh
export WINEDLLOVERRIDES="mscoree=;mshtml=;rpcrt4=b;ole32=b;oleaut32=b;services=;svchost=;winemenubuilder.exe=;${WINEDLLOVERRIDES:-}"
```

Also pass `wine explorer.exe /desktop=virt,320x240 /nostartup …` to
skip the explorer auto-start of services. (`/nostartup` may or may not
exist in our wine version — fallback is the registry route.)

- **Saves**: 30–60 s per boot.
- **Effort**: 1–2 hours. Just env vars + maybe one registry edit.
- **Risk**: low. AGS doesn't use any of these. Test for audio + clipboard
  regressions after.
- **Files**: `build/base-image/init.sh` (env vars), maybe
  `build/base-image/Dockerfile` (registry tweak in wineprefix builder).

### K2. Drop the wine + xdpyinfo "smoke tests" in init.sh

Right now init.sh does, *every boot*:

```
[wf] wine --version test:           # forks wine just to print a version
[wf]   wine-8.0 (Debian 8.0~repack-4)
[wf] xdpyinfo test (Xvfb on :0):    # 6+ X round trips for diagnostics
[wf]   xd> name of display:    :0
[wf]   xd> version number:    11.0
…
```

`wine --version` triggers a *full* wineboot/explorer cold-load just to
exit, because Wine doesn't have a fast path for `--version` on a fresh
prefix. That alone costs **30–60 s** on first boot.

**Fix**: gate the diagnostics behind `[ -n "$WF_DEBUG" ]` and don't
set `WF_DEBUG` in production.

- **Saves**: 30–60 s.
- **Effort**: 5 minutes.
- **Risk**: none — pure diagnostics.
- **Files**: `build/base-image/init.sh` lines ~386–392.

### K3. Strip the wineprefix down to AGS-required DLLs

Current `wine-prefix.img.gz` is **226 MB compressed / 668 MB raw**.
About half of that is stuff AGS never touches:

| component        | rough MB | needed by AGS? |
|------------------|----------|----------------|
| Wine Mono (.NET) | ~80      | no             |
| Wine Gecko (HTML)| ~50      | no             |
| MS fonts pack    | ~40      | barely         |
| IE6 / mshtml     | ~30      | no             |
| Many `system32` DLLs we never load (winhttp, wininet, ws2_32 paths, msi, mscoree) | ~50 | no |
| Actually used DLLs (kernel32, user32, gdi32, ddraw, wined3d, dsound, dinput, msvcrt, sdl2-runtime) | ~120 | yes |

**Fix**: build a stripped prefix from the existing one. Pseudocode:

```sh
# In the prefix builder Dockerfile (or one-off script):
rm -rf  drive_c/windows/Microsoft.NET                         # Mono
rm -rf  drive_c/windows/system32/gecko                        # Gecko
rm -f   drive_c/windows/system32/{msh,iert,jscript,wbem,…}*   # IE6/mshtml stack
rm -rf  drive_c/windows/Fonts/{cour,times,wingding,*-bold,*}.ttf
# Then re-pack into wine-prefix.ext4 (the existing pipeline).
```

A trimmed prefix lands at **~120 MB raw / 50 MB gzipped**, halving the
prefix download and shaving 10–20 s off Wine's DLL load loop (fewer
`mmap`+`fixup` calls during init).

- **Saves**: 10–20 s wine init + ~175 MB download.
- **Effort**: half a day. Iterate: strip → boot → if AGS still launches,
  keep the change. AGS' actual DLL footprint is small but non-obvious.
- **Risk**: medium — easy to delete a DLL AGS lazy-loads. Test the full
  game flow (title → in-game → save/load) after each strip pass.
- **Files**: `build/base-image/Dockerfile` (post-process the prefix
  before tarballing), `build/base-image/wine-skel.tar.gz`.

### K4. Use zstd instead of gzip for the rootfs + prefix images

`gzip -1` was used because it decompresses fast in `DecompressionStream`.
zstd does the same job in **3–5× less time** with similar or better
compression ratio. Chrome doesn't natively decode zstd in
`DecompressionStream`, but a wasm zstd decoder (~80 KB) is plenty
fast.

- **Saves**: 10–25 s of MEMFS streaming, possibly ~50 MB of download
  (zstd-3 typically beats gzip-9 on ratio).
- **Effort**: 2–4 hours. Pull `@bokuweb/zstd-wasm` (or similar), wrap
  it in a `TransformStream` matching the existing gzip path in
  `streamGzToFS`, dispatch on file extension.
- **Risk**: low.
- **Files**: `site/runtime.js` (`streamGzToFS` becomes
  `streamCompressedToFS`), asset build pipeline (compress with `zstd`
  instead of `gzip`).

### K5. Service worker that caches the big assets

The first cold boot pays full network cost. Every subsequent visit
*also* pays full network cost today, because nothing is cached
client-side. A 60-line service worker with the Cache API turns "second
boot" into "decompress only + boot".

- **Saves**: 30–90 s **on every boot after the first** (the asset
  download phase, completely).
- **Effort**: 2–3 hours. Standard SW recipe. Cache key by asset SHA so
  a publish-time bump invalidates cleanly.
- **Risk**: low. Don't cache the bridge / tiny files; do cache
  `*.img.gz`, `qemu-system-*.{wasm,js}`, kernel/initrd.
- **Files**: new `site/sw.js`, registration in `site/loader.js`,
  asset version manifest (`assets/manifest.json`).

### K6. Multi-CPU + MTTCG: `-smp 2` and `-accel tcg,thread=multi`

Today QEMU runs single-CPU TCG. Wine's `services.exe` polling, the
explorer.exe loop, AGS engine, and llvmpipe rendering all serialize
onto one guest CPU.

x86_64-softmmu has supported MTTCG since QEMU ~3.0 — the wasm build
would need `-pthread` (already on, since SAB works) and the args:

```
-smp 2 -accel tcg,thread=multi,tb-size=500
```

- **Saves**: 20–35 % of the Wine + AGS init phase if MTTCG functions
  correctly. AGS's render loop is single-threaded so the AGS phase
  itself doesn't fully scale; Wine's parallel work does.
- **Effort**: 30 min to try. Just edit `buildArgs`. If MTTCG isn't
  compiled in or the build crashes under it, fallback is trivial.
- **Risk**: medium. SAB-required, atomics-sensitive; can hit
  memory-ordering edge cases on the non-x86 host (browser).
- **Files**: `site/runtime.js` (`buildArgs`).

### K7. Strip the Debian rootfs

`base-image.img.gz` is **777 MB compressed / 1.85 GB raw**. The Debian
base ships:

- `/usr/share/locale/*` — ~150 MB of i18n we don't display
- `/usr/share/man/*` — ~30 MB of man pages
- `/usr/share/doc/*` — ~50 MB of READMEs
- `/var/cache/apt/*` — package archives (~50 MB)
- A bunch of one-shot installer leftovers

Trim those + run `apt-get autoremove + clean` and the rootfs lands at
**~1.4 GB raw / ~600 MB gzipped**. Smaller download, slightly faster
filesystem walks during boot (kernel scans fewer inodes during
read-ahead).

- **Saves**: ~180 MB download (~10–20 s on a 100 Mbps link), 0–5 s
  fs cache warmup.
- **Effort**: half a day. One stanza in the Dockerfile.
- **Risk**: low. Test that no removed locale breaks Wine's text input.
- **Files**: `build/base-image/Dockerfile`.

### K8. Mute Wine's audio init

We already set `SDL_AUDIODRIVER=dummy`, but Wine itself still tries to
initialise winealsa / winepulse / winecoreaudio drivers and fails
because there's no audio device. Each init attempt + timeout is
~3–8 s.

**Fix**: add to `WINEDLLOVERRIDES`:

```sh
export WINEDLLOVERRIDES="winealsa.drv=;winepulse.drv=;winmm=b;dsound=b;${WINEDLLOVERRIDES}"
```

This forces winmm/dsound to use the built-in (silent) implementation
and stops Wine probing host audio drivers.

- **Saves**: 5–15 s.
- **Effort**: 5 minutes.
- **Risk**: low. AGS still gets a working dsound stub. Game audio is
  silent — already silent today, so no regression.
- **Files**: `build/base-image/init.sh`.

### K9. Tighten init.sh ordering: parallelise Xvfb + 9p mount

Today init.sh is a strict sequence:

```
modprobe 9p modules    (~3 s)
mount /var/host        (~1 s)
mount /opt/wine-prefix (~1 s, fast since K-fix)
ldconfig               (~5 s on Debian)
Xvfb start             (~3 s)
pre-paint Xvfb screen  (~1 s)
…
```

Several can overlap:
- `Xvfb` start in the background while `ldconfig` runs in foreground.
- 9p modules load + 9p mount can overlap with Xvfb startup.
- `ldconfig` is *especially* slow on a fresh boot since glibc rebuilds
  the cache. Pre-bake `ld.so.cache` into the rootfs at build time,
  drop the runtime call entirely.

- **Saves**: 8–15 s.
- **Effort**: 1–2 hours.
- **Risk**: low. Watch for race: anything that needs `ld.so.cache`
  warm before its first lib call (mainly Xvfb).
- **Files**: `build/base-image/init.sh`,
  `build/base-image/Dockerfile` (run `ldconfig` at build time).

### K10. Faster fb-pump cadence + virtio-serial channel

Frames currently emit every **3 s** over the multiplexed serial. Once
AGS *is* drawing, the user still waits up to 3 s to see the title.

**Fix step 1** (5 min): change the `sleep 3` in init.sh to `sleep 0.5`.

**Fix step 2** (4 hours, optional): replace base64-over-`/dev/console`
with a `virtio-serial` second port dedicated to frames. Frees the
serial mux, allows ~30 FPS, removes the framebuffer pump's flock
contention with the rest of the console traffic.

- **Saves**: 0–3 s perceived first-frame latency.
- **Effort**: 5 min (step 1) → 4 h (step 2).
- **Risk**: low.
- **Files**: `build/base-image/init.sh` (step 1), `site/runtime.js`
  + `build/base-image/init.sh` (step 2).

### K11. Stripped kernel + busybox initramfs

Debian's `vmlinuz-virt` is ~12 MB and pulls a 30 MB initramfs that
walks every driver. Replace with a custom-built kernel containing
*only* `virtio-blk`, `virtio-net`, `9p`, `ext4`, `tmpfs`, `procfs`,
`sysfs` and a 200 KB busybox initramfs that just `exec switch_root`.

- **Saves**: 8–20 s kernel boot + ~25 MB download.
- **Effort**: 1–2 days. Custom kernel build is fiddly but well-trodden.
- **Risk**: medium. Easy to drop a driver we silently depend on (e.g.
  9pnet_virtio symbols).
- **Files**: kernel build pipeline (new), `build/base-image/Dockerfile`.

### K12. Pre-paint the canvas with "loading" frames during boot

Pure UX, not actually faster. Right now the canvas is black for
several minutes between page load and AGS' first frame. Show:

1. **0–10 s**: "Downloading runtime…" with a progress bar driven by
   the existing `runtime.js` per-MiB log lines.
2. **10–60 s**: "Booting Linux…" with a spinner.
3. **60–end**: "Starting Wine — this is the slow part…"

Drives perceived speed up by **maybe 40 %** with **zero** real boot
saving. Nice-to-have; not on the critical path.

- **Saves**: 0 s actual; large in user perception.
- **Effort**: 2–3 hours.
- **Risk**: none.
- **Files**: `site/loader.js`, `site/runtime.js`, `site/style.css`,
  `site/index.html`.

## Recommended order

If you want maximum boot reduction with minimum effort, do these in
order. Each is independent — bail at any point.

1. **K1 (disable Wine RPC/services)** — 30–60 s, half a day. Single
   biggest lever.
2. **K2 (drop wine/xdpyinfo smoke tests)** — 30–60 s, 5 min.
3. **K8 (mute Wine audio drivers)** — 5–15 s, 5 min.
4. **K10 step 1 (fb-pump cadence 3 s → 0.5 s)** — 0–3 s perceived,
   5 min.
5. **K6 (try MTTCG)** — 20–35 % of wine+AGS init, 30 min. If unstable,
   revert.
6. **K3 (strip wineprefix)** — 10–20 s + 175 MB download, half a day.
7. **K5 (service worker cache)** — 30–90 s on warm boot, 2–3 hours.
8. **K4 (zstd compression)** — 10–25 s decompress, 2–4 hours.
9. **K9 (init.sh parallelisation + pre-baked ldconfig)** — 8–15 s,
   1–2 h.
10. **K7 (strip Debian rootfs)** — ~10–20 s + 180 MB, half a day.
11. **K11 (custom kernel)** — 8–20 s + 25 MB, 1–2 days.
12. **K12 (progress UI)** — perception only.

## Realistic combined target

Apply K1 + K2 + K8 + K10s1 + K6 (the cheap top of the list) and the
**cold boot drops from 5–10 min to roughly 3–6 min**. Add K3 + K5 +
K4 and you're at **2–4 min cold, ~30 s warm**. The rest are
diminishing returns.

If you want sub-30s first-boot you can't get there with these knobs —
that requires snapshot/restore or skipping QEMU entirely.

## Acceptance test (per knob)

- K1: `wine.err` no longer contains `RpcSs`. Wine init phase ≥ 25 s
  shorter than baseline.
- K2: init.sh boot log goes straight from `Xvfb ready` to
  `launching wine explorer`, no `wine --version` / `xdpyinfo` lines.
- K3: `wine-prefix.img.gz` ≤ 80 MB. AGS title still renders, in-game
  cursor + audio (or muted audio) still functional.
- K5: second visit's Network panel shows zero bytes for
  `*.img.gz` / `*.wasm` / kernel.
- K6: cold boot ≥ 20 % faster than the K1+K2+K8 baseline.
- K10s1: first-frame appears within 0.5–1 s of init.sh's
  `launching wine explorer` log line.
- K7: `base-image.img.gz` ≤ 600 MB.
- K11: `vmlinuz` ≤ 5 MB. Boot still reaches userland.

## Out of scope

- QEMU savevm / loadvm and disk overlays (per user direction).
- Native JS / wasm AGS engine (per user direction).
- WebGPU acceleration of llvmpipe (would need a wine GL → WebGPU
  shim — months of work).
- Replacing Wine with a different Win32 runtime (none viable in wasm).
