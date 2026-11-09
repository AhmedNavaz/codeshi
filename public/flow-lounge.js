(() => {
  "use strict";
  // Flow Lounge (#14): Play and relax while agents work.
  // - Fullscreen ambient weather canvas (Rain, Snow, Clear) physically interacting with UI cards and panels.
  // - Left Rail: one activity at a time (Breakout, Snake, Trivia or Typing), chosen from a picker.
  // - Right Rail: the calm, always-on things: Ambient Weather controls and Developer Wisdom quotes.
  // - Games start only on click/interaction; keys reach only the game whose card holds focus.
  // - Subdued, readable central view (.main-panel).
  // - Auto-recedes when approvals or agent attention is needed.

  const $ = id => document.getElementById(id), api = window.relayUI, shell = $("app-shell");
  const toggle = $("toggle-flow-lounge");
  const left = $("flow-left"), right = $("flow-right");
  const loungeLeft = $("flow-lounge-left"), loungeRight = $("flow-lounge-right");

  if (!api || !shell || !toggle || !loungeLeft || !loungeRight) return;
  toggle.setAttribute("aria-pressed", "false");

  const safeClearInterval = id => { if (typeof clearInterval === "function") try { clearInterval(id); } catch {} };
  const safeCancelAnim = id => { if (typeof cancelAnimationFrame === "function") try { cancelAnimationFrame(id); } catch {} };
  const safeSetInterval = (fn, ms) => typeof setInterval === "function" ? setInterval(fn, ms) : null;
  const safeRequestAnim = fn => typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : null;
  const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  const button = (cls, text, handler) => { const el = node("button", cls, text); el.type = "button"; if (handler) el.addEventListener("click", handler); return el; };

  let active = false;
  let wanted = false;
  let receded = false;
  let lastRunning = false;

  const BREAKOUT_READY = "Ready · Start Game, or click the board and press Space";
  const SNAKE_READY = "Ready · Start Game, or click the board and use the arrow keys";

  // ==========================================
  // 1. FULL-SCREEN AMBIENT WEATHER SIMULATION
  // ==========================================
  let weatherCanvas = null;
  let weatherCtx = null;
  let weatherAnimId = null;
  let weatherMode = "clear"; // "rain" | "snow" | "clear"
  let rainDrops = [];
  let rainSplashes = [];
  let rainRipples = [];
  let snowFlakes = [];
  let settledSnow = [];
  let snowClumps = [];
  let cachedObstacles = [];
  let lastObstacleUpdate = 0;
  // Weather is ambient, so it is drawn at most 30 times a second. Its motion is set in steps of a 60 Hz frame: each
  // drawn frame runs the steps for the time that has passed and draws the last, so a 120 Hz display neither speeds
  // the weather up nor draws it more often.
  const WEATHER_FRAME_MS = 1000 / 30, WEATHER_STEP_MS = 1000 / 60;
  let lastWeatherFrame = null, weatherLag = 0;
  const reducedMotion = () => Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);

  function updateObstacleRects() {
    const rects = [];
    const elementRects = new Map();
    try {
      const selectors = [
        // Center panel: user prompts, agent bubbles, code blocks, composer
        ".message-user .message-text",
        ".message-assistant .message-text",
        ".message-prompt",
        ".code-block",
        ".composer-input",
        ".starter-prompts button",
        // Standard Flow cards and their buttons, so weather lands on them outside the Lounge too
        "#flow-left .flow-card",
        "#flow-right .flow-card",
        "#flow-left .flow-card-head",
        "#flow-right .flow-card-head",
        "#flow-left .flow-button",
        "#flow-right .flow-button",
        "#flow-left .flow-step",
        "#flow-right .flow-plan",
        // Lounge cards: interactive controls and content blocks
        ".flow-lounge-game-canvas",
        ".flow-lounge-score-pill",
        ".flow-lounge-trivia-q",
        ".flow-lounge-trivia-opt",
        ".flow-lounge-trivia-meta",
        ".flow-lounge-trivia-feedback",
        ".flow-lounge-quote-card",
        ".flow-lounge-quote-text",
        ".flow-lounge-typing-snippet",
        ".flow-lounge-typing-input",
        ".flow-lounge-typing-stats",
        ".flow-lounge-weather-tab",
        "button.flow-lounge-btn",
        "button.flow-lounge-quote-btn",
        // Top bar buttons & controls
        "#toggle-flow-lounge",
        "#leave-flow",
        ".command-bar"
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          if (!el || el.hidden || el.offsetParent === null) return;
          const r = el.getBoundingClientRect();
          elementRects.set(el, r);
          if (r.width > 20 && r.height > 8) {
            rects.push({ el: el, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
          }
        });
      });
    } catch {}
    cachedObstacles = rects;

    // Synchronize settled snow attached to live DOM elements (e.g. on scroll or layout shift)
    for (let i = 0; i < settledSnow.length; i++) {
      const sn = settledSnow[i];
      if (sn.el) {
        try {
          let r = elementRects.get(sn.el);
          if (!r) {
            r = sn.el.getBoundingClientRect();
            elementRects.set(sn.el, r);
          }
          if (r && r.width > 0 && r.height > 0) {
            sn.x = r.left + sn.relX;
            sn.y = r.top + sn.relY;
          }
        } catch {}
      }
    }
  }

  function initWeatherSystem() {
    if (!weatherCanvas) {
      weatherCanvas = node("canvas");
      weatherCanvas.id = "flow-lounge-weather-canvas";
      (document.body || shell).append(weatherCanvas);
    }
    resizeWeatherCanvas();
    if (typeof weatherCanvas.getContext === "function") {
      weatherCtx = weatherCanvas.getContext("2d");
    }

    const w = weatherCanvas.width || (typeof window !== "undefined" ? window.innerWidth : 1200) || 1200;
    const h = weatherCanvas.height || (typeof window !== "undefined" ? window.innerHeight : 800) || 800;

    // Initialize raindrops across the entire view
    rainDrops = [];
    for (let i = 0; i < 110; i++) {
      rainDrops.push({
        x: Math.random() * (w + 200) - 100,
        y: Math.random() * h,
        vx: -1.2,
        vy: Math.random() * 6 + 14,
        len: Math.random() * 8 + 12,
        alpha: Math.random() * 0.35 + 0.35,
        passThrough: Math.random() < 0.35
      });
    }
    rainSplashes = [];
    rainRipples = [];

    // Initialize snowflakes
    snowFlakes = [];
    for (let i = 0; i < 95; i++) {
      snowFlakes.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.8 + 1.1,
        vy: Math.random() * 0.9 + 0.8,
        wobble: Math.random() * Math.PI * 2,
        wobbleSpeed: Math.random() * 0.03 + 0.015,
        alpha: Math.random() * 0.35 + 0.55,
        passThrough: Math.random() < 0.32
      });
    }
    settledSnow = [];
    snowClumps = [];

    updateObstacleRects();
  }

  function resizeWeatherCanvas() {
    if (!weatherCanvas || typeof window === "undefined") return;
    const w = window.innerWidth || 1200;
    const h = window.innerHeight || 800;
    if (weatherCanvas.width !== w || weatherCanvas.height !== h) {
      weatherCanvas.width = w;
      weatherCanvas.height = h;
    }
  }

  // Weather can stay on outside the Lounge, in Flow only, when the person keeps it on from the weather card.
  const KEEP_WEATHER_KEY = "throughline:lounge-keep-weather";
  let keepWeather = (() => { try { return localStorage.getItem(KEEP_WEATHER_KEY) !== "0"; } catch { return true; } })();
  const weatherShown = () => (active && !receded) || (keepWeather && Boolean(window.relayFlow?.isOn?.()));
  function syncWeather() {
    if (weatherAnimId) { safeCancelAnim(weatherAnimId); weatherAnimId = null; }
    if (weatherShown()) {
      if (!weatherCanvas) initWeatherSystem(); else resizeWeatherCanvas();
      updateObstacleRects();
      if (!document.hidden) weatherAnimId = safeRequestAnim(drawWeather);
    } else if (weatherCanvas) {
      if (weatherCanvas.remove) weatherCanvas.remove(); else if (weatherCanvas.parentNode) weatherCanvas.parentNode.removeChild(weatherCanvas);
      weatherCanvas = null;
      weatherCtx = null;
    }
  }

  function drawWeather(time) {
    weatherAnimId = null;
    if (!weatherShown() || document.hidden || !weatherCtx || !weatherCanvas) return;
    // Clear, and any weather while the system asks for reduced motion, is drawn once as an empty sky and then stops.
    const still = weatherMode === "clear" || reducedMotion();
    let steps = 1;
    if (!still && lastWeatherFrame !== null) {
      const since = time - lastWeatherFrame;
      if (since < WEATHER_FRAME_MS - 1) {
        weatherAnimId = safeRequestAnim(drawWeather);
        return;
      }
      // After a long gap, such as a hidden window, the weather catches up by a few steps at most.
      weatherLag = Math.min(weatherLag + since, 4 * WEATHER_STEP_MS);
      steps = Math.floor(weatherLag / WEATHER_STEP_MS);
      weatherLag -= steps * WEATHER_STEP_MS;
    }
    lastWeatherFrame = time;
    const ctx = weatherCtx;
    const w = weatherCanvas.width, h = weatherCanvas.height;
    ctx.clearRect(0, 0, w, h);

    if (still) {
      return;
    }

    if (time - lastObstacleUpdate > 800) {
      lastObstacleUpdate = time;
      updateObstacleRects();
    }

    for (let step = 1; step <= steps; step++) stepWeather(step === steps ? ctx : null, w, h);

    if (weatherShown()) weatherAnimId = safeRequestAnim(drawWeather);
  }

  // One 60 Hz step of rain or snow. It draws only when given the canvas context: the last step of a drawn frame.
  function stepWeather(ctx, w, h) {
    if (weatherMode === "rain") {
      if (ctx) {
        ctx.lineWidth = 1.3;
        ctx.strokeStyle = "rgba(147, 197, 253, 0.45)";
      }

      for (let i = 0; i < rainDrops.length; i++) {
        const d = rainDrops[i];
        const nextX = d.x + d.vx;
        const nextY = d.y + d.vy;

        // Check collision with obstacle tops (prompt bubbles, buttons, text blocks)
        let hit = false;
        let hitY = h;
        for (let j = 0; j < cachedObstacles.length; j++) {
          const obs = cachedObstacles[j];
          if (nextX >= obs.left && nextX <= obs.right && d.y < obs.top && nextY >= obs.top) {
            // Allow ~35% of drops to pass past this ledge into deeper content/cards
            if (d.passThrough || Math.random() < 0.35) {
              continue;
            }
            hit = true;
            hitY = obs.top;
            break;
          }
        }

        if (hit || nextY >= h) {
          const splashY = hit ? hitY : h;
          // Spawn 2-3 splash particles bouncing off the button / prompt / text block
          const splashCount = Math.floor(Math.random() * 2) + 2;
          for (let s = 0; s < splashCount; s++) {
            rainSplashes.push({
              x: nextX + (Math.random() - 0.5) * 4,
              y: splashY,
              vx: (Math.random() - 0.5) * 3.2,
              vy: -Math.random() * 2.0 - 0.8,
              r: Math.random() * 1.1 + 0.7,
              alpha: 0.75,
              decay: Math.random() * 0.05 + 0.04
            });
          }

          // Spawn expanding subtle water ripple ring on the hit surface
          if (rainRipples.length < 50) {
            rainRipples.push({
              x: nextX,
              y: splashY,
              rx: 1.5,
              ry: 0.8,
              maxR: Math.random() * 4 + 4,
              alpha: 0.65,
              growth: 0.5,
              decay: 0.05
            });
          }

          // Reset drop to top with staggered start
          d.y = -15 - Math.random() * 25;
          d.x = Math.random() * (w + 200) - 100;
          d.passThrough = Math.random() < 0.35;
        } else {
          d.x = nextX;
          d.y = nextY;
          if (ctx) {
            ctx.beginPath();
            ctx.moveTo(d.x, d.y);
            ctx.lineTo(d.x + d.vx * (d.len / d.vy), d.y - d.len);
            ctx.stroke();
          }
        }
      }

      // Draw and update splashes
      for (let i = rainSplashes.length - 1; i >= 0; i--) {
        const sp = rainSplashes[i];
        sp.x += sp.vx;
        sp.y += sp.vy;
        sp.vy += 0.25; // gravity
        sp.alpha -= sp.decay;

        if (sp.alpha <= 0) {
          rainSplashes.splice(i, 1);
          continue;
        }

        if (!ctx) continue;
        ctx.fillStyle = `rgba(186, 230, 253, ${Math.max(0, sp.alpha)})`;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, sp.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw and update ripples on obstacles
      if (ctx) ctx.lineWidth = 1;
      for (let i = rainRipples.length - 1; i >= 0; i--) {
        const rp = rainRipples[i];
        rp.rx += rp.growth;
        rp.ry += rp.growth * 0.45;
        rp.alpha -= rp.decay;
        if (rp.alpha <= 0 || rp.rx >= rp.maxR) {
          rainRipples.splice(i, 1);
          continue;
        }
        if (!ctx) continue;
        ctx.strokeStyle = `rgba(186, 230, 253, ${Math.max(0, rp.alpha)})`;
        ctx.beginPath();
        if (ctx.ellipse) {
          ctx.ellipse(rp.x, rp.y, rp.rx, rp.ry, 0, 0, Math.PI * 2);
        } else {
          ctx.arc(rp.x, rp.y, rp.rx, 0, Math.PI * 2);
        }
        ctx.stroke();
      }
    } else if (weatherMode === "snow") {
      // 1. Draw settled snow on ledges & bottom (slow to fade, keeps collecting)
      for (let i = settledSnow.length - 1; i >= 0; i--) {
        const sn = settledSnow[i];
        sn.age++;
        // Very slow disappearance: only starts decaying after 2400 frames (~40s), decaying very slowly
        if (sn.age > 2400) {
          sn.alpha -= sn.decay;
        }
        // If nearing high capacity, gently melt the oldest flakes to keep performance crisp
        if (settledSnow.length > 450 && sn.age > 900) {
          sn.alpha -= 0.0006;
        }

        if (sn.alpha <= 0) {
          settledSnow.splice(i, 1);
          continue;
        }

        if (!ctx || sn.y < -10 || sn.y > h + 10 || sn.x < -10 || sn.x > w + 10) continue;

        ctx.fillStyle = `rgba(255, 255, 255, ${Math.max(0, sn.alpha)})`;
        ctx.beginPath();
        ctx.arc(sn.x, sn.y, sn.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2. Draw and update falling snow clumps / sideways drops
      for (let i = snowClumps.length - 1; i >= 0; i--) {
        const c = snowClumps[i];
        c.x += c.vx;
        c.y += c.vy;
        c.vy += 0.04; // gentle gravity acceleration
        c.vx *= 0.985; // air resistance

        // Check if this sideways falling drop hits a lower obstacle
        let clumpHit = false;
        for (let j = 0; j < cachedObstacles.length; j++) {
          const obs = cachedObstacles[j];
          if (c.x >= obs.left && c.x <= obs.right && c.y >= obs.top && (c.y - c.vy) < obs.top) {
            clumpHit = true;
            if (settledSnow.length < 500) {
              const relX = c.x - obs.left;
              settledSnow.push({
                el: obs.el,
                relX: relX,
                relY: -1,
                x: c.x,
                y: obs.top - 1,
                r: c.r * 0.9,
                alpha: c.alpha,
                age: 0,
                decay: 0.00015
              });
            }
            break;
          }
        }

        if (clumpHit || c.y >= h || c.x < -30 || c.x > w + 30) {
          snowClumps.splice(i, 1);
          continue;
        }

        if (!ctx) continue;
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.max(0, c.alpha)})`;
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
        if (c.isClump) {
          ctx.arc(c.x + 1.2, c.y - 0.7, c.r * 0.75, 0, Math.PI * 2);
        }
        ctx.fill();
      }

      // 3. Falling regular snowflakes
      for (let i = 0; i < snowFlakes.length; i++) {
        const f = snowFlakes[i];
        f.wobble += f.wobbleSpeed;
        const nextX = f.x + Math.sin(f.wobble) * 0.75;
        const nextY = f.y + f.vy;

        let hit = false;
        let hitObs = null;
        for (let j = 0; j < cachedObstacles.length; j++) {
          const obs = cachedObstacles[j];
          if (nextX >= obs.left - 2 && nextX <= obs.right + 2 && f.y < obs.top && nextY >= obs.top) {
            // Allow ~32% of flakes to drift past upper elements into deeper UI layers/cards
            if (f.passThrough || Math.random() < 0.32) {
              continue;
            }
            hit = true;
            hitObs = obs;
            break;
          }
        }

        if (hit) {
          const obs = hitObs;
          const relX = nextX - obs.left;
          const width = obs.right - obs.left;

          // Count local settled flakes near this landing spot to determine mound height & accumulation
          let localCount = 0;
          for (let k = 0; k < settledSnow.length; k++) {
            const sn = settledSnow[k];
            if (sn.el === obs.el && Math.abs(sn.relX - relX) < 9) {
              localCount++;
            }
          }

          const distToLeft = relX;
          const distToRight = width - relX;
          const isNearEdge = distToLeft < 7 || distToRight < 7;

          // When snow builds up or lands near the edge: it rolls / slides sideways!
          if (isNearEdge || localCount >= 3) {
            const dir = (distToRight < distToLeft || (distToLeft === distToRight && Math.random() < 0.5)) ? 1 : -1;
            const slideAmount = Math.random() * 8 + 5;
            const newRelX = relX + dir * slideAmount;

            // Did it slide off the edge of the obstacle? (Dropping from sideways!)
            if (newRelX < 0 || newRelX > width) {
              const dropX = dir < 0 ? obs.left - 2 : obs.right + 2;
              snowClumps.push({
                x: dropX,
                y: obs.top + 2,
                vx: dir * (Math.random() * 0.8 + 0.4),
                vy: Math.random() * 0.8 + 0.8,
                r: Math.random() * 1.3 + 1.1,
                alpha: Math.random() * 0.2 + 0.75,
                isClump: Math.random() < 0.4,
                wobble: Math.random() * Math.PI,
                wobbleSpeed: 0.04
              });

              // When the edge mound is heavily loaded (localCount >= 4), dislodge an existing edge flake to fall down together!
              if (localCount >= 4 && Math.random() < 0.35) {
                for (let k = settledSnow.length - 1; k >= 0; k--) {
                  const sn = settledSnow[k];
                  if (sn.el === obs.el && Math.abs(sn.relX - relX) < 12) {
                    settledSnow.splice(k, 1);
                    snowClumps.push({
                      x: dropX + (Math.random() - 0.5) * 3,
                      y: obs.top + 3,
                      vx: dir * (Math.random() * 0.7 + 0.3),
                      vy: Math.random() * 0.7 + 1.0,
                      r: sn.r,
                      alpha: sn.alpha,
                      isClump: true,
                      wobble: Math.random() * Math.PI,
                      wobbleSpeed: 0.05
                    });
                    break;
                  }
                }
              }
            } else {
              // Settles in the rolled adjacent spot
              if (settledSnow.length < 500) {
                const stackH = Math.min(localCount * 1.5, 6);
                settledSnow.push({
                  el: obs.el,
                  relX: newRelX,
                  relY: -1 - stackH,
                  x: obs.left + newRelX,
                  y: obs.top - 1 - stackH,
                  r: Math.random() * 1.1 + 0.9,
                  alpha: Math.random() * 0.2 + 0.75,
                  age: 0,
                  decay: 0.00015
                });
              }
            }
          } else {
            // Settle naturally on the ledge, accumulating in gentle layers
            if (settledSnow.length < 500) {
              const stackH = Math.min(localCount * 1.5, 6);
              settledSnow.push({
                el: obs.el,
                relX: relX + (Math.random() - 0.5) * 2,
                relY: -1 - stackH,
                x: nextX,
                y: obs.top - 1 - stackH,
                r: Math.random() * 1.1 + 0.9,
                alpha: Math.random() * 0.2 + 0.75,
                age: 0,
                decay: 0.00015
              });
            }
          }

          // Reset flake to top with staggered start
          f.y = -10 - Math.random() * 20;
          f.x = Math.random() * w;
          f.passThrough = Math.random() < 0.32;
        } else if (nextY >= h) {
          // Bottom of screen accumulation
          if (settledSnow.length < 500 && Math.random() < 0.45) {
            settledSnow.push({
              el: null,
              relX: 0,
              relY: 0,
              x: nextX,
              y: h - 1 - Math.random() * 2,
              r: Math.random() * 1.3 + 1.0,
              alpha: Math.random() * 0.25 + 0.65,
              age: 0,
              decay: 0.00015
            });
          }
          f.y = -10 - Math.random() * 20;
          f.x = Math.random() * w;
          f.passThrough = Math.random() < 0.32;
        } else {
          f.x = nextX;
          f.y = nextY;
          if (ctx) {
            ctx.fillStyle = `rgba(255, 255, 255, ${f.alpha})`;
            ctx.beginPath();
            ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
  }

  function setWeatherMode(mode) {
    weatherMode = mode;
    if (weatherAnimId) safeCancelAnim(weatherAnimId);
    weatherAnimId = null;
    if (weatherShown() && !document.hidden) weatherAnimId = safeRequestAnim(drawWeather);
    rainSplashes = [];
    rainRipples = [];
    settledSnow = [];
    snowClumps = [];
    const tabs = document.querySelectorAll(".flow-lounge-weather-tab");
    tabs.forEach(t => {
      const match = t.getAttribute("data-mode") === mode;
      t.classList.toggle("active", match);
    });
  }

  // ==========================================
  // 2. LEFT RAIL: BREAKOUT MINI-GAME
  // ==========================================
  let breakoutState = null;
  let breakoutAnimId = null;
  let breakoutScoreEl = null;
  let breakoutBestEl = null;
  let breakoutStatusEl = null;
  let breakoutCanvas = null;
  let breakoutCtx = null;
  let breakoutStarted = false;
  let breakoutPaused = false;
  let bStartBreakout = null;

  function initBreakout() {
    const w = 320, h = 200;
    const paddleW = 60, paddleH = 8;
    const bricks = [];
    const rows = 4, cols = 7, bW = 38, bH = 10, bPad = 6, bTop = 22, bLeft = 9;
    const colors = ["#f43f5e", "#fb923c", "#eab308", "#10b981"];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        bricks.push({ x: bLeft + c * (bW + bPad), y: bTop + r * (bH + bPad), w: bW, h: bH, color: colors[r % colors.length], alive: true });
      }
    }

    const paddleX = (w - paddleW) / 2;
    const paddleY = h - 14;
    const ballR = 4.5;

    breakoutState = {
      w, h,
      paddle: { x: paddleX, y: paddleY, w: paddleW, h: paddleH, speed: 6.5 },
      ball: { x: paddleX + paddleW / 2, y: paddleY - ballR - 1, r: ballR, vx: 2.3 * (Math.random() > 0.5 ? 1 : -1), vy: -2.8 },
      bricks,
      score: 0,
      gameOver: false,
      won: false,
      leftDown: false,
      rightDown: false,
    };

    breakoutStarted = false;
    breakoutPaused = false;
    if (breakoutAnimId) safeCancelAnim(breakoutAnimId);
    breakoutAnimId = safeRequestAnim(drawBreakout);
    if (bStartBreakout) {
      bStartBreakout.textContent = "▶ Start Game";
      bStartBreakout.className = "primary-button flow-lounge-btn";
    }
    if (breakoutStatusEl) breakoutStatusEl.textContent = BREAKOUT_READY;
  }

  function getBestScore(game) {
    try { return parseInt(localStorage.getItem("throughline:lounge-" + game + "-best") || "0", 10); }
    catch { return 0; }
  }

  function saveBestScore(game, score) {
    try {
      const best = getBestScore(game);
      if (score > best) localStorage.setItem("throughline:lounge-" + game + "-best", String(score));
    } catch {}
  }

  function updateBreakoutScores() {
    if (!breakoutScoreEl || !breakoutBestEl) return;
    const current = breakoutState?.score || 0;
    const best = Math.max(current, getBestScore("breakout"));
    breakoutScoreEl.textContent = String(current);
    breakoutBestEl.textContent = String(best);
  }

  function loopBreakout() {
    if (breakoutAnimId) safeCancelAnim(breakoutAnimId);
    breakoutAnimId = safeRequestAnim(drawBreakout);
  }

  function startBreakout() {
    if (!breakoutState || breakoutState.gameOver || breakoutState.won) initBreakout();
    if (breakoutState) {
      breakoutState.ball.vy = -Math.abs(breakoutState.ball.vy || 2.8);
    }
    breakoutStarted = true;
    breakoutPaused = false;
    if (bStartBreakout) {
      bStartBreakout.textContent = "Pause";
      bStartBreakout.className = "secondary-button flow-lounge-btn";
    }
    if (breakoutStatusEl) breakoutStatusEl.textContent = "Playing · Arrow keys, A/D or the mouse · Space to pause";
    // The loop stops while the game waits, so starting has to wake it.
    loopBreakout();
  }

  function setBreakoutPaused(paused) {
    if (!breakoutStarted || breakoutPaused === paused) return;
    breakoutPaused = paused;
    if (breakoutState) breakoutState.leftDown = breakoutState.rightDown = false;
    if (bStartBreakout) bStartBreakout.textContent = paused ? "Resume" : "Pause";
    if (breakoutStatusEl) breakoutStatusEl.textContent = paused ? "Paused · Space or Resume to continue" : "Playing · Arrow keys, A/D or the mouse · Space to pause";
    if (!paused) loopBreakout();
  }

  function stepBreakout() {
    const s = breakoutState;
    if (!s || !breakoutStarted || breakoutPaused || s.gameOver || s.won) return;

    if (s.leftDown) s.paddle.x = Math.max(0, s.paddle.x - s.paddle.speed);
    if (s.rightDown) s.paddle.x = Math.min(s.w - s.paddle.w, s.paddle.x + s.paddle.speed);

    s.ball.x += s.ball.vx;
    s.ball.y += s.ball.vy;

    if (s.ball.x - s.ball.r <= 0) { s.ball.x = s.ball.r; s.ball.vx *= -1; }
    else if (s.ball.x + s.ball.r >= s.w) { s.ball.x = s.w - s.ball.r; s.ball.vx *= -1; }
    if (s.ball.y - s.ball.r <= 0) { s.ball.y = s.ball.r; s.ball.vy *= -1; }

    if (s.ball.y + s.ball.r >= s.paddle.y && s.ball.y - s.ball.r <= s.paddle.y + s.paddle.h &&
        s.ball.x >= s.paddle.x && s.ball.x <= s.paddle.x + s.paddle.w) {
      s.ball.vy = -Math.abs(s.ball.vy);
      const hitPoint = (s.ball.x - (s.paddle.x + s.paddle.w / 2)) / (s.paddle.w / 2);
      s.ball.vx = hitPoint * 3.8;
    }

    let remaining = 0;
    for (const b of s.bricks) {
      if (!b.alive) continue;
      remaining++;
      if (s.ball.x + s.ball.r >= b.x && s.ball.x - s.ball.r <= b.x + b.w &&
          s.ball.y + s.ball.r >= b.y && s.ball.y - s.ball.r <= b.y + b.h) {
        b.alive = false;
        s.ball.vy *= -1;
        s.score += 10;
        saveBestScore("breakout", s.score);
        updateBreakoutScores();
        break;
      }
    }

    if (remaining === 0) {
      s.won = true;
      breakoutStarted = false;
      if (bStartBreakout) {
        bStartBreakout.textContent = "▶ Play Again";
        bStartBreakout.className = "primary-button flow-lounge-btn";
      }
      if (breakoutStatusEl) breakoutStatusEl.textContent = "★ Board Cleared! ★ Click Play Again to restart";
    } else if (s.ball.y - s.ball.r > s.h) {
      s.gameOver = true;
      breakoutStarted = false;
      if (bStartBreakout) {
        bStartBreakout.textContent = "▶ Play Again";
        bStartBreakout.className = "primary-button flow-lounge-btn";
      }
      if (breakoutStatusEl) breakoutStatusEl.textContent = "Game Over. Press Play Again or Space to restart";
    }
  }

  function drawBreakout() {
    breakoutAnimId = null;
    if (!active || receded || document.hidden || !breakoutCtx || !breakoutCanvas) return;
    const ctx = breakoutCtx;
    const w = breakoutCanvas.width, h = breakoutCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const s = breakoutState;
    if (s) {
      if (!breakoutStarted && !s.gameOver && !s.won) {
        s.ball.x = s.paddle.x + s.paddle.w / 2;
        s.ball.y = s.paddle.y - s.ball.r - 1;
      } else {
        stepBreakout();
      }

      // Draw bricks
      for (const b of s.bricks) {
        if (!b.alive) continue;
        ctx.fillStyle = b.color;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(b.x, b.y, b.w, b.h, 3);
        else ctx.rect(b.x, b.y, b.w, b.h);
        ctx.fill();
      }

      // Draw paddle
      ctx.fillStyle = "#60a5fa";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(s.paddle.x, s.paddle.y, s.paddle.w, s.paddle.h, 4);
      else ctx.rect(s.paddle.x, s.paddle.y, s.paddle.w, s.paddle.h);
      ctx.fill();

      // Draw ball
      ctx.fillStyle = "#f8fafc";
      ctx.beginPath();
      ctx.arc(s.ball.x, s.ball.y, s.ball.r, 0, Math.PI * 2);
      ctx.fill();
    }

    if (active && !receded && breakoutStarted && !breakoutPaused) breakoutAnimId = safeRequestAnim(drawBreakout);
  }

  function buildBreakoutCard() {
    const card = node("section", "flow-card flow-lounge-card");
    card.id = "flow-card-lounge-arcade";

    const head = node("div", "flow-card-head");
    const title = node("h2", undefined, "Breakout");
    head.append(title);


    const scorePill = node("div", "flow-lounge-score-pill");
    const scoreLabel = node("span", undefined, "Score ");
    breakoutScoreEl = node("strong", undefined, "0");
    breakoutScoreEl.id = "flow-lounge-score";
    scoreLabel.append(breakoutScoreEl);
    const bestLabel = node("span", undefined, "Best ");
    breakoutBestEl = node("strong", undefined, "0");
    breakoutBestEl.id = "flow-lounge-best";
    bestLabel.append(breakoutBestEl);
    scorePill.append(scoreLabel, bestLabel);

    const canvasWrap = node("div", "flow-lounge-canvas-wrap");
    breakoutCanvas = node("canvas", "flow-lounge-canvas");
    breakoutCanvas.width = 320;
    breakoutCanvas.height = 200;
    if (typeof breakoutCanvas.getContext === "function") breakoutCtx = breakoutCanvas.getContext("2d");
    canvasWrap.append(breakoutCanvas);

    breakoutStatusEl = node("div", "flow-lounge-status-line", BREAKOUT_READY);

    breakoutCanvas.addEventListener("mousemove", e => {
      if (breakoutState) {
        const rect = breakoutCanvas.getBoundingClientRect ? breakoutCanvas.getBoundingClientRect() : { left: 0, width: 320 };
        const scaleX = breakoutCanvas.width / (rect.width || 320);
        const x = (e.clientX - rect.left) * scaleX;
        breakoutState.paddle.x = Math.max(0, Math.min(breakoutState.w - breakoutState.paddle.w, x - breakoutState.paddle.w / 2));
        // Before launch the loop is idle; redraw so the paddle and ball follow the mouse.
        if (!breakoutAnimId && (!breakoutStarted || breakoutPaused)) breakoutAnimId = safeRequestAnim(drawBreakout);
      }
    });

    const foot = node("div", "flow-card-foot flow-lounge-foot");
    bStartBreakout = button("primary-button flow-lounge-btn", "▶ Start Game", () => {
      if (!breakoutStarted) startBreakout();
      else setBreakoutPaused(!breakoutPaused);
      if (breakoutStarted && !breakoutPaused) focusBoard(breakoutCanvas);
    });

    const bRestart = button("secondary-button flow-lounge-btn", "Restart", () => {
      initBreakout();
      updateBreakoutScores();
      loopBreakout();
    });

    foot.append(bStartBreakout, bRestart);
    card.append(head, scorePill, canvasWrap, breakoutStatusEl, foot);
    wireGameCard(card, breakoutCanvas, "Breakout board. Space starts or pauses; arrow keys or A and D move the paddle.", () => setBreakoutPaused(true));
    return card;
  }

  // Keys reach only the game whose card holds focus. Clicking anywhere on a game card gives it
  // the keys (outlined), and focus leaving the card pauses that game so it doesn't run unseen.
  function wireGameCard(card, canvas, label, pause) {
    card.tabIndex = -1;
    card.classList.add("flow-lounge-game");
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", label);
    card.addEventListener("focusout", e => {
      if (e.relatedTarget?.closest?.(".flow-lounge-game") !== card) pause();
    });
  }

  // Moving focus from the button to the board keeps Space for the game instead of re-pressing the button.
  function focusBoard(canvas) {
    try { canvas?.focus?.({ preventScroll: true }); } catch {}
  }

  // ==========================================
  // 3. RIGHT RAIL: RETRO SNAKE MINI-GAME
  // ==========================================
  let snakeState = null;
  let snakeAnimId = null;
  let snakeScoreEl = null;
  let snakeBestEl = null;
  let snakeStatusEl = null;
  let snakeCanvas = null;
  let snakeCtx = null;
  let snakeStarted = false;
  let snakePaused = false;
  let bStartSnake = null;

  function initSnake() {
    const cols = 20, rows = 13, size = 15;
    const snake = [{ x: 5, y: 6 }, { x: 4, y: 6 }, { x: 3, y: 6 }];
    const food = spawnFood(snake, cols, rows);

    snakeState = {
      cols, rows, size,
      w: cols * size, h: rows * size,
      snake,
      food,
      dir: { x: 1, y: 0 },
      nextDir: { x: 1, y: 0 },
      score: 0,
      gameOver: false,
      lastTick: 0,
      tickRate: 110,
    };

    snakeStarted = false;
    snakePaused = false;
    if (snakeAnimId) safeCancelAnim(snakeAnimId);
    snakeAnimId = safeRequestAnim(drawSnake);
    if (bStartSnake) {
      bStartSnake.textContent = "▶ Start Game";
      bStartSnake.className = "primary-button flow-lounge-btn";
    }
    if (snakeStatusEl) snakeStatusEl.textContent = SNAKE_READY;
  }

  function spawnFood(snake, cols, rows) {
    let food;
    while (!food || snake.some(s => s.x === food.x && s.y === food.y)) {
      food = { x: Math.floor(Math.random() * cols), y: Math.floor(Math.random() * rows) };
    }
    return food;
  }

  function updateSnakeScores() {
    if (!snakeScoreEl || !snakeBestEl) return;
    const current = snakeState?.score || 0;
    const best = Math.max(current, getBestScore("snake"));
    snakeScoreEl.textContent = String(current);
    snakeBestEl.textContent = String(best);
  }

  function startSnake() {
    if (!snakeState || snakeState.gameOver) initSnake();
    snakeStarted = true;
    snakePaused = false;
    if (bStartSnake) {
      bStartSnake.textContent = "Pause";
      bStartSnake.className = "secondary-button flow-lounge-btn";
    }
    if (snakeStatusEl) snakeStatusEl.textContent = "Playing · Arrow keys or WASD · Space to pause";
    // The loop stops while the game waits, so starting has to wake it.
    loopSnake();
  }

  function loopSnake() {
    if (snakeAnimId) safeCancelAnim(snakeAnimId);
    snakeAnimId = safeRequestAnim(drawSnake);
  }

  function setSnakePaused(paused) {
    if (!snakeStarted || snakePaused === paused) return;
    snakePaused = paused;
    if (bStartSnake) bStartSnake.textContent = paused ? "Resume" : "Pause";
    if (snakeStatusEl) snakeStatusEl.textContent = paused ? "Paused · Space or Resume to continue" : "Playing · Arrow keys or WASD · Space to pause";
    if (!paused) loopSnake();
  }

  function stepSnake(time) {
    const s = snakeState;
    if (!s || !snakeStarted || snakePaused || s.gameOver) return;
    if (time - s.lastTick < s.tickRate) return;
    s.lastTick = time;

    s.dir = s.nextDir;
    const head = { x: s.snake[0].x + s.dir.x, y: s.snake[0].y + s.dir.y };

    if (head.x < 0 || head.x >= s.cols || head.y < 0 || head.y >= s.rows ||
        s.snake.some(seg => seg.x === head.x && seg.y === head.y)) {
      s.gameOver = true;
      snakeStarted = false;
      if (bStartSnake) {
        bStartSnake.textContent = "▶ Play Again";
        bStartSnake.className = "primary-button flow-lounge-btn";
      }
      if (snakeStatusEl) snakeStatusEl.textContent = "Game Over. Press Play Again to restart";
      return;
    }

    s.snake.unshift(head);
    if (head.x === s.food.x && head.y === s.food.y) {
      s.score += 10;
      saveBestScore("snake", s.score);
      updateSnakeScores();
      s.food = spawnFood(s.snake, s.cols, s.rows);
      s.tickRate = Math.max(65, 110 - Math.floor(s.score / 30) * 8);
    } else {
      s.snake.pop();
    }
  }

  function drawSnake(time) {
    snakeAnimId = null;
    if (!active || receded || document.hidden || !snakeCtx || !snakeCanvas) return;
    const ctx = snakeCtx;
    const w = snakeCanvas.width, h = snakeCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const s = snakeState;
    if (s) {
      if (snakeStarted) stepSnake(time);

      // Draw food
      ctx.fillStyle = "#f43f5e";
      ctx.beginPath();
      ctx.arc(s.food.x * s.size + s.size / 2, s.food.y * s.size + s.size / 2, s.size / 2 - 1.5, 0, Math.PI * 2);
      ctx.fill();

      // Draw snake
      s.snake.forEach((seg, i) => {
        ctx.fillStyle = i === 0 ? "#34d399" : "#10b981";
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(seg.x * s.size + 1, seg.y * s.size + 1, s.size - 2, s.size - 2, i === 0 ? 4 : 2);
        else ctx.rect(seg.x * s.size + 1, seg.y * s.size + 1, s.size - 2, s.size - 2);
        ctx.fill();
      });
    }

    if (active && !receded && snakeStarted && !snakePaused) snakeAnimId = safeRequestAnim(drawSnake);
  }

  function buildSnakeCard() {
    const card = node("section", "flow-card flow-lounge-card");
    card.id = "flow-card-lounge-zen";

    const head = node("div", "flow-card-head");
    const title = node("h2", undefined, "Retro Snake");
    head.append(title);


    const scorePill = node("div", "flow-lounge-score-pill");
    const scoreLabel = node("span", undefined, "Score ");
    snakeScoreEl = node("strong", undefined, "0");
    snakeScoreEl.id = "flow-lounge-snake-score";
    scoreLabel.append(snakeScoreEl);
    const bestLabel = node("span", undefined, "Best ");
    snakeBestEl = node("strong", undefined, "0");
    snakeBestEl.id = "flow-lounge-snake-best";
    bestLabel.append(snakeBestEl);
    scorePill.append(scoreLabel, bestLabel);

    const canvasWrap = node("div", "flow-lounge-canvas-wrap");
    snakeCanvas = node("canvas", "flow-lounge-canvas");
    snakeCanvas.width = 300;
    snakeCanvas.height = 195;
    if (typeof snakeCanvas.getContext === "function") snakeCtx = snakeCanvas.getContext("2d");
    canvasWrap.append(snakeCanvas);

    snakeStatusEl = node("div", "flow-lounge-status-line", SNAKE_READY);

    const foot = node("div", "flow-card-foot flow-lounge-foot");
    bStartSnake = button("primary-button flow-lounge-btn", "▶ Start Game", () => {
      if (!snakeStarted) startSnake();
      else setSnakePaused(!snakePaused);
      if (snakeStarted && !snakePaused) focusBoard(snakeCanvas);
    });

    const bRestart = button("secondary-button flow-lounge-btn", "Restart", () => {
      initSnake();
      updateSnakeScores();
      loopSnake();
    });

    foot.append(bStartSnake, bRestart);
    card.append(head, scorePill, canvasWrap, snakeStatusEl, foot);
    wireGameCard(card, snakeCanvas, "Snake board. Arrow keys or W, A, S and D steer; Space starts or pauses.", () => setSnakePaused(true));
    return card;
  }

  // ==========================================
  // 4. TECH & PROGRAMMING TRIVIA (LEFT RAIL)
  // ==========================================
  const TRIVIA = [
    {
      q: "What does the HTTP 418 status code stand for?",
      opts: ["Method Not Allowed", "I'm a teapot", "Upgrade Required", "Unavailable For Legal Reasons"],
      ans: 1,
      exp: "RFC 2324 defined 418 as an April Fools joke for Hyper Text Coffee Pot Control Protocol."
    },
    {
      q: "In Git, what does git cherry-pick do?",
      opts: ["Deletes untracked files", "Applies the changes from specific commits to HEAD", "Reverts all uncommitted changes", "Merges two branches without a commit"],
      ans: 1,
      exp: "Cherry-pick takes patches introduced in existing commits and re-applies them onto your current branch."
    },
    {
      q: "What is the average time complexity of looking up a key in a hash table?",
      opts: ["O(log n)", "O(n)", "O(1)", "O(n log n)"],
      ans: 2,
      exp: "Hash tables achieve O(1) amortized lookup via hash function computation into bucket arrays."
    },
    {
      q: "Which JavaScript method prevents any modification or addition of properties on an object?",
      opts: ["Object.preventExtensions()", "Object.seal()", "Object.freeze()", "Object.lock()"],
      ans: 2,
      exp: "Object.freeze() makes an object immutable: no new properties, no deletes, and values cannot change."
    },
    {
      q: "What Linux signal does kill -9 send to a process?",
      opts: ["SIGTERM (Graceful)", "SIGKILL (Immediate)", "SIGINT (Interrupt)", "SIGHUP (Hangup)"],
      ans: 1,
      exp: "SIGKILL (signal 9) unconditionally terminates a process immediately without executing signal handlers."
    },
    {
      q: "In CSS flexbox, which property aligns items along the cross axis?",
      opts: ["justify-content", "align-items", "flex-direction", "align-content"],
      ans: 1,
      exp: "justify-content aligns items along the main axis; align-items aligns along the perpendicular cross axis."
    },
    {
      q: "In Python, which built-in function returns pairs of (index, item) for an iterable?",
      opts: ["zip()", "map()", "enumerate()", "iter()"],
      ans: 2,
      exp: "enumerate(iterable, start=0) generates tuples containing a count and the yielded values."
    },
    {
      q: "What does the CAP theorem state distributed systems cannot simultaneously guarantee?",
      opts: ["Cost, Availability, Performance", "Consistency, Availability, Partition Tolerance", "Concurrency, Accuracy, Persistence", "Caching, Authentication, Privacy"],
      ans: 1,
      exp: "In the event of a network partition, a distributed system must choose between consistency or availability."
    },
    {
      q: "In Docker, what is the primary benefit of a multi-stage build?",
      opts: ["Deploy to multiple clouds", "Produce lightweight production images with only final artifacts", "Execute containers in parallel", "Mount multiple host drives"],
      ans: 1,
      exp: "Multi-stage builds leave compiler tools and intermediary build cache behind in separate throwaway stages."
    },
    {
      q: "What is the key difference between SQL WHERE and HAVING clauses?",
      opts: ["HAVING filters aggregated groups after GROUP BY; WHERE filters rows before grouping", "WHERE works only on numeric columns", "HAVING cannot be used with SELECT", "They are identical aliases"],
      ans: 0,
      exp: "WHERE filters rows before aggregation, whereas HAVING filters the grouped results from aggregate functions."
    },
    {
      q: "What data structure does the JavaScript Event Loop call stack use?",
      opts: ["FIFO Queue", "LIFO Stack", "Priority Heap", "Doubly Linked List"],
      ans: 1,
      exp: "The call stack executes function frames in Last-In First-Out (LIFO) order."
    },
    {
      q: "What does the aria-live attribute in HTML provide for accessibility?",
      opts: ["Plays audio on mouse hover", "Notifies screen readers of dynamic content updates without focus", "Validates form fields automatically", "Pre-loads external stylesheets"],
      ans: 1,
      exp: "aria-live tells assistive technologies to announce dynamic content changes (polite or assertive)."
    }
  ];

  let triviaIdx = 0;
  let triviaScore = 0;
  let triviaTotal = 0;
  let triviaStreak = 0;

  function buildTriviaCard() {
    const card = node("section", "flow-card flow-lounge-card");
    card.id = "flow-card-lounge-trivia";

    const head = node("div", "flow-card-head");
    const title = node("h2", undefined, "Tech & Code Trivia");
    head.append(title);

    const meta = node("div", "flow-lounge-trivia-meta");
    const scoreSpan = node("span", undefined, `Score: ${triviaScore}/${triviaTotal}`);
    scoreSpan.id = "flow-lounge-trivia-score";
    const streakSpan = node("span", "flow-lounge-trivia-streak", `Streak: ${triviaStreak} 🔥`);
    streakSpan.id = "flow-lounge-trivia-streak";
    meta.append(scoreSpan, streakSpan);

    const qEl = node("p", "flow-lounge-trivia-q");
    qEl.id = "flow-lounge-trivia-q";

    const optWrap = node("div", "flow-lounge-trivia-options");
    optWrap.id = "flow-lounge-trivia-options";

    const feedWrap = node("div", "flow-lounge-trivia-feedback");
    feedWrap.id = "flow-lounge-trivia-feedback";
    feedWrap.hidden = true;

    card.append(head, meta, qEl, optWrap, feedWrap);
    renderTriviaQuestion(card);
    return card;
  }

  function renderTriviaQuestion(card) {
    const item = TRIVIA[triviaIdx % TRIVIA.length];
    const qEl = card.querySelector("#flow-lounge-trivia-q");
    const optWrap = card.querySelector("#flow-lounge-trivia-options");
    const feedWrap = card.querySelector("#flow-lounge-trivia-feedback");
    const scoreSpan = card.querySelector("#flow-lounge-trivia-score");
    const streakSpan = card.querySelector("#flow-lounge-trivia-streak");

    if (!qEl || !optWrap || !feedWrap) return;
    feedWrap.hidden = true;
    feedWrap.replaceChildren();

    if (scoreSpan) scoreSpan.textContent = `Score: ${triviaScore}/${triviaTotal}`;
    if (streakSpan) streakSpan.textContent = `Streak: ${triviaStreak} 🔥`;

    qEl.textContent = item.q;
    optWrap.replaceChildren();

    item.opts.forEach((optText, optIdx) => {
      const optBtn = button("flow-lounge-trivia-opt", `${String.fromCharCode(65 + optIdx)}. ${optText}`, () => {
        handleTriviaAnswer(optIdx, item, card);
      });
      optWrap.append(optBtn);
    });
  }

  function handleTriviaAnswer(selectedIdx, item, card) {
    const optWrap = card.querySelector("#flow-lounge-trivia-options");
    const feedWrap = card.querySelector("#flow-lounge-trivia-feedback");
    const scoreSpan = card.querySelector("#flow-lounge-trivia-score");
    const streakSpan = card.querySelector("#flow-lounge-trivia-streak");

    triviaTotal++;
    const isCorrect = selectedIdx === item.ans;
    if (isCorrect) {
      triviaScore++;
      triviaStreak++;
    } else {
      triviaStreak = 0;
    }

    if (scoreSpan) scoreSpan.textContent = `Score: ${triviaScore}/${triviaTotal}`;
    if (streakSpan) streakSpan.textContent = `Streak: ${triviaStreak} 🔥`;

    const btns = optWrap.querySelectorAll(".flow-lounge-trivia-opt");
    btns.forEach((btn, idx) => {
      btn.disabled = true;
      if (idx === item.ans) btn.classList.add("correct");
      else if (idx === selectedIdx && !isCorrect) btn.classList.add("wrong");
    });

    feedWrap.hidden = false;
    const msg = node("p", undefined, (isCorrect ? "✅ Correct! " : "❌ Incorrect. ") + item.exp);
    const nextBtn = button("primary-button flow-lounge-btn", "Next Question ➔", () => {
      triviaIdx++;
      renderTriviaQuestion(card);
    });
    feedWrap.replaceChildren(msg, nextBtn);
  }

  // ==========================================
  // 5. DEVELOPER WISDOM QUOTES (LEFT RAIL)
  // ==========================================
  const QUOTES = [
    { quote: "There are only two hard things in Computer Science: cache invalidation and naming things.", author: "Phil Karlton" },
    { quote: "Simplicity is prerequisite for reliability.", author: "Edsger W. Dijkstra" },
    { quote: "Make it work, make it right, make it fast.", author: "Kent Beck" },
    { quote: "Any fool can write code that a computer can understand. Good programmers write code that humans can understand.", author: "Martin Fowler" },
    { quote: "First, solve the problem. Then, write the code.", author: "John Johnson" },
    { quote: "Optimism is an occupational hazard of programming: feedback is the treatment.", author: "Kent Beck" },
    { quote: "Before software can be reusable it first has to be usable.", author: "Ralph Johnson" },
    { quote: "The best error message is the one that never shows up.", author: "Thomas Fuchs" },
    { quote: "Talk is cheap. Show me the code.", author: "Linus Torvalds" },
    { quote: "Deleted code is debugged code.", author: "Jeff Sickel" },
    { quote: "Walking on water and developing software from a specification are easy if both are frozen.", author: "Edward V. Berard" },
    { quote: "If debugging is the process of removing software bugs, then programming must be the process of putting them in.", author: "Edsger W. Dijkstra" },
    { quote: "The most dangerous phrase in the language is: We've always done it this way.", author: "Grace Hopper" }
  ];

  let quoteIdx = 0;
  let quoteTimer = null;
  let qTextEl = null;
  let qAuthorEl = null;

  function buildQuoteCard() {
    const card = node("div", "flow-lounge-quote-card");
    card.id = "flow-card-lounge-quote";

    const head = node("div", "flow-lounge-quote-head");
    const label = node("span", "flow-lounge-quote-label", "Developer Wisdom");
    const nextBtn = button("flow-lounge-quote-btn", "🎲 Shuffle", nextQuote);
    head.append(label, nextBtn);

    qTextEl = node("p", "flow-lounge-quote-text");
    qAuthorEl = node("p", "flow-lounge-quote-author");
    card.append(head, qTextEl, qAuthorEl);

    showQuote(Math.floor(Math.random() * QUOTES.length));
    if (quoteTimer) safeClearInterval(quoteTimer);
    quoteTimer = safeSetInterval(nextQuote, 20000);
    return card;
  }

  function showQuote(idx) {
    quoteIdx = idx % QUOTES.length;
    const q = QUOTES[quoteIdx];
    if (qTextEl) qTextEl.textContent = `“${q.quote}”`;
    if (qAuthorEl) qAuthorEl.textContent = `— ${q.author}`;
  }

  function nextQuote() {
    showQuote((quoteIdx + 1) % QUOTES.length);
  }

  // ==========================================
  // 6. TYPING SPEED TEST (RIGHT RAIL)
  // ==========================================
  const SNIPPETS = [
    "const debounce = (fn, ms) => { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; };",
    "git commit -m \"feat(flow): add ambient lounge with full-screen weather physics\"",
    "function binarySearch(arr, target) { let l = 0, r = arr.length - 1; while (l <= r) { const m = (l + r) >> 1; } }",
    "const results = await Promise.all(tasks.map(t => worker.execute(t)));",
    "export async function GET(req) { const users = await db.query.users.findMany(); return Response.json(users); }",
    "docker run -d -p 8080:80 --name web-service --restart always nginx:alpine",
    "chmod 755 deploy.sh && ./deploy.sh --production --dry-run=false",
    "const pipeline = [sanitize, validate, transform].reduce((acc, step) => step(acc), initialData);"
  ];

  let snippetIdx = 0;
  let typingStartTime = null;
  let typingInputEl = null;
  let typingSnippetEl = null;
  let typingStatsWpm = null;
  let typingStatsAcc = null;
  let typingStatsProg = null;
  let typingCompleteBox = null;

  function buildTypingCard() {
    const card = node("section", "flow-card flow-lounge-card");
    card.id = "flow-card-lounge-typing";

    const head = node("div", "flow-card-head");
    const title = node("h2", undefined, "Typing Speed Test");
    head.append(title);

    const sub = node("p", "flow-lounge-subtitle", "Practice Real Code Snippets");

    const stats = node("div", "flow-lounge-typing-stats");
    const sWpm = node("span", undefined, "WPM: ");
    typingStatsWpm = node("strong", undefined, "0");
    sWpm.append(typingStatsWpm);
    const sAcc = node("span", undefined, "Accuracy: ");
    typingStatsAcc = node("strong", undefined, "100%");
    sAcc.append(typingStatsAcc);
    const sProg = node("span", undefined, "Progress: ");
    typingStatsProg = node("strong", undefined, "0%");
    sProg.append(typingStatsProg);
    stats.append(sWpm, sAcc, sProg);

    typingSnippetEl = node("div", "flow-lounge-typing-snippet");

    typingInputEl = node("input", "flow-lounge-typing-input");
    typingInputEl.type = "text";
    typingInputEl.placeholder = "Type the code snippet above...";
    typingInputEl.autocomplete = "off";
    typingInputEl.spellcheck = false;

    typingCompleteBox = node("div", "flow-lounge-typing-complete");
    typingCompleteBox.hidden = true;

    typingInputEl.addEventListener("input", () => handleTypingInput(card));

    const foot = node("div", "flow-card-foot flow-lounge-foot");
    const bNextSnippet = button("secondary-button flow-lounge-btn", "Next Snippet", () => {
      snippetIdx = (snippetIdx + 1) % SNIPPETS.length;
      resetTypingTest();
    });
    foot.append(bNextSnippet);

    card.append(head, sub, stats, typingSnippetEl, typingInputEl, typingCompleteBox, foot);
    resetTypingTest();
    return card;
  }

  function resetTypingTest() {
    typingStartTime = null;
    if (typingInputEl) {
      typingInputEl.value = "";
      typingInputEl.disabled = false;
      typingInputEl.placeholder = "Type the code snippet above...";
    }
    if (typingCompleteBox) {
      typingCompleteBox.hidden = true;
      typingCompleteBox.replaceChildren();
    }
    if (typingStatsWpm) typingStatsWpm.textContent = "0";
    if (typingStatsAcc) typingStatsAcc.textContent = "100%";
    if (typingStatsProg) typingStatsProg.textContent = "0%";
    renderTypingDisplay("");
  }

  function renderTypingDisplay(typed) {
    if (!typingSnippetEl) return;
    const target = SNIPPETS[snippetIdx % SNIPPETS.length];
    typingSnippetEl.replaceChildren();

    for (let i = 0; i < target.length; i++) {
      const span = node("span");
      span.textContent = target[i];
      if (i < typed.length) {
        if (typed[i] === target[i]) span.className = "flow-lounge-char-correct";
        else span.className = "flow-lounge-char-wrong";
      } else if (i === typed.length) {
        span.className = "flow-lounge-char-current";
      } else {
        span.className = "flow-lounge-char-pending";
      }
      typingSnippetEl.append(span);
    }
  }

  function handleTypingInput(card) {
    if (!typingInputEl) return;
    const target = SNIPPETS[snippetIdx % SNIPPETS.length];
    const val = typingInputEl.value;

    if (!typingStartTime && val.length > 0) {
      typingStartTime = Date.now();
    }

    renderTypingDisplay(val);

    let correctCount = 0;
    for (let i = 0; i < val.length; i++) {
      if (val[i] === target[i]) correctCount++;
    }

    const elapsedMin = typingStartTime ? Math.max(0.01, (Date.now() - typingStartTime) / 60000) : 0.01;
    const wpm = Math.round((correctCount / 5) / elapsedMin);
    const acc = val.length > 0 ? Math.round((correctCount / val.length) * 100) : 100;
    const progress = Math.min(100, Math.round((val.length / target.length) * 100));

    if (typingStatsWpm) typingStatsWpm.textContent = String(wpm);
    if (typingStatsAcc) typingStatsAcc.textContent = acc + "%";
    if (typingStatsProg) typingStatsProg.textContent = progress + "%";

    if (val === target) {
      typingInputEl.disabled = true;
      if (typingCompleteBox) {
        typingCompleteBox.hidden = false;
        const msg = node("span", undefined, `🎉 Completed! ${wpm} WPM · ${acc}% Accuracy`);
        const nextBtn = button("primary-button flow-lounge-btn", "Next Snippet", () => {
          snippetIdx = (snippetIdx + 1) % SNIPPETS.length;
          resetTypingTest();
          typingInputEl.focus();
        });
        typingCompleteBox.replaceChildren(msg, nextBtn);
      }
    }
  }

  // ==========================================
  // 7. AMBIENT WEATHER SELECTOR (RIGHT RAIL)
  // ==========================================
  function buildWeatherCard() {
    const card = node("section", "flow-card flow-lounge-card");
    card.id = "flow-card-lounge-weather";

    const head = node("div", "flow-card-head");
    const title = node("h2", undefined, "Ambient Weather");
    head.append(title);

    const sub = node("p", "flow-lounge-subtitle", "Full-Screen Ambient Weather & Physics");

    const tabs = node("div", "flow-lounge-weather-tabs");
    const bRain = button("flow-lounge-weather-tab" + (weatherMode === "rain" ? " active" : ""), "🌧 Rain", () => setWeatherMode("rain"));
    bRain.setAttribute("data-mode", "rain");
    const bSnow = button("flow-lounge-weather-tab" + (weatherMode === "snow" ? " active" : ""), "❄️ Snow", () => setWeatherMode("snow"));
    bSnow.setAttribute("data-mode", "snow");
    const bClear = button("flow-lounge-weather-tab" + (weatherMode === "clear" ? " active" : ""), "✨ Clear", () => setWeatherMode("clear"));
    bClear.setAttribute("data-mode", "clear");
    tabs.append(bRain, bSnow, bClear);

    const keep = button("flow-lounge-weather-keep", "", () => {
      keepWeather = !keepWeather;
      try { localStorage.setItem(KEEP_WEATHER_KEY, keepWeather ? "1" : "0"); } catch {}
      paintKeep();
      syncWeather();
    });
    keep.setAttribute("role", "switch");
    const paintKeep = () => {
      keep.setAttribute("aria-checked", String(keepWeather));
      keep.classList.toggle("active", keepWeather);
      keep.textContent = keepWeather ? "Keeps going outside Lounge · On" : "Keep going outside Lounge · Off";
    };
    paintKeep();
    const hint = node("p", "flow-lounge-hint", "Rain drops splash and snowflakes settle upon cards and workspace headers.");
    card.append(head, sub, tabs, keep, hint);
    return card;
  }

  // ==========================================
  // 8. KEYBOARD SHORTCUTS FOR GAMES
  // ==========================================
  const KEY_DIRS = {
    ArrowUp: "up", w: "up", W: "up",
    ArrowDown: "down", s: "down", S: "down",
    ArrowLeft: "left", a: "left", A: "left",
    ArrowRight: "right", d: "right", D: "right",
  };
  const SNAKE_DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

  // Which game owns this key: the one whose card holds focus, or none.
  function gameFor(target) {
    const card = target?.closest?.(".flow-lounge-game");
    if (card?.id === "flow-card-lounge-arcade") return "breakout";
    if (card?.id === "flow-card-lounge-zen") return "snake";
    return null;
  }

  window.addEventListener("keydown", e => {
    if (!active || receded || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const game = gameFor(e.target);
    if (!game) return;
    const dir = KEY_DIRS[e.key];

    if (e.key === " ") {
      // A focused button already answers Space with its own click.
      if (e.target.tagName === "BUTTON") return;
      e.preventDefault();
      if (game === "breakout") breakoutStarted ? setBreakoutPaused(!breakoutPaused) : startBreakout();
      else snakeStarted ? setSnakePaused(!snakePaused) : startSnake();
      return;
    }
    if (!dir) return;
    e.preventDefault();

    if (game === "breakout" && breakoutState) {
      if (dir === "left") breakoutState.leftDown = true;
      if (dir === "right") breakoutState.rightDown = true;
      return;
    }

    if (game === "snake" && snakeState) {
      if (!snakeStarted || snakeState.gameOver) startSnake();
      else if (snakePaused) setSnakePaused(false);
      const next = SNAKE_DIRS[dir], cur = snakeState.dir;
      // No turning straight back into the body.
      if (next.x !== -cur.x || next.y !== -cur.y) snakeState.nextDir = next;
    }
  });

  window.addEventListener("keyup", e => {
    if (!breakoutState) return;
    const dir = KEY_DIRS[e.key];
    if (dir === "left") breakoutState.leftDown = false;
    if (dir === "right") breakoutState.rightDown = false;
  });

  if (typeof window !== "undefined") {
    window.addEventListener("resize", () => {
      if (weatherShown()) {
        resizeWeatherCanvas();
        updateObstacleRects();
      }
    });
    window.addEventListener("scroll", () => {
      if (weatherShown()) updateObstacleRects();
    }, { passive: true, capture: true });
  }

  // Stop visual work in hidden/minimized pages; retain game and weather state.
  document.addEventListener("visibilitychange", () => {
    if (breakoutAnimId) safeCancelAnim(breakoutAnimId);
    if (snakeAnimId) safeCancelAnim(snakeAnimId);
    if (weatherAnimId) safeCancelAnim(weatherAnimId);
    breakoutAnimId = snakeAnimId = weatherAnimId = null;
    if (active && !receded && !document.hidden) {
      breakoutAnimId = safeRequestAnim(drawBreakout);
      snakeAnimId = safeRequestAnim(drawSnake);
    }
    if (weatherShown() && !document.hidden) weatherAnimId = safeRequestAnim(drawWeather);
  });

  // ==========================================
  // 9. LIFECYCLE: ENTER, EXIT, RECEDE, RESUME
  // ==========================================
  let slideTimer = null;

  function clearSlideClasses() {
    if (slideTimer) { clearTimeout(slideTimer); slideTimer = null; }
    left.classList.remove("flow-slide-out-left", "flow-slide-in-left");
    right.classList.remove("flow-slide-out-right", "flow-slide-in-right");
    loungeLeft.classList.remove("flow-slide-out-left", "flow-slide-in-left");
    loungeRight.classList.remove("flow-slide-out-right", "flow-slide-in-right");
  }

  // One activity at a time on the left, chosen from a picker; the calm, always-on things on the right.
  const ACTIVITIES = [
    { id: "breakout", label: "Breakout" },
    { id: "snake", label: "Snake" },
    { id: "trivia", label: "Trivia" },
    { id: "typing", label: "Typing" },
  ];
  const ACTIVITY_KEY = "throughline:lounge-activity";
  let activity = (() => {
    try { const saved = localStorage.getItem(ACTIVITY_KEY); return ACTIVITIES.some(a => a.id === saved) ? saved : "breakout"; }
    catch { return "breakout"; }
  })();
  let activityTabs = [];
  let activityPanels = {};

  function buildPicker() {
    const bar = node("div", "flow-lounge-picker");
    bar.setAttribute("role", "tablist");
    bar.setAttribute("aria-label", "Lounge activity");
    activityTabs = ACTIVITIES.map(a => {
      const tab = button("flow-lounge-picker-tab", a.label, () => chooseActivity(a.id));
      tab.id = "flow-lounge-tab-" + a.id;
      tab.setAttribute("role", "tab");
      tab.setAttribute("data-activity", a.id);
      tab.setAttribute("aria-controls", activityPanels[a.id]?.id || "");
      return tab;
    });
    bar.addEventListener("keydown", e => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const i = ACTIVITIES.findIndex(a => a.id === activity);
      const next = ACTIVITIES[(i + step + ACTIVITIES.length) % ACTIVITIES.length].id;
      chooseActivity(next);
      activityTabs.find(tab => tab.getAttribute("data-activity") === next)?.focus?.();
    });
    bar.append(...activityTabs);
    return bar;
  }

  function chooseActivity(id) {
    // A game you switch away from waits, paused, where you left it.
    if (id !== "breakout") setBreakoutPaused(true);
    if (id !== "snake") setSnakePaused(true);
    activity = id;
    try { localStorage.setItem(ACTIVITY_KEY, id); } catch {}
    for (const tab of activityTabs) {
      const on = tab.getAttribute("data-activity") === id;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      tab.classList.toggle("active", on);
    }
    for (const [key, panel] of Object.entries(activityPanels)) panel.hidden = key !== id;
    updateObstacleRects();
  }

  function mountLoungeDecks() {
    activityPanels = {
      breakout: buildBreakoutCard(),
      snake: buildSnakeCard(),
      trivia: buildTriviaCard(),
      typing: buildTypingCard(),
    };
    for (const [id, panel] of Object.entries(activityPanels)) {
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", "flow-lounge-tab-" + id);
    }
    loungeLeft.replaceChildren(buildPicker(), ...Object.values(activityPanels));
    loungeRight.replaceChildren(buildWeatherCard(), buildQuoteCard());

    initBreakout();
    initSnake();
    updateBreakoutScores();
    updateSnakeScores();
    chooseActivity(activity);
  }

  function enter() {
    if (!window.relayFlow?.isOn?.()) return;
    active = true;
    wanted = true;
    receded = false;

    shell.classList.add("flow-lounge");
    toggle.setAttribute("aria-pressed", "true");
    toggle.classList.remove("flow-lounge-receded");
    toggle.title = "Leave Lounge: restore standard cards and full brightness";

    mountLoungeDecks();
    initWeatherSystem();

    clearSlideClasses();

    // Outgoing: flow-left and flow-right slide out of window
    left.hidden = true;
    right.hidden = true;
    left.classList.add("flow-slide-out-left");
    right.classList.add("flow-slide-out-right");

    // Incoming: lounge decks slide in from window edges
    loungeLeft.hidden = false;
    loungeRight.hidden = false;
    loungeLeft.classList.add("flow-slide-in-left");
    loungeRight.classList.add("flow-slide-in-right");

    slideTimer = setTimeout(() => {
      left.classList.remove("flow-slide-out-left");
      right.classList.remove("flow-slide-out-right");
      slideTimer = null;
      updateObstacleRects();
    }, 500);

    if (breakoutAnimId) safeCancelAnim(breakoutAnimId);
    breakoutAnimId = safeRequestAnim(drawBreakout);

    if (snakeAnimId) safeCancelAnim(snakeAnimId);
    snakeAnimId = safeRequestAnim(drawSnake);

    if (weatherAnimId) safeCancelAnim(weatherAnimId);
    weatherAnimId = safeRequestAnim(drawWeather);
  }

  function exit() {
    active = false;
    wanted = false;
    receded = false;

    shell.classList.remove("flow-lounge");
    toggle.setAttribute("aria-pressed", "false");
    toggle.classList.remove("flow-lounge-receded");
    toggle.title = "Lounge: ambient games and relaxation while agents work";

    if (breakoutAnimId) { safeCancelAnim(breakoutAnimId); breakoutAnimId = null; }
    if (snakeAnimId) { safeCancelAnim(snakeAnimId); snakeAnimId = null; }
    if (weatherAnimId) { safeCancelAnim(weatherAnimId); weatherAnimId = null; }
    if (quoteTimer) { safeClearInterval(quoteTimer); quoteTimer = null; }

    syncWeather();

    clearSlideClasses();

    // Outgoing: lounge cards slide out of window
    loungeLeft.hidden = true;
    loungeRight.hidden = true;
    loungeLeft.classList.add("flow-slide-out-left");
    loungeRight.classList.add("flow-slide-out-right");

    // Incoming: flow cards slide back in
    if (window.relayFlow?.isOn?.()) {
      left.hidden = false;
      right.hidden = false;
      left.classList.add("flow-slide-in-left");
      right.classList.add("flow-slide-in-right");
    }

    slideTimer = setTimeout(() => {
      loungeLeft.classList.remove("flow-slide-out-left");
      loungeRight.classList.remove("flow-slide-out-right");
      slideTimer = null;
    }, 500);
  }

  function recede(reason = "attention") {
    if (!active || receded) return;
    receded = true;

    shell.classList.remove("flow-lounge");
    toggle.setAttribute("aria-pressed", "false");
    toggle.classList.add("flow-lounge-receded");
    toggle.title = reason === "done" ? "Run finished · Click to return to Lounge" : "Approval/question required · Click to return to Lounge";

    if (breakoutAnimId) { safeCancelAnim(breakoutAnimId); breakoutAnimId = null; }
    if (snakeAnimId) { safeCancelAnim(snakeAnimId); snakeAnimId = null; }
    if (weatherAnimId) { safeCancelAnim(weatherAnimId); weatherAnimId = null; }

    syncWeather();

    clearSlideClasses();

    // Outgoing: lounge cards slide out of window
    loungeLeft.hidden = true;
    loungeRight.hidden = true;
    loungeLeft.classList.add("flow-slide-out-left");
    loungeRight.classList.add("flow-slide-out-right");

    // Incoming: standard flow cards slide back in
    if (window.relayFlow?.isOn?.()) {
      left.hidden = false;
      right.hidden = false;
      left.classList.add("flow-slide-in-left");
      right.classList.add("flow-slide-in-right");
    }

    slideTimer = setTimeout(() => {
      loungeLeft.classList.remove("flow-slide-out-left");
      loungeRight.classList.remove("flow-slide-out-right");
      slideTimer = null;
    }, 500);
  }

  function resume() {
    if (!active || !receded) return;
    receded = false;

    shell.classList.add("flow-lounge");
    toggle.setAttribute("aria-pressed", "true");
    toggle.classList.remove("flow-lounge-receded");
    toggle.title = "Leave Lounge: restore standard cards and full brightness";

    initWeatherSystem();
    clearSlideClasses();

    // Outgoing: flow cards slide out
    left.hidden = true;
    right.hidden = true;
    left.classList.add("flow-slide-out-left");
    right.classList.add("flow-slide-out-right");

    // Incoming: lounge cards slide back in
    loungeLeft.hidden = false;
    loungeRight.hidden = false;
    loungeLeft.classList.add("flow-slide-in-left");
    loungeRight.classList.add("flow-slide-in-right");

    slideTimer = setTimeout(() => {
      left.classList.remove("flow-slide-out-left");
      right.classList.remove("flow-slide-out-right");
      slideTimer = null;
      updateObstacleRects();
    }, 500);

    if (breakoutAnimId) safeCancelAnim(breakoutAnimId);
    breakoutAnimId = safeRequestAnim(drawBreakout);

    if (snakeAnimId) safeCancelAnim(snakeAnimId);
    snakeAnimId = safeRequestAnim(drawSnake);

    if (weatherAnimId) safeCancelAnim(weatherAnimId);
    weatherAnimId = safeRequestAnim(drawWeather);
  }

  function toggleLounge() {
    if (receded) resume();
    else if (active) exit();
    else enter();
  }

  toggle.addEventListener("click", toggleLounge);

  window.addEventListener("relay-state", () => {
    if (!window.relayFlow?.isOn?.()) {
      if (active) exit();
      toggle.hidden = true;
      syncWeather();
      return;
    }
    toggle.hidden = false;
    if (weatherShown() !== Boolean(weatherCanvas)) syncWeather();

    const state = api.getState();
    const c = state.conversation;
    const running = api.isRunning();
    const waiting = c?.pendingApprovals || [];
    const attention = waiting.length > 0 || Boolean(c?.activeRun && waiting.some(item => item.kind === "question"));

    if (active && !receded) {
      if (attention) recede("attention");
      else if (!running && lastRunning) recede("done");
    } else if (active && receded && wanted && running && !attention) {
      resume();
    }

    lastRunning = running;
  });

  window.addEventListener("relay-flow", e => {
    const on = Boolean(e?.detail?.on);
    toggle.hidden = !on;
    if (!on && active) exit();
    syncWeather();
  });

  window.relayFlowLounge = {
    isActive: () => active && !receded,
    isWanted: () => wanted,
    isReceded: () => receded,
    enter,
    exit,
    toggle: toggleLounge,
    recede,
    resume,
    setWeatherMode,
    getWeatherMode: () => weatherMode,
    sync: (flowOn) => {
      toggle.hidden = !flowOn;
      if (!flowOn && active) exit();
      syncWeather();
    },
  };
})();
