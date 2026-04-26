// DinoWalkSim — a Chrome T-Rex style endless runner, native HTML5.
//
// This is the "native" implementation wineframe falls back to while the
// QEMU + Wine + 9P-bridge path is still being wired. It renders on the
// same #fb canvas the QEMU framebuffer will later write to, so the UX is
// continuous.

export function run({ canvas, log, onExit }) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width = 800;
  const H = canvas.height = 240;

  const state = {
    running: true,
    score:   0,
    best:    Number(localStorage.getItem("wf-dino-best") || 0),
    speed:   6,
    gravity: 0.6,
    groundY: H - 28,
    dino: { x: 50, y: 0, vy: 0, w: 44, h: 48, onGround: true, duck: false },
    obs:  [],
    clouds: [],
    frame: 0,
    dayNight: 0,
    gameOver: false,
  };

  state.dino.y = state.groundY - state.dino.h;

  log("[dino] native renderer loaded — press space / tap to jump");

  // Spawn initial clouds.
  for (let i = 0; i < 4; i++) {
    state.clouds.push({
      x: Math.random() * W,
      y: 20 + Math.random() * 80,
      w: 40 + Math.random() * 30,
    });
  }

  function jump() {
    if (state.gameOver) { reset(); return; }
    if (state.dino.onGround) {
      state.dino.vy = -12;
      state.dino.onGround = false;
    }
  }
  function duck(on) {
    if (state.gameOver) return;
    state.dino.duck = on;
  }
  function reset() {
    state.score = 0;
    state.speed = 6;
    state.obs.length = 0;
    state.gameOver = false;
    state.dino.y = state.groundY - state.dino.h;
    state.dino.vy = 0;
    state.dino.onGround = true;
  }

  // Input wiring.
  const onKey = (e) => {
    if (e.code === "Space" || e.code === "ArrowUp") { e.preventDefault(); jump(); }
    else if (e.code === "ArrowDown") { e.preventDefault(); duck(true); }
    else if (e.code === "Escape") { exit(); }
  };
  const onKeyUp = (e) => {
    if (e.code === "ArrowDown") duck(false);
  };
  const onPointer = (e) => { e.preventDefault(); jump(); };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("pointerdown", onPointer);

  function exit() {
    state.running = false;
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKeyUp);
    canvas.removeEventListener("pointerdown", onPointer);
    onExit?.();
  }

  function spawnObstacle() {
    const kinds = [
      { w: 20, h: 40, type: "cactus-s" },
      { w: 40, h: 40, type: "cactus-m" },
      { w: 60, h: 40, type: "cactus-l" },
    ];
    if (state.score > 300) kinds.push({ w: 46, h: 32, type: "bird", fly: true });
    const k = kinds[Math.floor(Math.random() * kinds.length)];
    state.obs.push({
      x: W + 40,
      y: k.fly ? state.groundY - 70 - Math.random() * 30 : state.groundY - k.h,
      ...k,
    });
  }

  function step() {
    if (!state.running) return;
    state.frame++;

    // Score + speed ramp.
    if (!state.gameOver) {
      state.score++;
      if (state.frame % 300 === 0) state.speed += 0.4;
      // day/night flip every ~700 score
      state.dayNight = Math.floor(state.score / 700) % 2;
    }

    // Physics.
    const d = state.dino;
    d.vy += state.gravity;
    d.y  += d.vy;
    if (d.y + d.h >= state.groundY) {
      d.y = state.groundY - d.h;
      d.vy = 0;
      d.onGround = true;
    }

    // Obstacles.
    if (!state.gameOver) {
      if (state.obs.length === 0 || state.obs[state.obs.length - 1].x < W - 220 - Math.random() * 260) {
        spawnObstacle();
      }
      for (const o of state.obs) o.x -= state.speed;
      while (state.obs.length && state.obs[0].x + state.obs[0].w < 0) state.obs.shift();

      // Collision.
      const dBox = { x: d.x + 4, y: d.y + (d.duck ? 24 : 4), w: d.w - 8, h: (d.duck ? 22 : d.h - 8) };
      for (const o of state.obs) {
        if (dBox.x < o.x + o.w && dBox.x + dBox.w > o.x &&
            dBox.y < o.y + o.h && dBox.y + dBox.h > o.y) {
          state.gameOver = true;
          if (state.score > state.best) {
            state.best = state.score;
            localStorage.setItem("wf-dino-best", String(state.best));
          }
          log(`[dino] game over — score ${state.score}`);
        }
      }
    }

    // Clouds drift.
    for (const c of state.clouds) {
      c.x -= state.speed * 0.3;
      if (c.x + c.w < 0) {
        c.x = W + Math.random() * 100;
        c.y = 20 + Math.random() * 80;
        c.w = 40 + Math.random() * 30;
      }
    }

    render();
    requestAnimationFrame(step);
  }

  function render() {
    const night = state.dayNight === 1;
    ctx.fillStyle = night ? "#0b0d10" : "#f7f7f7";
    ctx.fillRect(0, 0, W, H);

    // Clouds.
    ctx.fillStyle = night ? "#1e2431" : "#bfc4ca";
    for (const c of state.clouds) {
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, c.w / 2, c.w / 5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Ground line + dashes.
    ctx.strokeStyle = night ? "#6a7380" : "#2d3034";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, state.groundY);
    ctx.lineTo(W, state.groundY);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    for (let i = 0; i < W; i += 48) {
      const off = (state.frame * state.speed) % 48;
      ctx.fillRect(i - off, state.groundY + 6, 12, 2);
      ctx.fillRect(i - off + 24, state.groundY + 12, 8, 2);
    }

    // Dino.
    drawDino(ctx, state.dino, state.frame, night);

    // Obstacles.
    for (const o of state.obs) drawObstacle(ctx, o, state.frame, night);

    // HUD.
    ctx.fillStyle = night ? "#e6e8eb" : "#2d3034";
    ctx.font = "bold 14px ui-monospace, Menlo, monospace";
    ctx.textAlign = "right";
    ctx.fillText(`HI ${pad(state.best)}  ${pad(Math.floor(state.score / 2))}`, W - 12, 22);

    if (state.gameOver) {
      ctx.textAlign = "center";
      ctx.font = "bold 22px ui-monospace, Menlo, monospace";
      ctx.fillText("G A M E   O V E R", W / 2, H / 2 - 8);
      ctx.font = "12px ui-monospace, Menlo, monospace";
      ctx.fillText("press space / tap to restart", W / 2, H / 2 + 14);
    }
  }

  function pad(n) { return String(n).padStart(5, "0"); }

  step();
  return { stop: exit };
}

