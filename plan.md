# Plan: 64-bit Windows-games-in-Safari with Boxedwine-style UX

Self-contained plan for a fresh session. Nothing here depends on prior chat context.

## Goal

Run **lightweight 64-bit Windows games in Safari on iPhone**, preserving the
Boxedwine user experience:

```
your-static-site/
├── index.html           # opens boxedwine-style: ?app=game&p=Game.exe
├── loader.js
├── qemu.wasm            # ~40 MB, cached forever
├── base-image.img.gz    # Alpine + Wine64 + Xvfb + llvmpipe, cached
└── games/
    ├── dino-walk.zip    # user drops zips here
    └── anything.zip
```

User opens `index.html?app=dino-walk&p=DinoWalkSim.exe` → game plays.

## What has already been validated (do not re-verify)

1. **CheerpX/WebVM** is 32-bit only today (per cheerpx-meta README).
2. **Boxedwine** itself is 32-bit x86 only. Architectural blocker for 64-bit.
3. **Blink (jart/blink)** x86_64 emulator compiles to WASM but is
   interpreter-only in-browser, has no `fork()`/threads/networking, Wine
   attempts crash at `VfsFcntl`. Wrong tool for games.
4. **box64 / FEX / felix86** have no WASM backends. Building one is a
   multi-person-year project.
5. **JSLinux (Bellard)** supports x86_64 but is closed-source and prohibits
   redistribution. Licensing dead end unless Bellard grants permission.
6. **ktock/qemu-wasm** — full-system QEMU with a Wasm TCG JIT backend. v3
   patchset (Sep 2025) supports x86_64 guests. Being upstreamed to QEMU.
   GPL-2.0.
   - **Tested live**: boots Alpine x86_64 to a login prompt **in Safari on
     iOS 26 Simulator (iPhone 17 Pro)**. Wall-clock ~40 s to login, kernel
     timestamp 34.99 s. 40 MB wasm + 1.2 MB rootfs loader.
   - Untested on real iPhone silicon — that's step 1 of this plan.
7. **ktock/container2wasm** — sister project, same author. Its
   `--external-bundle` mode bridges external filesystem content into a
   browser-hosted QEMU guest via **9P2000.L over TCP** (not virtio-9p).
   This is the mechanism to reuse for zip-drop UX.

## Architecture

```
┌─── Browser tab (Safari iOS 26+) ────────────────────────────────┐
│                                                                 │
│  Main thread                                                    │
│   ├── loader.js — reads ?app=X&p=Y.exe, fetches X.zip           │
│   ├── Canvas / WebGL (your new graphics bridge)                 │
│   ├── WebAudio / touch input bridges                            │
│   └── QEMU-wasm Emscripten module                               │
│          guest NIC → mock WebSocket → SharedArrayBuffer rings   │
│                                │                                │
│  Web Worker                    ▼                                │
│   └── Go WASI: userspace TCP stack (gvisor-tap-vsock)           │
│        ├── 192.168.127.252:80  → 9P server (zip-backed)         │
│        ├── 192.168.127.253:80  → HTTP(S) proxy (optional)       │
│        └── 192.168.127.254:80  → 9P server (OPFS overlay)       │
│                                                                 │
│  Guest (Alpine x86_64):                                         │
│     mount -t 9p 192.168.127.252 /mnt/app      # zip, read-only  │
│     mount -t 9p 192.168.127.254 /home         # OPFS, writable  │
│     init: DISPLAY=:0 exec wine64 /mnt/app/$P  # from cmdline    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Repos to clone

```bash
# Primary — the CPU+VM foundation
git clone https://github.com/ktock/qemu-wasm.git

# Reference — the filesystem bridge you'll adapt
git clone https://github.com/ktock/container2wasm.git

# Demo source (working reference site)
git clone https://github.com/ktock/qemu-wasm-demo.git

# Networking stack used by the bridge (read-only reference)
# https://github.com/containers/gvisor-tap-vsock
# 9P server library
# https://github.com/hugelgupf/p9
```

## Phased plan with go/no-go gates

### Phase 0 — Foundation and real-iPhone baseline (week 1)

**Goal**: prove the stack works on a physical iPhone; get the toolchain
running locally.

Tasks:
1. On your physical iPhone, open Safari →
   `https://ktock.github.io/qemu-wasm-demo/alpine-x86_64.html`.
   Wait for `demo login:` prompt. Log in as `root`. Record: