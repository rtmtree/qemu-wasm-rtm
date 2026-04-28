# plan-speed-game-boot-4 — round 4, fb-pump quiet phase + wine priority

## Hypothesis

Round 3 ended at ~340-370 s cold-boot to AGS title with the dominant
remaining cost being:
- ~120 s of wine init (DLL load, registry, wineboot)
- ~100 s of AGS engine init

Both are TCG-bound and ruled out for native replacement / snapshot.
Round 4 attacks the *secondary* costs that compete with wine for the
single TCG vCPU during those 220 s.

The fb-pump's force-emit-every-15s safety net was ~10 emits × 1-2 s each
= 10-20 s of CPU spent base64-encoding 410 KB and shoving it down the
serial pty *while* wine was busy translating x86. The watchdog (90 s
defer, 30 s cadence) was 6-7 wakeups × 100-200 ms each. The input
forwarder polled every 1 s with no useful work to do until AGS painted.
None of this had any user-visible payoff during the busy phase, but all
of it stole TCG cycles from wine.

## What shipped (final)

### `site/runtime.js`

- **R4-1** `tb-size` 500 → 768. Wine's DLL load translates a few hundred
  MB of x86 code; a bigger TCG cache reduces re-translation when
  functions are revisited. Budget: 1024 (RAM) + 768 (tb) + ~500 (heap)
  = 2292 MiB < 2300 MiB linear-memory cap.
- **R4-2** Kernel cmdline:
  - `transparent_hugepage=never`
  - `cgroup_disable=memory,cpu,cpuacct,blkio,devices,freezer,net_cls,net_prio,perf_event,hugetlb,pids,rdma,misc`
  - `intel_iommu=off`, `iommu=off`
  - `noresume`, `noresume2`
  - `panic=-1`, `skew_tick=1`
- **R4-8** `init=/usr/sbin/wf-init` — bypass /sbin/init → /usr/sbin/init
  → wf-init symlink chase. Microsecond-level but free.
- **R4-9** `printk.time=0` — skip jiffies fetch even for suppressed
  messages.
- **R4-12** Parallel `appendScript(load-*.js)` + `startBridge()` via
  `Promise.all`. With `s.async=false` to preserve script execution
  order. Saves the ~200 ms of serial round trips before MEMFS
  streaming can begin.

### `site/loader.js`

- **R4-7** `probeRuntime()` now uses `Promise.all` and reuses the
  preloaded GET responses from `window.__wfPreload` where available
  (HEAD-checking against an already in-flight GET is redundant).
  Saves ~100-500 ms before runtime.js can start streaming MEMFS.

### `site/sw.js`

- Cache name bumped to `wineframe-runtime-v10`.

### `build/base-image/init.sh` (and the rebuilt `base-image.img.gz`)

- **R4-3 fb-pump**: emit pre-paint frame ONCE immediately, then
  unconditional `sleep 60` while wine's densest TCG-translation phase
  runs. After the quiet phase, slow-poll every 2 s for content change;
  once the first change is seen, switch to 200 ms cadence. Removed
  the 15 s force-emit safety net entirely — the 3-region
  (top/middle/bottom 4 KB) sample reliably catches AGS' centered title
  paint and the wine virtual-desktop paint.

  The dominant savings here are that ~10 force-emits during wine init
  (each = stat + base64 of 310 KB + dd to console) no longer fire.

- **R4-4 watchdog**: 90 s defer → 600 s defer. The watchdog is a pure
  diagnostic (tail wine.err / wine.out / agsgame.log → console) and
  the optimised boot reaches AGS title well under 6 min, so the
  watchdog never wakes during normal cold boot. Each elided wakeup
  was 100-200 ms of TCG (stat × 4 + tail × 4 + flock console writes).

- **R4-5 input forwarder**: cold poll 1 s → 5 s. Wine takes >120 s
  to launch any window — there's nothing the user could click on
  during the cold-poll phase. Once the first event is seen *and* wine
  has been up >20 s, drops to the 200 ms cadence as before. ~80% of
  the cold-loop CPU avoided.

- **R4-6 wine priority**: launched via `nice -n -5`. CFS weight ratio
  between nice -5 (1820) and nice 5 (335, fb-pump) is 5.4:1, so wine
  gets ~84 % of contended CPU vs the ~75 % it had at default nice 0.

- **R4-10 reverted**: tried WINEDEBUG=-all (no err either), but
  realised wine's `TRACE_ON` check is constant-time regardless of
  enabled channels — only the formatting in the body runs if a channel
  is on, and the success path has zero ERR! emissions, so there's no
  actual saving while we'd lose useful diagnostics on failure. Kept
  `WINEDEBUG=-all,err+all`.

