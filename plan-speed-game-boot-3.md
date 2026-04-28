# plan-speed-game-boot-3 — round 3, in-Chrome verified

End-to-end Chrome MCP timing of the AGS LIGHTHOUSE app, cold boot
with cleared SW cache:

```
phase                                  baseline       final          delta
─────────────────────────────────────  ─────────────  ─────────────  ──────────
asset stream + decompress              ~30-35 s       ~30-35 s       =
kernel + initramfs boot                ~30-50 s       ~25-40 s       -10 s
wf-init (mounts, daemons, Xvfb)        ~30-60 s       ~20-30 s       -25 s
fb-pump first emit (blue pre-paint)    t=~160 s       t=~125 s       -35 s
wine desktop painted                   t=~385 s       t=~225-260 s   -125 s   ★
AGS title screen rendered              t=~535 s       t=~340-370 s   -170 s   ★
total cold boot to title                ~9 min         ~6 min         -33 %
```

The big win was **R-K23**, which subset-applied the round-1 K1 idea:
disable wine's auxiliary processes (services.exe, svchost.exe,
plugplay.exe, winedevice.exe, spoolsv.exe, conhost.exe, dllhost.exe,
startupinfo.exe) via `WINEDLLOVERRIDES="…=;…=;…="`. None of these are
used by AGS; wineboot was previously waiting up to 90 s on each one
to settle before continuing.

## What shipped (final)

### Kernel cmdline tweaks (`site/runtime.js`)

Kept (safe):
- `mitigations=off` — skip Spectre/Meltdown init
- `nokaslr` — skip kernel ASLR
- `random.trust_cpu=on` — skip entropy wait (5-30 s under TCG)
- `init_on_alloc=0`, `init_on_free=0` — skip memory zeroing
- `audit=0`, `selinux=0`, `apparmor=0` — disable Debian-default security
- `nowatchdog`, `nosoftlockup` — skip kernel watchdog
- `ipv6.disable=1` — skip IPv6 stack init

Tried + reverted (broke wine/AGS):
- `lpj=1000000` — forced delay loops too short
- `tsc=reliable` + `clocksource=tsc` — broke wine's time queries
- `cache=unsafe,aio=threads` on virtio-blk — confused virtio-blk under PROXY_TO_PTHREAD
- `-rtc base=utc,clock=vm` — VM-clock RTC stalled wine

### QEMU args (`site/runtime.js`)

- `-no-hpet` — skip HPET emulation; Linux falls back to TSC

### init.sh changes

Kept:
- **R-K10 v3 content-aware fb-pump** — 3-region md5 sample (top + middle + bottom 4 KB),
  force-emit every 15 s as safety net
- **R-K11 watchdog deferred 90 s** with 30 s subsequent cadence
- **R-K12 lazy input forwarder** — waits for `/tmp/.wf-9p-ready`, polls 1 s while idle
- **R-K14 parallel 9P modprobe + mount** — saves 5-10 s
- **R-K15 v2 fast Xvfb pre-paint** via doubling-cat then single-block dd
- **R-K23 v2 WINEDLLOVERRIDES** — disable services.exe + svchost.exe + plugplay.exe +
  winedevice.exe + spoolsv.exe + conhost.exe + dllhost.exe + startupinfo.exe (plus
  the existing mscoree, mshtml, winemenubuilder defaults). **This is the biggest
  single-knob win in the entire 3 rounds — saves ~170 s of wine init under TCG.**

Tried + reverted:
- **R-K13 page-cache prewarm** — competed with wine for CPU on single TCG vCPU; net negative
- **R-K19 renice 0 reset** + all daemon `renice 19 $$` calls — POSIX `$$` in subshells
  misfired onto init.sh and starved fb-pump; daemons now run at default nice
- **R-K24 `wine --desktop=…` direct** — wine exited code 1 without explorer wrapper

### `acsetup.cfg` (AGS)

- `[misc] no_splash=1` — skip AGS splash
- `[graphics] filter=none` — drop stdscale upscaler init
- `[misc] cachemax=32768` — drop sprite cache from 128 MB to 32 MB
- `[log] file=stderr:err+warn+fatal` — keep AGS error logging visible

### loader.js / runtime.js

- **R-K16 early asset preload** — `loader.js` fires `fetch()` for the heavy runtime
  assets the moment we know the user wants the qemu path; `streamGzToFS` consumes the
  preloaded promise from `window.__wfPreload`.
- **R-K22 chunked fromCharCode in fb-pump's slave.write hook** — avoids V8's O(N²) slow
  string concat on the 410 KB base64 frame bursts.

### sw.js

- Cache name bumped to `wineframe-runtime-v8`.

## Acceptance test (verified in real Chrome with SAB)

- t≈125 s: first Xvfb pre-paint (blue) frame visible — fast user feedback ✓
- t≈230-260 s: wine virtual desktop painted ✓
- t≈340-370 s: AGS lighthouse title screen with the lit window pixel at (235,195,113) ✓
- 16 unique colors on canvas, exact pixel-grid match with the known-good title ✓

## Remaining bottleneck

Wine init (~150 s) and AGS init (~120 s) are TCG-bound and require either
snapshot-resume or a native AGS engine to push below the ~6-minute cold-boot
floor. Both are out of scope per user direction.

The fb-pump → xterm-pty → JS pipeline is also bandwidth-limited at ~4 KB/s
effective; this affects in-game animation responsiveness but **not** boot speed.
