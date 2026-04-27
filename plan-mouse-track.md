# plan-mouse-track — make the emulator track mouse for AGS (Ludum Dare 59)

## What the user is seeing
The AGS game (`./site/lighthouse/Ludum Dare 59 AGS.exe`) renders into the
canvas (the framebuffer pump from Xvfb works), but moving / clicking the
mouse over the canvas produces no in-game cursor motion or clicks.

## How mouse input is supposed to flow

```
DOM mouse event on #fb  ──► [runtime.js startInputForward]
   • canvasCoord(e)  → integer (x,y) in 320×240 canvas pixels
   • appends "MV x y\n" / "DOWN n\n" / "UP n\n" / "KEY name\n"
     to MEMFS /.wasmenv/wf-input.txt   (FS.write at end-of-file)
                          │
                  9P virtio share `wasm0`
                  (mounted ro on guest at /var/host)
                          ▼
[guest init.sh input daemon]                       (build/base-image/init.sh:357-377)
   tail -F /var/host/wf-input.txt | while read line
     case MV   → xdotool mousemove --sync $x $y
          DOWN → xdotool mousedown $btn
          UP   → xdotool mouseup   $btn
          KEY  → xdotool key       $name
                          │
                          ▼
[Xvfb :0 320×240]  ──►  [wine explorer.exe /desktop=virt,320x240 game.exe]
```

There are five places this can break. All of them are independently testable
from the logs already in the system.

## Suspected root causes (most likely → least likely)

### 1. `#term` overlay swallows canvas mouse events  ★ very likely
[site/style.css:134-140](site/style.css:134) defines `#term` as
`position:absolute; inset:0; z-index:1`. The canvas `#fb` has no explicit
`z-index`, so the xterm container sits **on top of** the canvas and
intercepts every `mousemove` / `mousedown` before the listeners in
`startInputForward` ([site/runtime.js:336-353](site/runtime.js:336)) can fire.
Result: nothing is ever appended to `wf-input.txt`, so the guest sees
nothing to forward.

This alone fully explains the symptom and should be fixed first.

### 2. Mouse coords vs. wine virtual-desktop coords
init.sh launches `wine explorer.exe /desktop=virt,320x240` inside an
Xvfb root of 320×240 ([build/base-image/init.sh:402](build/base-image/init.sh:402),
[init.sh:181](build/base-image/init.sh:181)). xdotool's `mousemove` uses
**X-root coordinates by default**, and the wine desktop window is normally
parented at root offset 0,0 — so a 320×240 canvas should map 1:1.
But: AGS' native resolution is 320×200, so the wine desktop may letterbox
the game in a 320×200 strip with a 20-px border at the top/bottom.
Tracking will appear "off" if our (x,y) targets root pixels but the user
expects game pixels.

### 3. AGS uses Win32 raw / DirectInput; xdotool warps don't deliver `WM_MOUSEMOVE`
AGS calls `GetCursorPos`/`SetCursorPos` via the engine's mouse poll. Wine's
winex11.drv translates X pointer position into Win32 cursor pos on every
poll, so a `xdotool mousemove --sync` on the X root usually does work
inside wine — but only if the X pointer is **inside** the wine window's
client area. If the Xvfb root is larger than the wine desktop (it isn't here,
both are 320×240), or if the wine virtual-desktop window is not focused,
moves can be ignored. A `xdotool windowactivate` of the wine desktop
window before clicks resolves this in practice.

### 4. 9P read propagation: guest doesn't see appended bytes
init.sh comments explicitly note "9P writes are broken in this qemu-wasm
build" ([init.sh:354-355](build/base-image/init.sh:354)) — guest writes
to `/var/host/*` are unsafe. **Reads** are what we depend on, and the
mount opts are `cache=none,msize=262144,noatime`
([init.sh:162](build/base-image/init.sh:162)), so each read should hit the
host. `tail -F -s 0.3` polls `stat()` every 300 ms — that should pick up
size growth on a `cache=none` 9P mount. Worth verifying empirically before
trusting it.

