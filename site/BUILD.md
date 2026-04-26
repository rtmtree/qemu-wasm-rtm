# wineframe build pipeline

Three artifacts are produced by three independent Docker builds. All three
drop their outputs into `site/assets/` and `site/bridge/`. The site is
otherwise static — there is no Node build step for the shell itself.

```
site/
├── index.html / loader.js / runtime.js / style.css   # hand-written, committed
├── assets/
│   ├── qemu-system-x86_64.wasm        ← (1) QEMU-wasm
│   ├── qemu-system-x86_64.js
│   ├── qemu-system-x86_64.worker.js
│   └── base-image.img.gz              ← (2) Alpine + Wine64 rootfs
└── bridge/
    ├── worker.js                       # committed
    └── bridge.wasm                    ← (3) Go-on-WASI 9P + TCP stack
```

## 1 — QEMU-wasm (qemu-system-x86_64.{wasm,js,worker.js})

Builds the x86_64 full-system emulator with the Wasm TCG backend, from
**this repo** (ktock/qemu-wasm). Output is ~40 MiB, cacheable forever.

> **Upstream drift**: the repo root `Dockerfile` pins `ZLIB_VERSION=1.3.1`,
> which zlib.net has since removed (404). Override with `--build-arg
> ZLIB_VERSION=1.3.2`.

> **Read-only mount gotcha**: meson's `dtc` subproject fallback does a
> `git init dtc` inside the source tree. That fails on the `:ro` mount
> even though we pass `--without-default-features`. The fix is to copy
> the tree to a writable path (`/qemu-src`) before configuring.

```sh
# from repo root
docker build --build-arg ZLIB_VERSION=1.3.2 -t buildqemu - < Dockerfile
docker run -d --name build-qemu-wasm -v "$PWD":/qemu/:ro buildqemu sleep infinity
docker exec build-qemu-wasm bash -c 'rm -rf /qemu-src && cp -r /qemu /qemu-src'

EXTRA_CFLAGS="-O3 -g -Wno-error=unused-command-line-argument \
  -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE \
  -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM \
  -sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=2300MB -sWASM_BIGINT \
  -sMALLOC=mimalloc \
  --js-library=/build/node_modules/xterm-pty/emscripten-pty.js \
  -sEXPORT_ES6=1 -sASYNCIFY_IMPORTS=ffi_call_js"

docker exec -it build-qemu-wasm emconfigure /qemu-src/configure \
  --static --target-list=x86_64-softmmu --cpu=wasm32 --cross-prefix= \
  --without-default-features --enable-system --with-coroutine=fiber \
  --enable-virtfs \
  --extra-cflags="$EXTRA_CFLAGS" --extra-cxxflags="$EXTRA_CFLAGS" \
  --extra-ldflags="-sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,TTY,FS"

docker exec -it build-qemu-wasm emmake make -j "$(nproc)" qemu-system-x86_64

# export as .js / .wasm / .worker.js
docker cp build-qemu-wasm:/build/qemu-system-x86_64           site/assets/qemu-system-x86_64.js
docker cp build-qemu-wasm:/build/qemu-system-x86_64.wasm      site/assets/
docker cp build-qemu-wasm:/build/qemu-system-x86_64.worker.js site/assets/
```

## 2 — Alpine + Wine64 base image (base-image.img.gz)

Produces a raw disk image with a minimal Alpine x86_64 userland plus:

- `wine64` + `wine-gecko` + `wine-mono`  — 64-bit Windows PE runner
- `xvfb` + `xf86-video-dummy`            — virtual X server
- `mesa-dri-swrast` (llvmpipe)           — software GL for 3D-lite games
- 9P kernel module (built into `vmlinuz-virt`)
- `/sbin/init` = `build/base-image/init.sh` (see below)

Build (skeleton — the Dockerfile lives at `build/base-image/Dockerfile`):

```sh
mkdir -p site/assets
docker build --progress=plain --output type=local,dest=/tmp/wf-img/ \
  ./build/base-image/
gzip -9 < /tmp/wf-img/disk-rootfs.img > site/assets/base-image.img.gz

# Kernel + initramfs + PC BIOS come from the Alpine apkbuild path;
# file_packager.py packs them so Emscripten FS sees /pack-kernel/ etc.
cp /tmp/wf-img/vmlinuz-virt    site/assets/
cp /tmp/wf-img/initramfs-virt  site/assets/
```

Boot script `build/base-image/init.sh` parses `wf.app` / `wf.exe` from
`/proc/cmdline`, mounts the zip-backed 9P share at `/mnt/app`, then:

```sh
mount -t 9p -o trans=tcp,port=80 192.168.127.252 /mnt/app
mount -t 9p -o trans=tcp,port=80 192.168.127.254 /home/wine
Xvfb :0 -screen 0 1280x720x24 &
DISPLAY=:0 exec wine64 "/mnt/app/$(cat /proc/cmdline | sed -n 's/.*wf.exe=\([^ ]*\).*/\1/p')"
```

## 3 — Bridge (bridge.wasm — Go-on-WASI 9P + TCP stack)

Combines `containers/gvisor-tap-vsock` (userspace TCP) with
`hugelgupf/p9` (9P2000.L server). Sources live at `build/bridge/`.

```sh
cd build/bridge
GOOS=wasip1 GOARCH=wasm go build -o ../../site/bridge/bridge.wasm ./cmd/bridge
```

The bridge exposes two virtual 9P servers:

| Address                   | Backend                               | Mount        |
|---------------------------|---------------------------------------|--------------|
| `192.168.127.252:80`      | Zip blob staged by `loader.js`        | `/mnt/app`   |
| `192.168.127.254:80`      | `navigator.storage.getDirectory()`    | `/home/wine` |
| `192.168.127.253:80`      | HTTP(S) proxy via browser `fetch`     | (optional)   |

## End-to-end smoke test

```sh
# Serve and open in Safari (iOS 26+, Mac Safari 17+):
python3 site/serve.py
open http://127.0.0.1:8123/?app=DinoWalkSim&p=DinoWalkSim.exe
```

Expected timeline (MBP M-class, physical iPhone 15 Pro+):

| Stage                                   | Target   |
|-----------------------------------------|----------|
| fetch + parse zip                       | < 1 s    |
| WASM instantiation                      | 2–4 s    |
| Kernel boot → login                     | 30–60 s  |
| Wine prefix init (first run, cached)    | 10–20 s  |
| PE start → first frame                  | 5–30 s   |
