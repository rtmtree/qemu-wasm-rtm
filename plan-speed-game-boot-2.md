# plan-speed-game-boot-2 — what's left after the easy wins are gone

Round 1 (`plan-speed-game-boot.md`) tried the obvious things. Most of
those that *didn't* break the build are now shipped: K2 (skip wine/xdpy
smoke tests), K7 (strip audio/dbus/gtk/gstreamer/cups/v4l/locales),
K9 (prebake `ld.so.cache` + background Xvfb), K10s1 (fb-pump 3 s →
0.5 s), K5 (service worker for warm boots), K12 (progress overlay).
The ones that *did* break the build (K1 services overrides, K3 prefix
strip, K6 MTTCG, K8 audio overrides, `-cpu qemu32`, `-m 512M`,
`tb-size 2000`, dropping `explorer.exe /desktop=virt`) are reverted.

**Net of round 1**: cold boot is roughly ~10–20 % faster, warm boot
(SW cache hit) is dramatically faster on the network side, the user
sees a progress UI instead of a black canvas. AGS title still takes
multiple minutes from a cold load.

Honest reframing for round 2: **the dominant cost is wine's DLL
initialisation under interpreted x86-in-wasm**. Every avenue that
doesn't *skip* wine init is fighting for seconds, not minutes. The
big wins are precisely the things you've ruled out (snapshot resume,
native AGS engine).

This document catalogs the remaining options anyway, ordered by
whether they're worth the risk/effort vs. the realistic payoff.

## Where time is actually going (current state)

```
phase                          wall time   levers tried already
─────────────────────────────  ─────────   ───────────────────────────
asset stream + decompress      30–90 s     K7 (-110 MB), K5 (warm: 0)
kernel + initramfs boot        20–40 s     —
wf-init (Xvfb, daemons, mount) 10–30 s     K9 (-5–10 s)
wine first-run init            120–300 s   K1, K2, K8, K9 (-30–90 s)
AGS engine init                30–120 s    —
fb-pump latency to first frame 0–0.5 s     K10s1 (down from 3 s)
```

The wine row is ~50 % of the total and basically untouchable from the
outside.

## Round-2 options, ranked

### R1. Wine fast-sync (`WINEFSYNC=1` / `WINEESYNC=1`)  ★ try first

Wine 7+ supports kernel-side futex synchronisation (fsync) and
eventfd-based esync. Both replace wineserver's slow message-passing
path with direct kernel primitives. Wine 8.0 (which we ship) supports
both behind environment variables. Reports of 10–30 % wine startup
speedup on Linux native; effect under TCG should be similar since
TCG faithfully translates futex syscalls.

```sh
export WINEESYNC=1
export WINEFSYNC=1
```

Add to init.sh just before the wine launch.

- **Saves**: 10–60 s of wine init.
- **Effort**: 5 minutes. Just env vars + a rootfs repatch.
- **Risk**: medium. Sometimes triggers crashes on edge-case games.
  AGS' wineserver use is light, so the chance of breakage is low.
  If it breaks, AGS will hang at first frame the way `direct wine`
  did — same diagnostic.
- **Files**: `build/base-image/init.sh` (env exports near line 110).

### R2. Bigger TCG translation cache, *carefully* this time  ★ small

Round 1 tried `tb-size=2000` together with `-m 512M`; one of them
broke boot but I never isolated which. The translation block cache
saves retranslation time during wine's DLL load loop. Try `tb-size`
in isolation (1024 → 2000 → 4000) while keeping `-m 1024M`.

- **Saves**: 10–30 s if TCG retranslation is actually a hot path here.
- **Effort**: 5 minutes per attempt.
- **Risk**: low if memory stays at 1024M. The earlier hang was almost
  certainly the memory drop.
- **Files**: `site/runtime.js` (`buildArgs`).

### R3. Skip the fb-pump's base64 encoding  ★ medium

The framebuffer pump emits ~310 KB of base64-encoded XWD per frame
across `/dev/console`, every 0.5 s. That's ~620 KB/s of guest CPU
spent encoding plus host CPU spent decoding, *during* the busy wine
init phase. We're stealing from wine's already-tight TCG budget.