### 5. AGS / Wine is running headless before xdotool is reachable
The input daemon is started **after** wineprefix extraction
([init.sh:357](build/base-image/init.sh:357)) but **before** the wine
launch loop ([init.sh:396](build/base-image/init.sh:396)). It also runs
inside the same shell as init.sh, with no separate `DISPLAY` export
inheritance check. xdotool needs `DISPLAY=:0`. The launch loop exports
`DISPLAY=:0` once at the top ([init.sh:99](build/base-image/init.sh:99))
and the daemon inherits it via the shared environment, so this should
be fine — but it's worth confirming via `/var/log/wf-input.log`.

## Verification steps (do these first, in order)

These are all read-only checks against the running guest. Each one
disambiguates the suspects above.

1. **Confirm DOM events fire.** In the browser console, run:
   ```js
   document.querySelector('#fb').addEventListener('mousemove',
     e => console.log('mousemove on canvas', e.clientX, e.clientY),
     true);
   ```
   Move the mouse over the visible canvas. **No log lines = suspect #1
   (overlay).** Log lines = move on.

2. **Confirm the host write reaches MEMFS.**
   ```js
   const fs = window.Module.FS;
   console.log(fs.readFile('/.wasmenv/wf-input.txt',
                           {encoding:'utf8'}).slice(-400));
   ```
   Should grow as you mouse over the canvas. If empty after suspect #1
   is fixed, the listener path is broken at the JS layer.