function drawDino(ctx, d, frame, night) {
  const fg = night ? "#e6e8eb" : "#2d3034";
  ctx.fillStyle = fg;
  const legPhase = Math.floor(frame / 6) % 2;
  const x = d.x, y = d.y, W = d.w, H = d.h;
  // Body
  ctx.fillRect(x + 14, y + 12, 24, 20);
  // Head
  ctx.fillRect(x + 30, y + 4,  14, 14);
  ctx.fillRect(x + 38, y + 10, 4, 4); // jaw
  // Eye (hollow)
  ctx.fillStyle = night ? "#0b0d10" : "#f7f7f7";
  ctx.fillRect(x + 36, y + 8, 2, 2);
  ctx.fillStyle = fg;
  // Tail
  ctx.fillRect(x + 6, y + 14, 10, 8);
  ctx.fillRect(x + 0, y + 18, 8, 4);
  // Arms
  ctx.fillRect(x + 30, y + 28, 6, 3);
  // Legs (animated when on ground)
  if (d.onGround) {
    if (legPhase === 0) {
      ctx.fillRect(x + 18, y + 32, 6, 12);
      ctx.fillRect(x + 28, y + 32, 6, 8);
    } else {
      ctx.fillRect(x + 18, y + 32, 6, 8);
      ctx.fillRect(x + 28, y + 32, 6, 12);
    }
  } else {
    ctx.fillRect(x + 18, y + 32, 6, 10);
    ctx.fillRect(x + 28, y + 32, 6, 10);
  }
}

function drawObstacle(ctx, o, frame, night) {
  const fg = night ? "#e6e8eb" : "#2d3034";
  ctx.fillStyle = fg;
  if (o.type && o.type.startsWith("cactus")) {
    ctx.fillRect(o.x + o.w / 2 - 4, o.y, 8, o.h);
    ctx.fillRect(o.x + 0, o.y + 8,  6, o.h / 2);
    ctx.fillRect(o.x + o.w - 6, o.y + 12, 6, o.h / 2 - 4);
  } else if (o.type === "bird") {
    const flap = Math.floor(frame / 8) % 2;
    ctx.fillRect(o.x + 10, o.y + 10, 26, 8);
    ctx.fillRect(o.x + 2,  o.y + 10, 10, 4);
    if (flap === 0) {
      ctx.fillRect(o.x + 12, o.y, 20, 6);
    } else {
      ctx.fillRect(o.x + 12, o.y + 16, 20, 6);
    }
  }
}