Two ways to fix:

(a) **Lower the cadence during boot** — bump the sleep back to 5 s
    until the frame's pixel hash actually changes for the first time
    (i.e., AGS has drawn). Then drop to 0.5 s. Steals ~10× less CPU
    during the slow phase.

(b) **Switch to a binary 9P channel** — the input forwarder already
    uses 9P (host writes wf-input.txt, guest cats it). Reverse the
    direction: guest writes XWD bytes raw to a known 9P path, JS reads
    them via `Module.FS.readFile`. No base64. ~3× less data, no
    encoding step. The earlier "9P writes are broken in this qemu-wasm
    build" caveat applies to ARBITRARY guest writes; a single
    well-known file might dodge whatever the bug is. Worth probing.

- **Saves**: a chunk of wine init time by freeing TCG cycles. Hard
  to estimate — could be 20 s, could be 60 s.
- **Effort**: 10 minutes for (a). 3–4 hours for (b) including testing
  whether 9P writes work for this specific case.
- **Risk**: (a) low. (b) medium — if 9P writes break the way the
  comment in init.sh warns, we're stuck.
- **Files**: `build/base-image/init.sh`, optionally `site/runtime.js`.

### R4. AGS-specific: disable engine features it doesn't need

The AGS engine reads `acsetup.cfg` and respects a number of flags
that affect startup time:

```ini
[graphics]
driver = Software        ; already set (skips D3D init attempts)
windowed = 0
[sound]
digidriver = 0           ; disable digital audio engine init
midi = 0                 ; disable MIDI engine init
[misc]
splash = 0               ; skip the AGS splash screen (saves 2–5 s)
gfxfilter = none         ; no upscaling filter
```

The current `site/lighthouse/acsetup.cfg` likely has Software driver
set; the others probably aren't. Edit `acsetup.cfg` in
`site/lighthouse/` (which is what gets copied into `/opt/app/` in the
rootfs) to add the audio/splash skips.

- **Saves**: 5–15 s.
- **Effort**: 5 minutes. Edit `acsetup.cfg`.
- **Risk**: low. AGS happily ignores flags it doesn't recognise.
- **Files**: `site/lighthouse/acsetup.cfg`. Game still ships baked
  into the rootfs at build time so a rootfs rebuild is needed.

### R5. Pre-fault the wineprefix at build time

When wine starts and loads a DLL, it `mmap`s the file from the prefix
disk. The first read of each page faults from virtio-blk → MEMFS
→ Uint8Array. Under TCG, that fault path is interpreted-x86-slow.

If we **read** every byte of every wine DLL once during the prefix
build (before tarballing), the linux kernel inside QEMU can prefetch
them on mount. This doesn't actually help — the cold cache hits are
on the *guest* side after the disk is mounted, not on the build host.

Idea that *could* work: bind-mount or copy the wineprefix DLLs into
tmpfs at boot, so subsequent reads skip the virtio-blk path entirely.
Caveat: takes guest RAM, may push us close to the 1 GB limit.

- **Saves**: maybe 10–20 s. Speculative.
- **Effort**: half a day to try and measure.
- **Risk**: medium. Easy to OOM the guest.
- **Files**: `build/base-image/init.sh`.

### R6. Smaller kernel + busybox initramfs (K11 from round 1)

Deferred earlier as "1–2 days, win ~25 MB + 5–15 s". Still a real
win — the Debian `vmlinuz-virt` is full of drivers we don't use and
its initramfs walks every PCI device looking for the right driver.

Rebuild a kernel with only `virtio_blk + virtio_net + 9p + ext4 +
tmpfs + procfs + sysfs + devtmpfs`. Replace initramfs with a 200 KB
busybox cpio that just `exec switch_root`. Kernel boot drops to
~10 s.