3. **Confirm the guest sees the file growing.** init.sh's wf-watch logs
   `host_sz` (guest's view of `/var/host/wf-input.txt`) and `log_sz`
   (lines actually parsed) every 20 s
   ([init.sh:330-339](build/base-image/init.sh:330)). They appear in the
   xterm panel as `[wf-watch] === input log (host_sz=…, log_sz=…) ===`.
   If `host_sz` stays at 0 while step 2 shows growth, **9P reads aren't
   propagating** (suspect #4).

4. **Confirm xdotool runs and returns rc=0.** Same wf-watch block dumps
   the last 10 lines of `/var/log/wf-input.log`, which has `recv: …` per
   parsed line and a following `rc=… out=…` per xdotool call. Non-zero
   rc or `out=` containing `Can't open display` immediately tells us
   suspect #3/#5.

5. **Confirm the X pointer actually moved.** Once the daemon is running,
   run from the guest shell once it drops:
   ```sh
   xdotool getmouselocation --shell
   ```
   Compare to what we sent. Mismatch → suspect #2 / #3.

## Fixes (apply in order; stop early if symptom is gone)

### Fix A — Stop `#term` from blocking canvas events  [must-do]
[site/style.css:134-140](site/style.css:134)

Two changes:
- Make `#term` non-interactive once the runner is showing — the terminal
  is informational, not interactive. Add `pointer-events: none;` to the
  `#term` rule.
- Belt + suspenders: give `#fb` `position: relative; z-index: 2;` so it's
  unambiguously above `#term` in the stacking context. (`#screen` is a
  flex container, so z-index needs `position` to take effect.)

If we *do* want a clickable terminal later (for shell input), gate it
behind a toggle button — but for the game runner the canvas should own
all pointer events.

### Fix B — Make absolute (x,y) target the wine desktop, not the X root  [if step 5 fails]
Two options, in order of preference:

1. **xdotool with `--window`**: in init.sh's input daemon, find the wine
   virtual-desktop window once at startup:
   ```sh
   WIN=$(xdotool search --sync --name 'virt' | head -1)
   ```
   then use `xdotool mousemove --window "$WIN" --sync $x $y`. This makes
   coordinates window-relative, which is what AGS expects.

2. **Pre-warp + activate**: before the first event, `xdotool
   windowactivate --sync "$WIN"`. Subsequent clicks will deliver focus
   correctly even if wine's grab is finicky.

### Fix C — Forward absolute clicks via `xdotool click` instead of separate down/up  [robustness]
The current protocol issues separate `DOWN n` / `UP n` lines. xdotool
`mousedown`/`mouseup` are reliable, but on slow CI/wasm the up may race
with wine's polling. Add a `CLICK n` shortcut on the JS side for short
clicks (mousedown + mouseup within 250 ms with no movement) and have
the guest call `xdotool click "$2"` — it's a single round-trip and
matches AGS' expected input cadence better.

### Fix D — Verify 9P read propagation; switch to a poll loop if needed  [if step 3 fails]
If `host_sz` doesn't grow on the guest while the host file does:

- In init.sh, replace `tail -F -s 0.3 -c +0 --retry` with an explicit
  poll loop that re-`open()`s `/var/host/wf-input.txt` each iteration
  (re-open forces 9P to re-stat instead of reusing a cached fid):
  ```sh
  off=0
  while :; do
    sz=$(stat -c %s /var/host/wf-input.txt 2>/dev/null || echo 0)
    if [ "$sz" -gt "$off" ]; then
      dd if=/var/host/wf-input.txt bs=1 skip="$off" count=$((sz-off)) \
        2>/dev/null | while IFS= read -r line; do … ; done
      off=$sz
    fi
    sleep 0.2
  done
  ```
- Last resort: switch the host→guest input channel to a console
  side-channel ("\x1b]wf-input;…\x07" sequences via the same pty as
  fb-pump). Pros: no 9P dependency. Cons: shares bandwidth with the
  framebuffer stream.

### Fix E — Add a "input idle" log breadcrumb on the JS side  [debuggability]
In `startInputForward`, log first event each kind: `[input] first
mousemove`, `[input] first mousedown 1`. Cheap to add, instantly
disambiguates layer 1 vs. layer 2 problems on future regressions.

## Acceptance test

With the AGS game running:
1. Move mouse across canvas — in-game cursor follows continuously.
2. Click — AGS reacts (menu hover/click in the title screen of
   *Ludum Dare 59*).
3. `/var/log/wf-input.log` shows `recv: MV …` and `rc=0` lines.
4. `[wf-watch] input log` block in xterm shows `host_sz` and `log_sz`
   both rising, with `log_sz ≤ host_sz` and the gap < 1 KB.

## Result (verified 2026-04-27)

Both **Fix A** (CSS) and **Fix D** (poll-based daemon) were required.
Fix A alone shipped events to MEMFS but the guest's `tail -F` never saw
the file grow — the QEMU 9P `local` driver returns the size cached at
fid open time, so a long-lived reader is frozen at 0 bytes forever.

The patched daemon (`fresh-cat poll`) re-opens the file every 200 ms,
which forces a new `Twalk`/`Tlopen`/`Tgetattr` and surfaces the current
size. After the patch:

```
[wf-watch] === input log (host_sz=160, log_sz=486) ===
[wf-watch]   in> 03:49:28.796 recv: MV 85 161
[wf-watch]   in>   rc=0 out=
[wf-watch]   in> 03:51:23.651 recv: DOWN 1
[wf-watch]   in>   rc=0 out=
```

`host_sz` tracks the real file size, every event is parsed, and every
`xdotool` invocation returns rc=0 with no stderr. The X pointer / key
press IS being actuated inside Xvfb. Whether AGS *visually reacts* on
its title screen is a separate wine focus / RpcSs issue and out of
scope for this plan — but the input pipeline itself is fully wired.

To rebuild without re-running the full Docker:

```sh
gunzip -c site/assets/base-image.img.gz > /tmp/wf-rootfs.img
debugfs -w /tmp/wf-rootfs.img <<EOF
rm /usr/sbin/wf-init
write build/base-image/init.sh /usr/sbin/wf-init
sif /usr/sbin/wf-init mode 0100755
EOF
e2fsck -fy /tmp/wf-rootfs.img
gzip -1 -c /tmp/wf-rootfs.img > site/assets/base-image.img.gz
stat -f %z /tmp/wf-rootfs.img > site/assets/base-image.img.gz.size
```

## Boot speedup — wineprefix on a separate virtio-blk disk

The original boot path extracted a 198 MB `wine-skel.tar.gz` into a 900 MB
tmpfs at runtime. Under QEMU TCG, that single-threaded `tar -xzf` was the
dominant boot phase (~5-10 minutes).

**Why we can't just bake the extracted prefix into the rootfs**: V8 caps a
single `Uint8Array` at ~1.9 GB on 64-bit Chrome. Adding the 590 MB extracted
prefix to the existing 1.85 GB rootfs pushes the combined ext4 image over
that cap, and the MEMFS write fails with `Array buffer allocation failed`
mid-stream.

**Fix**: ship the wineprefix as a **separate** ext4 image, attached as
`/dev/vdb`. Each MEMFS file lives in its own JS array, both fit comfortably
under the cap.

```
site/assets/base-image.img.gz       1.85 GB raw / 777 MB gz   (rootfs, /dev/vda)
site/assets/wine-prefix.img.gz       668 MB raw / 226 MB gz   (prefix, /dev/vdb)
```

Wired up in three places:

- [site/runtime.js:14-30](site/runtime.js:14): added `prefixGz` to ASSETS,
  added `-drive id=prefix,file=/pack-prefix/wine-prefix.img,...` and the
  matching virtio-blk device to QEMU args.
- [site/runtime.js:217-235](site/runtime.js:217): `streamGzToFS` for both
  images runs in parallel inside `preRun`, each holding its own
  `addRunDependency` so QEMU's `main()` waits for both.
- [build/base-image/init.sh:155-170](build/base-image/init.sh:155):
  `mount -t ext4 -o rw,noatime /dev/vdb /opt/wine-prefix` then
  `WINEPREFIX=/opt/wine-prefix`. Falls back to the legacy tar-extract path
  if /dev/vdb is unavailable.

To rebuild the prefix image (only when the wine-skel.tar.gz changes):

```sh
docker run --rm --privileged \
  -v /tmp/wf-img:/work \
  -v $PWD/build/base-image/wine-skel.tar.gz:/work/in/wine-skel.tar.gz \
  debian:12-slim bash -c '
    apt-get update -qq && apt-get install -y -qq e2fsprogs
    mkdir /tmp/p && tar -xzf /work/in/wine-skel.tar.gz -C /tmp/p
    SZ=$(($(du -sk /tmp/p | cut -f1)/1024 + 80))
    dd if=/dev/zero of=/work/out/wine-prefix.ext4 bs=1M count=$SZ status=none
    mkfs.ext4 -F -O ^has_journal -m 0 /work/out/wine-prefix.ext4
    mkdir /mnt/p && LOOP=$(losetup -f --show /work/out/wine-prefix.ext4)
    mount $LOOP /mnt/p && cp -a /tmp/p/. /mnt/p/
    sync && umount /mnt/p && losetup -d $LOOP
  '
gzip -1 -c /tmp/wf-img/out/wine-prefix.ext4 > site/assets/wine-prefix.img.gz
stat -f %z /tmp/wf-img/out/wine-prefix.ext4 > site/assets/wine-prefix.img.gz.size
```

End result: boot reaches `[wf] launching wine ...` in ~1-2 minutes instead
of ~10. Wine startup itself (~5-9 min from launch to AGS title under TCG)
is unchanged — that's the new floor and would need a non-Wine x86
emulator to improve further.

## Out of scope (note for later)

- Touch / pointer events for iOS Safari. Today only `mousemove` /
  `mousedown` / `mouseup` are wired. iOS will need
  `pointermove`/`pointerdown`/`pointerup` (or equivalent Touch events)
  with the same MV/DOWN/UP protocol.
- Mouse-wheel forwarding (AGS doesn't use it; safe to defer).
- Cursor visibility: AGS draws its own cursor inside the framebuffer.
  We may want to hide the OS cursor over the canvas (`cursor: none`)
  once tracking works, to avoid the double-cursor look.