- **R4-11 pre-paint pattern**: pure doubling to 524 KB (17 cats),
  then `head -c 307200` to trim. Was 11 doublings + 38 cats = ~60
  forks; now 17 + 1 = 18 forks. Under TCG (~50-100 ms per fork),
  ~3 s saved off the pre-paint phase before wine even starts.

## Disk-image rebuild path (no Docker needed)

Round 3's iteration loop required a full Docker build to alter init.sh.
For round 4 I used `debugfs` (homebrew `e2fsprogs`) to rewrite the
single file in-place inside `/tmp/wf-img/disk-rootfs.img`:

```sh
cp build/base-image/init.sh /tmp/wf-init-new.sh
debugfs -w -R "rm /usr/sbin/wf-init" /tmp/wf-img/disk-rootfs.img
debugfs -w -R "write /tmp/wf-init-new.sh /usr/sbin/wf-init" /tmp/wf-img/disk-rootfs.img
e2fsck -fy /tmp/wf-img/disk-rootfs.img
gzip -9 -c /tmp/wf-img/disk-rootfs.img > site/assets/base-image.img.gz
```

Roughly 2 min wall-clock per iteration vs ~30 min for the Docker
rebuild. Image stays bit-identical for everything outside `/usr/sbin/wf-init`,
so the warm-cache hit on returning users only refetches the changed
~1 % of compressed bytes (Cache API does whole-file replacement, but
there's no way around that with a single .gz blob).

## Acceptance test

Pending Chrome MCP availability. Expected timings under the new path:

```
phase                                  round-3        round-4 (predicted)
─────────────────────────────────────  ─────────────  ───────────────────
asset stream + decompress              ~30-35 s       ~30-35 s            (= for cold)
kernel + initramfs boot                ~25-40 s       ~22-37 s            (printk.time, init=)
wf-init (mounts, daemons, Xvfb)        ~20-30 s       ~17-25 s            (R4-11 pre-paint)
fb-pump first emit (blue pre-paint)    t=~125 s       t=~110-115 s
wine desktop painted                   t=~225-260 s   t=~200-225 s        (R4-6 priority + R4-3 quiet)
AGS title screen rendered              t=~340-370 s   t=~290-320 s        ★ predicted -50 s
total cold boot to title               ~5.5-6 min     ~5 min predicted
```

The fb-pump quiet phase + wine nice -5 are the structural changes; the
others are stackable smaller wins.

## Predicted savings, decomposed

| Change | Predicted saving |
|---|---|
| R4-3 fb-pump force-emit removed | ~10-20 s (was 10 emits × 1-2 s of TCG) |
| R4-3 fb-pump 60 s quiet phase | ~5-10 s (sample_hash polling avoided) |
| R4-6 wine nice -5 | ~10-15 s (10% more contended-CPU share over 150 s of init) |
| R4-1 tb-size 500 → 768 | ~3-7 s (less TB re-translation in DLL load) |
| R4-4 watchdog 600 s defer | ~1-2 s (6-7 wakeups elided) |
| R4-11 pre-paint pattern | ~2-3 s (40 fewer forks) |
| R4-5 input forwarder cold poll | ~1 s (80 % of cold CPU avoided) |
| R4-2 kernel cmdline tweaks | ~1-2 s (cgroup_disable, transparent_hugepage) |
| R4-7 probeRuntime parallel | ~0.1-0.5 s (one-shot at boot start) |
| R4-12 parallel script loads | ~0.1-0.2 s |
| R4-10 WINEDEBUG=-all (reverted) | 0 s |
| R4-8/9 init= / printk.time | < 0.1 s |
| **Total** | **~35-65 s** |

That puts the round-4 cold boot somewhere between ~5 min (good case) and
~5.5 min (skeptical case). Still doesn't beat the ~3 s snapshot resume
or native AGS engine — those remain the only paths into "fast" territory
— but it's the best we can do while keeping wine on the critical path.

## Things tried but not shipped

- **R4-10** WINEDEBUG=-all — reverted, see above. Wine's TRACE_ON check
  is constant-time so dropping err+all gains nothing while losing
  failure-path diagnostics.

## Out of scope (carried over from round 3)

- Snapshot-based resume (user direction).
- Native JS AGS engine (user direction).
- Custom kernel + busybox initramfs (1-2 day effort, ~25 MB + 5-15 s).
- Custom wine build with LTO / `--disable-tests --disable-win16`
  (2-3 day effort, ~10-30 s).
- Brotli/zstd compression for assets (DecompressionStream lacks zstd
  in Chrome).