- **Saves**: 15–25 s + 25 MB download.
- **Effort**: 1–2 days. Custom kernel build.
- **Risk**: medium. Easy to drop a driver we silently depend on
  (e.g. `9pnet_virtio` or `cache=none` quirks).

### R7. WSL/Wine compile flags optimisation

Right now the rootfs ships the Debian-packaged wine 8.0. A custom
build of wine with:

- `--disable-tests --disable-win16` (smaller, fewer code paths)
- `--with-x` only, no other backends
- LTO / `-O3 -ffast-math`

… would shave wine init time by maybe 10 %. But it requires a wine
build environment with cross-compilation for both 32- and 64-bit
targets, plus all wine's dependencies. Hours of build time.

- **Saves**: 10–30 s.
- **Effort**: 2–3 days end-to-end.
- **Risk**: medium. Custom wine builds are notorious for breaking
  edge cases.

### R8. The big two we keep coming back to

**Snapshot resume (QEMU `savevm`/`loadvm`)** — boot the slow path
*once*, snapshot, persist to OPFS, restore on every later visit in
seconds. Ruled out by user direction. Practical floor for warm boots
with this approach: ~5 s to first AGS frame. Cold boot stays slow.

**Native JS AGS engine (`ags.js` etc.)** — replaces QEMU+Wine entirely
for `.ags` games. Ruled out by user direction. First AGS frame in
~3 s, cold or warm.

Both stand. Both eclipse everything in R1–R7 combined. If boot speed
becomes a hard requirement rather than a "nice to have", these are
the only paths that get there.

## Realistic combined target if R1–R5 all pan out

```
current    cold ~5–10 min,  warm ~3–6 min
+R1        cold ~4–8 min,   warm ~2.5–5 min
+R2        cold ~3.5–7 min, warm ~2–4.5 min
+R3a       cold ~3–6 min,   warm ~1.5–4 min
+R4        cold ~3–6 min    (R4 only saves ~10 s)
+R5        cold ~2.5–5 min
```

That's "wait two and a half to five minutes" cold, which is still
not great. R6 (custom kernel) + R7 (custom wine) might pull another
30–60 s combined, but at significant build complexity.

**The pragmatic line is**: stop optimising the path that includes
"interpret 30 MB of x86 wine DLLs in wasm" and either snapshot it
once, or replace it. Otherwise we're polishing the bottom of an
iceberg.

## Suggested order if we proceed without snapshot/native

1. **R1 (`WINEESYNC=1 WINEFSYNC=1`)** — half an hour incl. rootfs
   repatch. Could save 30–60 s on its own.
2. **R3a (raise fb-pump cadence during boot)** — 15 minutes. Frees
   TCG cycles for wine.
3. **R2 (`tb-size=2000`)** — 5 minutes. Marginal but stackable.
4. **R4 (AGS `acsetup.cfg`)** — 5 minutes.
5. **R3b (binary fb transport)** — half a day, only if wine init
   *still* feels too slow after the above.
6. **R5 (tmpfs-cache wineprefix)** — half a day, speculative.
7. **R6 (custom kernel)** — 1–2 days. Last resort that's still in
   the "tweak" category.

## Acceptance test

For each item, the criterion is "second-by-second improvement on the
existing console-driven boot timing":

```
[+0s]   page navigation
[+t1]   first canvas pixel (Xvfb pre-paint)            (currently ~120 s)
[+t2]   wine virtual desktop visible (blue square)     (currently ~150 s)
[+t3]   AGS title rendered ("THE LIGHTHOUSE" + BEGIN)  (currently ~5 min)
```

A round-2 change is "successful" if t3 drops by ≥ 15 % relative to
the current shipped baseline. If t3 doesn't drop, the change isn't
worth keeping just because it sounded plausible.

## Out of scope for this plan

- Anything snapshot-based.
- Anything that replaces the QEMU+Wine stack with a native renderer.
- WebGPU offload — none of our hot paths are GPU-bound; wine renders
  via llvmpipe (CPU).
- HTTP/3 / Brotli for assets — already gzip; further compression is
  diminishing returns and Chrome lacks zstd in `DecompressionStream`.
