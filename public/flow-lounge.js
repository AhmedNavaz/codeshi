(() => {
  "use strict";
  // Flow Lounge (#14): Play and relax while agents work.
  // - The stage on the left opens on a grid of everything there is to do, each with a title and a description.
  //   Choosing one fills the whole stage with it; All activities goes back to the grid.
  // - A quote and the weather switch share one row above the grid.
  // - The running chat moves to the right, where the right rail sits, and stays live and usable.
  // - Fullscreen ambient weather canvas (Rain, Snow, Clear) physically interacting with UI cards and panels.
  // - Games start only on click/interaction; keys reach only the game whose board holds focus.
  // - Auto-recedes when approvals or agent attention is needed.

  const $ = id => document.getElementById(id), api = window.relayUI, shell = $("app-shell");
  const toggle = $("toggle-flow-lounge");
  const left = $("flow-left"), right = $("flow-right");
  const loungeLeft = $("flow-lounge-left");

  if (!api || !shell || !toggle || !loungeLeft) return;
  toggle.setAttribute("aria-pressed", "false");

  const safeClearInterval = id => { if (typeof clearInterval === "function") try { clearInterval(id); } catch {} };
  const safeCancelAnim = id => { if (typeof cancelAnimationFrame === "function") try { cancelAnimationFrame(id); } catch {} };
  const safeSetInterval = (fn, ms) => typeof setInterval === "function" ? setInterval(fn, ms) : null;
  const safeRequestAnim = fn => typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : null;
  const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  const button = (cls, text, handler) => { const el = node("button", cls, text); el.type = "button"; if (handler) el.addEventListener("click", handler); return el; };
  // Line icons are CSS masks keyed by data-icon, so they take the text colour like the rest of the app's icons.
  const icon = (name, cls) => { const el = node("span", "flow-lounge-glyph" + (cls ? " " + cls : "")); el.setAttribute("data-icon", name); el.setAttribute("aria-hidden", "true"); return el; };

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
  // Set when the page scrolls: the surfaces are measured again before the next drawn frame, not on every scroll event.
  let obstaclesStale = false;
  // Steps of rain so far: the wind leans the rain a little more and less as it goes.
  let rainSteps = 0;
  const RAIN_DROPS = 150;
  // Weather is ambient, so it is drawn at most 30 times a second. Its motion is set in steps of a 60 Hz frame: each
  // drawn frame runs the steps for the time that has passed and draws the last, so a 120 Hz display neither speeds
  // the weather up nor draws it more often.
  const WEATHER_FRAME_MS = 1000 / 30, WEATHER_STEP_MS = 1000 / 60;
  let lastWeatherFrame = null, weatherLag = 0;
  // Asked once: the weather checks it on every frame, and a new query each time cost more than the drawing it decided.
  const motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)") || null;
  const reducedMotion = () => Boolean(motionQuery?.matches);

  function updateObstacleRects() {
    const rects = [];
    obstaclesStale = false;
    try {
      // The boxes a person sees: a prompt's bubble rather than the sticky row that holds it, the composer's frame rather
      // than the box inside it, a game's board rather than the area around it. Each must still be painted (below).
      const selectors = [
        // Center panel: prompt bubbles, code blocks, the composer
        ".message-user .message-text",
        ".code-block",
        ".composer",
        ".starter-prompts button",
        // Standard Flow cards and their buttons, so weather lands on them outside the Lounge too
        "#flow-left .flow-card",
        "#flow-right .flow-card",
        "#flow-left .flow-button",
        "#flow-right .flow-button",
        "#flow-right .flow-plan",
        // Lounge stage: the grid of activities, the open activity's board, controls and content blocks
        ".flow-lounge-tile",
        ".flow-lounge-canvas",
        ".flow-lounge-trivia-q",
        ".flow-lounge-trivia-opt",
        ".flow-lounge-trivia-feedback",
        ".flow-lounge-typing-snippet",
        ".flow-lounge-typing-input",
        "button.flow-lounge-btn",
        // Top bar buttons
        "#toggle-flow-lounge",
        "#leave-flow"
      ];
      const viewW = window.innerWidth || 1200, viewH = window.innerHeight || 800;
      const seen = new Set();
      const styles = new Map(), clips = new Map(), backdrops = new Map();
      const styleOf = el => {
        if (!styles.has(el)) styles.set(el, getComputedStyle(el));
        return styles.get(el);
      };
      // The fill behind an element: the nearest ancestor that paints one.
      const backdropOf = el => {
        if (!el) return "";
        if (!backdrops.has(el)) {
          const fill = styleOf(el).backgroundColor;
          backdrops.set(el, colourAlpha(fill) >= 0.06 ? fill : backdropOf(el.parentElement));
        }
        return backdrops.get(el);
      };
      // The part of the window the element's scrolling ancestors leave in view.
      const clipOf = el => {
        if (!el) return { left: 0, right: viewW, top: 0, bottom: viewH };
        if (!clips.has(el)) {
          const outer = clipOf(el.parentElement), style = styleOf(el);
          let clip = outer;
          if ((style.overflowX || "visible") !== "visible" || (style.overflowY || "visible") !== "visible") {
            const box = el.getBoundingClientRect();
            clip = { left: Math.max(outer.left, box.left), right: Math.min(outer.right, box.right), top: Math.max(outer.top, box.top), bottom: Math.min(outer.bottom, box.bottom) };
          }
          clips.set(el, clip);
        }
        return clips.get(el);
      };
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          if (!el || el.hidden || seen.has(el)) return;
          seen.add(el);
          const r = el.getBoundingClientRect();
          if (!(r.width > 20 && r.height > 8) || r.top < 0 || r.top > viewH || r.right < 0 || r.left > viewW) return;
          // Hidden or faded out, as a card is while it slides away.
          if (typeof el.checkVisibility === "function"
            ? !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })
            : el.offsetParent === null) return;
          const style = styleOf(el);
          // Nothing to land on unless the element is painted: a top border, a fill or a gradient that shows against what
          // is behind it. A fill or gradient in the page's own colour, as behind a sticky prompt, is an edge no one sees.
          const behind = backdropOf(el.parentElement);
          const edged = parseFloat(style.borderTopWidth) >= 0.5 && !["none", "hidden"].includes(style.borderTopStyle) && colourShows(style.borderTopColor, behind);
          const image = String(style.backgroundImage || "none");
          const pictured = image !== "none" && (/url\(/.test(image) || (image.match(COLOUR_PATTERN) || []).some(stop => colourShows(stop, behind)));
          const filled = colourShows(style.backgroundColor, behind);
          if (!edged && !pictured && !filled) return;
          // Scrolled out of its panel: the top edge can't be seen, or only part of it can.
          const clip = clipOf(el.parentElement);
          if (r.top < clip.top - 0.5 || r.top >= clip.bottom) return;
          // Rounded corners: the ledge starts where the edge is nearly level.
          const corner = value => Math.min(parseFloat(value) || 0, r.height / 2, r.width / 2) * 0.3;
          const left = Math.max(r.left + corner(style.borderTopLeftRadius), clip.left);
          const right = Math.min(r.right - corner(style.borderTopRightRadius), clip.right);
          if (right - left < 12) return;
          // Covered by something else, as Flow's cards are while the Lounge fills the window.
          if (typeof document.elementFromPoint === "function") {
            for (const at of [0.15, 0.5, 0.85]) {
              const top = document.elementFromPoint(left + (right - left) * at, Math.min(r.top + 2, r.bottom - 1));
              if (!top || !(top === el || el.contains(top) || top.contains(el))) return;
            }
          }
          rects.push({ el: el, left, right, top: r.top, bottom: r.bottom, elLeft: r.left });
        });
      });
    } catch {}
    cachedObstacles = rects;

    // Settled snow moves with its surface (on scroll or a layout shift) and goes when that surface is no longer in view.
    const ledges = new Map(rects.map(obs => [obs.el, obs]));
    for (let i = settledSnow.length - 1; i >= 0; i--) {
      const sn = settledSnow[i];
      if (!sn.el) continue;
      const obs = ledges.get(sn.el);
      const x = obs ? obs.elLeft + sn.relX : 0;
      if (!obs || x < obs.left - 2 || x > obs.right + 2) {
        settledSnow.splice(i, 1);
        continue;
      }
      sn.x = x;
      sn.y = obs.top + sn.relY;
    }
  }

  // The colours a browser writes in computed styles: rgb() and rgba(), color(srgb …) from color-mix(), or transparent.
  const COLOUR_PATTERN = /rgba?\([^)]*\)|color\(srgb[^)]*\)|transparent/g;

  // A computed colour as [red, green, blue, alpha], with channels 0–255 and alpha 0–1; null when it can't be read.
  function parseColour(value) {
    const text = String(value || "").trim();
    if (!text || text === "transparent") return [0, 0, 0, 0];
    const alphaOf = (number, percent) => number === undefined ? 1 : Number(number) / (percent ? 100 : 1);
    const legacy = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/);
    if (legacy) return [Number(legacy[1]), Number(legacy[2]), Number(legacy[3]), alphaOf(legacy[4], legacy[5])];
    const srgb = text.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/);
    if (srgb) return [srgb[1] * 255, srgb[2] * 255, srgb[3] * 255, alphaOf(srgb[4], srgb[5])];
    return null;
  }

  // How opaque a computed colour is: 0 for transparent, 1 for solid.
  function colourAlpha(value) {
    const colour = parseColour(value);
    return colour ? colour[3] : 1;
  }

  // Whether a colour painted over the backdrop changes it enough to see: a few levels in one channel at least.
  // A colour or backdrop that can't be read counts as showing, as long as the colour isn't nearly transparent.
  function colourShows(value, backdrop) {
    const colour = parseColour(value);
    if (colour && colour[3] < 0.05) return false;
    const under = parseColour(backdrop);
    if (!colour || !under || under[3] === 0) return colourAlpha(value) >= 0.05;
    const change = Math.max(...[0, 1, 2].map(i => Math.abs(colour[i] - under[i]))) * colour[3];
    return change >= 4;
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
    for (let i = 0; i < RAIN_DROPS; i++) rainDrops.push(newRainDrop(w, h, true));
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

  // A raindrop at its own distance: a near one is longer, faster, thicker and brighter, a far one short, slow and faint.
  // Far drops fall behind everything and land only at the bottom of the window; most near ones splash on the first
  // surface they meet.
  function newRainDrop(w, h, anywhere) {
    const z = Math.random();
    return {
      z,
      x: Math.random() * (w + 240) - 120,
      y: anywhere ? Math.random() * h : -15 - Math.random() * 25,
      vy: 12 + z * 12 + Math.random() * 2,
      len: 10 + z * 18 + Math.random() * 4,
      width: 0.6 + z * 0.9,
      alpha: 0.16 + z * 0.42,
      lands: z > 0.4 && Math.random() < 0.8,
      trail: 0
    };
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

  // Weather falls only while the Lounge is open. A full-window canvas redrawn 30 times a second costs about a tenth of
  // a core with the GPU work on top, so it stops when you leave the Lounge or it recedes for an approval or a finished
  // run, and starts again where it was when you come back. The choice of Rain, Snow or Clear is kept meanwhile.
  const weatherShown = () => active && !receded;
  function syncWeather() {
    syncSound();
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

  // ==========================================
  // WEATHER SOUND
  // ==========================================
  // Real recorded loops (public/sounds, credits in CREDITS.md), decoded once and looped without a gap. Rain and Snow each have
  // their own; Clear is silent. A sound plays only while the weather itself is showing, fades in and out, and follows the
  // volume slider, which is remembered on this computer. Nothing plays until you choose Rain or Snow, so there is no surprise sound.
  const VOLUME_KEY = "codeshi:lounge-volume";
  const SOUND_FILES = { rain: "/sounds/rain.m4a", snow: "/sounds/snow.m4a" };
  let volume = (() => { try { const v = parseFloat(localStorage.getItem(VOLUME_KEY)); return v >= 0 && v <= 1 ? v : 0.5; } catch { return 0.5; } })();
  let audioCtx = null, audioMaster = null;
  const beds = {};
  function soundContext() {
    if (audioCtx) return audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      audioCtx = new Ctx();
      audioMaster = audioCtx.createGain();
      audioMaster.gain.value = volume * volume;
      audioMaster.connect(audioCtx.destination);
    } catch { audioCtx = null; }
    return audioCtx;
  }
  async function loadBed(id) {
    const ctx = soundContext();
    if (!ctx || !SOUND_FILES[id]) return null;
    const bed = beds[id] || (beds[id] = { buffer: null, loading: null, gain: null, source: null });
    if (bed.buffer) return bed;
    bed.loading = bed.loading || fetch(SOUND_FILES[id]).then(r => { if (!r.ok) throw new Error(); return r.arrayBuffer(); })
      .then(data => new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject)))
      .then(buffer => { bed.buffer = buffer; return bed; })
      .catch(() => { bed.loading = null; return null; });
    return bed.loading;
  }
  function fadeBed(bed, to, seconds) {
    if (!bed?.gain || !audioCtx) return;
    const now = audioCtx.currentTime;
    bed.gain.gain.cancelScheduledValues(now);
    bed.gain.gain.setValueAtTime(bed.gain.gain.value, now);
    bed.gain.gain.linearRampToValueAtTime(to, now + seconds);
  }
  // Brings the sound in line with the weather: the wanted bed fades in, any other fades out and is released.
  async function syncSound() {
    const want = weatherShown() && SOUND_FILES[weatherMode] ? weatherMode : null;
    for (const id of Object.keys(beds)) {
      const bed = beds[id];
      if (id === want || !bed.source) continue;
      fadeBed(bed, 0, 1.2);
      const { source, gain } = bed;
      bed.source = null; bed.gain = null;
      setTimeout(() => { try { source.stop(); source.disconnect(); gain.disconnect(); } catch {} }, 1400);
    }
    if (!want) return;
    const bed = await loadBed(want);
    // The choice may have changed while the file loaded.
    if (!bed?.buffer || bed.source || !(weatherShown() && weatherMode === want)) return;
    const ctx = audioCtx;
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }
    const source = ctx.createBufferSource();
    source.buffer = bed.buffer; source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain); gain.connect(audioMaster);
    source.start();
    bed.source = source; bed.gain = gain;
    fadeBed(bed, 1, 1.6);
  }
  // The slider is perceptual: the square of its position, so the lower half is gentle rather than all the same quiet.
  function setVolume(v, save = true) {
    volume = Math.min(1, Math.max(0, v));
    if (audioMaster && audioCtx) audioMaster.gain.setTargetAtTime(volume * volume, audioCtx.currentTime, 0.05);
    if (save) { try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch {} }
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

    if (obstaclesStale || time - lastObstacleUpdate > 800) {
      lastObstacleUpdate = time;
      updateObstacleRects();
    }

    for (let step = 1; step <= steps; step++) stepWeather(step === steps ? ctx : null, w, h);

    if (weatherShown()) weatherAnimId = safeRequestAnim(drawWeather);
  }

  // One 60 Hz step of rain or snow. It draws only when given the canvas context: the last step of a drawn frame.
  function stepWeather(ctx, w, h) {
    if (weatherMode === "rain") {
      // Rain is pale and thin, like light caught on falling water; darker on the light theme so it still shows.
      const light = document.documentElement?.getAttribute?.("data-theme") === "light";
      const colour = light ? "rgb(72, 98, 134)" : "rgb(198, 216, 238)";
      if (ctx) {
        ctx.strokeStyle = colour;
        ctx.fillStyle = colour;
        ctx.lineCap = "round";
      }
      // One wind for all the rain, so every streak leans the same way; it eases up and down slowly.
      const slant = 0.07 + 0.03 * Math.sin(rainSteps++ * 0.005);

      for (let i = 0; i < rainDrops.length; i++) {
        const d = rainDrops[i];
        const nextX = d.x - slant * d.vy;
        const nextY = d.y + d.vy;

        // A near drop lands on the first visible top edge it crosses.
        let hit = false;
        let hitY = h;
        if (d.lands) {
          for (let j = 0; j < cachedObstacles.length; j++) {
            const obs = cachedObstacles[j];
            if (nextX >= obs.left && nextX <= obs.right && d.y < obs.top && nextY >= obs.top) {
              hit = true;
              hitY = obs.top;
              break;
            }
          }
        }

        // Every drop that reaches the bottom of the window lands there, far ones too, so the rain meets a floor.
        if (!hit && nextY >= h) {
          hit = true;
          hitY = h - 2;
        }

        if (hit) {
          // A small crown: two or three fine droplets thrown up and a thin ring that spreads along the edge.
          const count = d.lands ? (Math.random() < 0.5 ? 3 : 2) : 1;
          for (let s = 0; s < count; s++) {
            rainSplashes.push({
              x: nextX,
              y: hitY,
              floor: hitY,
              vx: (Math.random() - 0.5) * 2.6 - slant * 3,
              vy: -(0.9 + Math.random() * 1.5),
              r: 0.45 + Math.random() * 0.45,
              alpha: Math.min(0.2 + d.alpha, 0.8),
              decay: 0.05 + Math.random() * 0.04
            });
          }
          if (rainRipples.length < 50) {
            rainRipples.push({ x: nextX, y: hitY, rx: 1, maxR: 3 + d.z * 4, alpha: 0.15 + d.alpha * 0.5, growth: 0.45, decay: 0.04 });
          }
        }

        if (hit) {
          // A new drop starts above the view.
          Object.assign(d, newRainDrop(w, h, false));
        } else {
          d.x = nextX;
          d.y = nextY;
          if (ctx) {
            // A frame is drawn every second step or so. The streak also covers the way the drop fell since the last
            // drawn frame, as the 60 Hz frames between them did together, so the rain reads as streaks, not dashes.
            // It is fainter by as much as it is longer, so the rain gives off the same light as at 60 frames a second.
            const len = d.len + d.trail;
            const fade = d.len / len;
            // The streak trails behind the drop, up and into the wind: faint along its length, brighter at the head.
            ctx.lineWidth = d.width;
            ctx.globalAlpha = d.alpha * fade * 0.55;
            ctx.beginPath();
            ctx.moveTo(d.x, d.y);
            ctx.lineTo(d.x + slant * len, d.y - len);
            ctx.stroke();
            ctx.globalAlpha = d.alpha * fade;
            ctx.beginPath();
            ctx.moveTo(d.x, d.y);
            ctx.lineTo(d.x + slant * len * 0.4, d.y - len * 0.4);
            ctx.stroke();
            d.trail = 0;
          } else {
            d.trail += d.vy;
          }
        }
      }

      // Droplets of a splash rise, fall back and are gone when they reach the surface again.
      for (let i = rainSplashes.length - 1; i >= 0; i--) {
        const sp = rainSplashes[i];
        sp.x += sp.vx;
        sp.y += sp.vy;
        sp.vy += 0.25; // gravity
        sp.alpha -= sp.decay;

        if (sp.alpha <= 0 || sp.y > sp.floor) {
          rainSplashes.splice(i, 1);
          continue;
        }

        if (!ctx) continue;
        ctx.globalAlpha = sp.alpha;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, sp.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // The ring a drop leaves on a surface: flat, thin and quick to fade.
      if (ctx) ctx.lineWidth = 0.8;
      for (let i = rainRipples.length - 1; i >= 0; i--) {
        const rp = rainRipples[i];
        rp.rx += rp.growth;
        rp.alpha -= rp.decay;
        if (rp.alpha <= 0 || rp.rx >= rp.maxR) {
          rainRipples.splice(i, 1);
          continue;
        }
        if (!ctx) continue;
        ctx.globalAlpha = rp.alpha;
        ctx.beginPath();
        if (ctx.ellipse) {
          ctx.ellipse(rp.x, rp.y, rp.rx, rp.rx * 0.28, 0, 0, Math.PI * 2);
        } else {
          ctx.arc(rp.x, rp.y, rp.rx, 0, Math.PI * 2);
        }
        ctx.stroke();
      }
      if (ctx) ctx.globalAlpha = 1;
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
              const relX = c.x - obs.elLeft;
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
          if (nextX >= obs.left && nextX <= obs.right && f.y < obs.top && nextY >= obs.top) {
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
          // Kept relative to the element, so the snow moves with it; the ledge can be narrower than the element.
          const relX = nextX - obs.elLeft;

          // Count local settled flakes near this landing spot to determine mound height & accumulation
          let localCount = 0;
          for (let k = 0; k < settledSnow.length; k++) {
            const sn = settledSnow[k];
            if (sn.el === obs.el && Math.abs(sn.relX - relX) < 9) {
              localCount++;
            }
          }

          const distToLeft = nextX - obs.left;
          const distToRight = obs.right - nextX;
          const isNearEdge = distToLeft < 7 || distToRight < 7;

          // When snow builds up or lands near the edge: it rolls / slides sideways!
          if (isNearEdge || localCount >= 3) {
            const dir = (distToRight < distToLeft || (distToLeft === distToRight && Math.random() < 0.5)) ? 1 : -1;
            const slideAmount = Math.random() * 8 + 5;
            const newRelX = relX + dir * slideAmount;

            // Did it slide off the edge of the obstacle? (Dropping from sideways!)
            if (obs.elLeft + newRelX < obs.left || obs.elLeft + newRelX > obs.right) {
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
                  x: obs.elLeft + newRelX,
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
    syncSound();
    const options = document.querySelectorAll(".flow-lounge-weather-option");
    options.forEach(t => {
      const match = t.getAttribute("data-mode") === mode;
      t.classList.toggle("active", match);
      t.setAttribute("aria-pressed", String(match));
    });
    refreshTiles();
  }

  // Breakout and Snake move in steps of a 60 Hz frame, as the weather does, so they play at the same speed on a 60 Hz
  // and a 120 Hz display. A game's clock tells how many steps the time since its last frame covers.
  const GAME_STEP_MS = 1000 / 60;
  const gameClock = () => ({ last: null, lag: 0 });
  function gameSteps(clock, time) {
    // The first frame after a game starts, resumes or comes back into view takes one step, as every frame used to.
    if (clock.last === null || !(time >= clock.last)) { clock.last = time; clock.lag = 0; return 1; }
    // A frame up to a millisecond early still counts as a step, and after a stall a game catches up by a few at most.
    clock.lag = Math.min(clock.lag + time - clock.last, 4 * GAME_STEP_MS);
    clock.last = time;
    const steps = Math.floor((clock.lag + 1) / GAME_STEP_MS);
    clock.lag -= steps * GAME_STEP_MS;
    return steps;
  }

  // ==========================================
  // BOARDS THAT FILL THE STAGE
  // ==========================================
  // Each game keeps its own small coordinate space (Breakout 320×200, Snake 300×195). The board is drawn as large as
  // the stage allows at that shape, at the screen's pixel density, so it stays sharp when it fills the area.
  function fitBoard(canvas, ctx, logicalW, logicalH) {
    const wrap = canvas?.parentNode;
    if (!wrap?.getBoundingClientRect) return false;
    const box = wrap.getBoundingClientRect();
    if (!box.width || !box.height) return false;
    const scale = Math.max(0.5, Math.min(box.width / logicalW, box.height / logicalH));
    const cssW = Math.floor(logicalW * scale), cssH = Math.floor(logicalH * scale);
    const dpr = Math.min(3, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    const backW = Math.round(cssW * dpr), backH = Math.round(cssH * dpr);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    if (canvas.width !== backW || canvas.height !== backH) { canvas.width = backW; canvas.height = backH; }
    ctx?.setTransform?.(backW / logicalW, 0, 0, backH / logicalH, 0, 0);
    return true;
  }

  function fitBoards() {
    if (fitBoard(breakoutCanvas, breakoutCtx, 320, 200) && !breakoutAnimId) breakoutAnimId = safeRequestAnim(drawBreakout);
    if (fitBoard(snakeCanvas, snakeCtx, 300, 195) && !snakeAnimId) snakeAnimId = safeRequestAnim(drawSnake);
  }

  const boardObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => fitBoards()) : null;
  const watchBoard = wrap => { try { boardObserver?.observe(wrap); } catch {} };

  // ==========================================
  // 2. LEFT RAIL: BREAKOUT MINI-GAME
  // ==========================================
  let breakoutState = null;
  let breakoutAnimId = null;
  let breakoutClock = gameClock();
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
    breakoutClock = gameClock();
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

  function drawBreakout(time) {
    breakoutAnimId = null;
    if (!active || receded || document.hidden || !breakoutCtx || !breakoutCanvas) return;
    const s = breakoutState;
    const moving = Boolean(s && breakoutStarted && !breakoutPaused && !s.gameOver && !s.won);
    const steps = moving ? gameSteps(breakoutClock, time) : 0;
    // On a display faster than 60 Hz, a frame between two steps has nothing new to draw.
    if (moving && !steps) {
      breakoutAnimId = safeRequestAnim(drawBreakout);
      return;
    }
    const ctx = breakoutCtx;
    ctx.clearRect(0, 0, 320, 200);

    if (s) {
      if (!breakoutStarted && !s.gameOver && !s.won) {
        s.ball.x = s.paddle.x + s.paddle.w / 2;
        s.ball.y = s.paddle.y - s.ball.r - 1;
      } else {
        for (let step = 0; step < steps; step++) stepBreakout();
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
    const card = node("section", "flow-lounge-card flow-lounge-panel flow-lounge-board-panel");
    card.id = "flow-card-lounge-arcade";

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
    watchBoard(canvasWrap);

    breakoutStatusEl = node("div", "flow-lounge-status-line", BREAKOUT_READY);

    breakoutCanvas.addEventListener("mousemove", e => {
      if (breakoutState) {
        const rect = breakoutCanvas.getBoundingClientRect ? breakoutCanvas.getBoundingClientRect() : { left: 0, width: 320 };
        const scaleX = breakoutState.w / (rect.width || breakoutState.w);
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

    foot.append(breakoutStatusEl, bStartBreakout, bRestart);
    card.append(scorePill, canvasWrap, foot);
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
  let snakeClock = gameClock();
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
      // Time played, counted in 60 Hz steps, and when the snake last moved. Its first move comes at once.
      played: 0,
      lastTick: -Infinity,
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
    snakeClock = gameClock();
    snakeAnimId = safeRequestAnim(drawSnake);
  }

  function setSnakePaused(paused) {
    if (!snakeStarted || snakePaused === paused) return;
    snakePaused = paused;
    if (bStartSnake) bStartSnake.textContent = paused ? "Resume" : "Pause";
    if (snakeStatusEl) snakeStatusEl.textContent = paused ? "Paused · Space or Resume to continue" : "Playing · Arrow keys or WASD · Space to pause";
    if (!paused) loopSnake();
  }

  // One 60 Hz step of Snake. The snake moves once its tick has passed.
  function stepSnake() {
    const s = snakeState;
    if (!s || !snakeStarted || snakePaused || s.gameOver) return;
    s.played += GAME_STEP_MS;
    if (s.played - s.lastTick < s.tickRate) return;
    s.lastTick = s.played;

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
    const s = snakeState;
    const moving = Boolean(s && snakeStarted && !snakePaused && !s.gameOver);
    const steps = moving ? gameSteps(snakeClock, time) : 0;
    // On a display faster than 60 Hz, a frame between two steps has nothing new to draw.
    if (moving && !steps) {
      snakeAnimId = safeRequestAnim(drawSnake);
      return;
    }
    const ctx = snakeCtx;
    ctx.clearRect(0, 0, 300, 195);

    if (s) {
      for (let step = 0; step < steps; step++) stepSnake();

      // A faint grid so the snake's lanes read at full size.
      ctx.fillStyle = "rgba(148, 163, 184, 0.09)";
      for (let gx = 0; gx < s.cols; gx++) {
        for (let gy = 0; gy < s.rows; gy++) {
          ctx.fillRect(gx * s.size + s.size / 2 - 0.6, gy * s.size + s.size / 2 - 0.6, 1.2, 1.2);
        }
      }

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
    const card = node("section", "flow-lounge-card flow-lounge-panel flow-lounge-board-panel");
    card.id = "flow-card-lounge-zen";

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
    watchBoard(canvasWrap);

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

    foot.append(snakeStatusEl, bStartSnake, bRestart);
    card.append(scorePill, canvasWrap, foot);
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
    const card = node("section", "flow-lounge-card flow-lounge-panel flow-lounge-read-panel");
    card.id = "flow-card-lounge-trivia";

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

    card.append(meta, qEl, optWrap, feedWrap);
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
    const card = node("figure", "flow-lounge-quote");
    card.id = "flow-card-lounge-quote";
    card.setAttribute("aria-label", "Developer wisdom");

    const words = node("div", "flow-lounge-quote-words");
    qTextEl = node("blockquote", "flow-lounge-quote-text");
    qAuthorEl = node("figcaption", "flow-lounge-quote-author");
    const meta = node("div", "flow-lounge-quote-meta");
    words.append(qTextEl, meta);
    const nextBtn = button("flow-lounge-quote-next", "Another", () => {
      nextQuote();
      // Choosing one restarts the 20-second clock, so it isn't replaced straight away.
      if (quoteTimer) safeClearInterval(quoteTimer);
      quoteTimer = safeSetInterval(nextQuote, 20000);
    });
    nextBtn.title = "Another quote. A new one appears every 20 seconds.";
    nextBtn.setAttribute("aria-label", "Another quote");
    meta.append(qAuthorEl, nextBtn);
    card.append(icon("quote", "flow-lounge-quote-icon"), words);

    showQuote(Math.floor(Math.random() * QUOTES.length));
    if (quoteTimer) safeClearInterval(quoteTimer);
    quoteTimer = safeSetInterval(nextQuote, 20000);
    return card;
  }

  function showQuote(idx) {
    quoteIdx = idx % QUOTES.length;
    const q = QUOTES[quoteIdx];
    if (qTextEl) { qTextEl.textContent = `“${q.quote}”`; qTextEl.title = q.quote; }
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
    const card = node("section", "flow-lounge-card flow-lounge-panel flow-lounge-read-panel");
    card.id = "flow-card-lounge-typing";

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

    card.append(stats, typingSnippetEl, typingInputEl, typingCompleteBox, foot);
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
    const card = node("div", "flow-lounge-weather");
    card.id = "flow-card-lounge-weather";
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", "Weather");

    const options = node("div", "flow-lounge-weather-options");
    for (const mode of WEATHER_MODES) {
      const option = button("flow-lounge-weather-option" + (weatherMode === mode.id ? " active" : ""), "", () => setWeatherMode(mode.id));
      option.setAttribute("data-mode", mode.id);
      option.setAttribute("aria-pressed", String(weatherMode === mode.id));
      option.title = mode.note;
      option.append(icon(mode.icon, "flow-lounge-weather-icon"), node("span", undefined, mode.label));
      options.append(option);
    }

    // A short caption over the three choices, which fall over the chat in Flow and the Lounge.
    const words = node("div", "flow-lounge-weather-words");
    // Volume for the sound that goes with Rain and Snow.
    const level = node("label", "flow-lounge-weather-volume");
    level.title = "Volume of the rain and snow sound";
    const slider = node("input", "flow-lounge-weather-slider");
    slider.type = "range"; slider.min = "0"; slider.max = "100"; slider.step = "1";
    slider.value = String(Math.round(volume * 100));
    slider.setAttribute("aria-label", "Weather sound volume");
    slider.addEventListener("input", () => { setVolume(Number(slider.value) / 100); level.classList.toggle("muted", volume === 0); });
    level.classList.toggle("muted", volume === 0);
    level.append(icon("volume", "flow-lounge-weather-speaker"), slider);
    const title = node("span", "flow-lounge-weather-title", "Weather");
    const head = node("div", "flow-lounge-weather-head");
    head.append(title, level);
    words.append(head, options);
    card.append(words);
    return card;
  }

  // One row above the grid: the quote on the left, the weather on the right. It belongs to the grid, so an open activity gets the whole stage.
  function buildAmbientBar() {
    const bar = node("footer", "flow-lounge-ambient");
    bar.id = "flow-lounge-ambient";
    bar.append(buildQuoteCard(), buildWeatherCard());
    return bar;
  }

  const WEATHER_MODES = [
    { id: "rain", label: "Rain", note: "Drops splash on the chat and cards", icon: "rain" },
    { id: "snow", label: "Snow", note: "Flakes settle and slide off edges", icon: "snow" },
    { id: "clear", label: "Clear", note: "Nothing falling", icon: "clear" },
  ];

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
      if (weatherShown()) obstaclesStale = true;
    }, { passive: true, capture: true });
  }

  // Stop visual work in hidden/minimized pages; retain game and weather state.
  document.addEventListener("visibilitychange", () => {
    if (breakoutAnimId) safeCancelAnim(breakoutAnimId);
    if (snakeAnimId) safeCancelAnim(snakeAnimId);
    if (weatherAnimId) safeCancelAnim(weatherAnimId);
    breakoutAnimId = snakeAnimId = weatherAnimId = null;
    // A game coming back into view goes on from where it was, not from where the hidden time would have taken it.
    breakoutClock = gameClock();
    snakeClock = gameClock();
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

  const PINNED = ["position", "left", "top", "width", "height", "margin", "boxSizing"];
  // Something sliding away keeps the place and size it had, whatever the columns do underneath it. Without this a
  // rail stretches across the Lounge's wide column, or the stage shrinks into the left rail's, as it leaves.
  const placeOf = el => { try { return el.hidden ? null : el.getBoundingClientRect?.() || null; } catch { return null; } };
  function pin(el, r) {
    try {
      if (!r || !r.width || !r.height) return;
      Object.assign(el.style, { position: "fixed", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", margin: "0", boxSizing: "border-box" });
    } catch {}
  }
  function unpin(...els) {
    for (const el of els) try { for (const prop of PINNED) el.style[prop] = ""; } catch {}
  }
  const calmMotion = () => { try { return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches); } catch { return false; } };
  // The chat changes column when the Lounge opens or closes. It travels there instead of jumping, in step with
  // the rail beside it, so the rail never crosses over it.
  function moveChat(change, duration, easing) {
    const chat = shell.querySelector?.(".main-panel");
    let before = null;
    try { before = chat?.getBoundingClientRect?.() || null; } catch {}
    change();
    try {
      if (!chat || !before || typeof chat.animate !== "function" || calmMotion()) return;
      const dx = before.left - chat.getBoundingClientRect().left;
      if (Math.abs(dx) < 1) return;
      chat.animate([{ transform: `translate3d(${dx}px, 0, 0)` }, { transform: "translate3d(0, 0, 0)" }], { duration, easing });
    } catch {}
  }

  function clearSlideClasses() {
    if (slideTimer) { clearTimeout(slideTimer); slideTimer = null; }
    left.classList.remove("flow-slide-out-left", "flow-slide-in-left");
    right.classList.remove("flow-slide-out-right", "flow-slide-in-right");
    loungeLeft.classList.remove("flow-slide-out-left", "flow-slide-in-left");
    unpin(left, right, loungeLeft);
  }

  // Opening: the rails leave from where they stand, the chat follows the right rail into its column, and the
  // stage arrives from the left.
  function showStage() {
    // Measured first: clearing the slide classes restarts a rail's own entrance, which would move it.
    const leftAt = placeOf(left), rightAt = placeOf(right);
    clearSlideClasses();
    pin(left, leftAt);
    pin(right, rightAt);
    moveChat(() => shell.classList.add("flow-lounge"), 400, "cubic-bezier(.35, 0, .25, 1)");
    left.hidden = true;
    right.hidden = true;
    left.classList.add("flow-slide-out-left");
    right.classList.add("flow-slide-out-right");
    loungeLeft.hidden = false;
    loungeLeft.classList.add("flow-slide-in-left");
    fitBoards();
    slideTimer = setTimeout(() => {
      left.classList.remove("flow-slide-out-left");
      right.classList.remove("flow-slide-out-right");
      unpin(left, right);
      slideTimer = null;
      updateObstacleRects();
    }, 500);
  }

  // Closing: the stage leaves from where it stands, the chat goes back to the middle, and the rails come in
  // behind it.
  function hideStage() {
    const stageAt = placeOf(loungeLeft);
    clearSlideClasses();
    pin(loungeLeft, stageAt);
    moveChat(() => shell.classList.remove("flow-lounge"), 480, "cubic-bezier(.16, 1, .3, 1)");
    loungeLeft.hidden = true;
    loungeLeft.classList.add("flow-slide-out-left");
    if (window.relayFlow?.isOn?.()) {
      left.hidden = false;
      right.hidden = false;
      left.classList.add("flow-slide-in-left");
      right.classList.add("flow-slide-in-right");
    }
    slideTimer = setTimeout(() => {
      loungeLeft.classList.remove("flow-slide-out-left");
      unpin(loungeLeft);
      slideTimer = null;
    }, 500);
  }

  // The stage opens on a grid of the things to play. Choosing one fills the whole stage with it, and All activities
  // (or Escape) goes back to the grid. The quote and the weather aren't activities: they keep a bar of their own
  // along the foot of the stage, in view whatever is open. The chat sits on the right the whole time.
  const ACTIVITIES = [
    { id: "breakout", title: "Breakout", kind: "Game", keys: "Arrow keys or mouse", icon: "breakout",
      description: "Knock out the wall of bricks with a paddle and ball. Aim with where the ball meets the paddle.",
      build: () => buildBreakoutCard(), focus: () => breakoutCanvas, stat: () => bestLine("breakout") },
    { id: "snake", title: "Snake", kind: "Game", keys: "Arrow keys or WASD", icon: "snake",
      description: "Eat, grow and keep clear of the walls and your own tail. It speeds up as you score.",
      build: () => buildSnakeCard(), focus: () => snakeCanvas, stat: () => bestLine("snake") },
    { id: "trivia", title: "Code trivia", kind: "Quiz", keys: "Mouse", icon: "trivia",
      description: `${TRIVIA.length} questions on Git, JavaScript, Linux, SQL, CSS and more, each with the answer explained.`,
      build: () => buildTriviaCard(), focus: card => card.querySelector(".flow-lounge-trivia-opt"),
      stat: () => triviaTotal ? `${triviaScore} of ${triviaTotal} right` : "" },
    { id: "typing", title: "Typing test", kind: "Practice", keys: "Keyboard", icon: "typing",
      description: "Type real code snippets and see your words per minute and accuracy as you go.",
      build: () => buildTypingCard(), focus: () => typingInputEl, stat: () => "" },
  ];
  const bestLine = game => { const best = getBestScore(game); return best ? `Best ${best}` : ""; };

  let activity = null;
  let activityPanels = {};
  let homeEl = null, viewEl = null, viewTitleEl = null, viewNoteEl = null;
  let tiles = [];

  function buildHome() {
    homeEl = node("div", "flow-lounge-home");
    homeEl.id = "flow-lounge-home";
    const head = node("header", "flow-lounge-home-head");
    const heading = node("h2", undefined, "Lounge");
    const lead = node("p", undefined, "Take a break while the agents work. The chat stays live on the right, and the Lounge steps aside when an agent needs you.");
    head.append(heading, lead);

    const grid = node("div", "flow-lounge-grid");
    grid.setAttribute("role", "list");
    tiles = ACTIVITIES.map(a => {
      const item = node("div", "flow-lounge-grid-item");
      item.setAttribute("role", "listitem");
      const tile = button("flow-lounge-tile", "", () => openActivity(a.id));
      tile.id = "flow-lounge-tile-" + a.id;
      tile.setAttribute("data-activity", a.id);
      const art = node("span", "flow-lounge-tile-art");
      art.setAttribute("data-activity", a.id);
      art.append(icon(a.icon, "flow-lounge-tile-icon"));
      const text = node("span", "flow-lounge-tile-text");
      const title = node("span", "flow-lounge-tile-title", a.title);
      const desc = node("span", "flow-lounge-tile-desc", a.description);
      const meta = node("span", "flow-lounge-tile-meta");
      text.append(title, desc, meta);
      tile.append(art, text);
      item.append(tile);
      return tile;
    });
    grid.append(...tiles.map(tile => tile.parentNode));
    homeEl.append(head, buildAmbientBar(), grid);
    refreshTiles();
    return homeEl;
  }

  // The small line under each description: what kind of thing it is, how it's played, and your best so far.
  function refreshTiles() {
    for (const tile of tiles) {
      const a = ACTIVITIES.find(item => item.id === tile.getAttribute("data-activity"));
      const meta = tile.querySelector(".flow-lounge-tile-meta");
      if (!a || !meta) continue;
      meta.textContent = [a.kind, a.keys, a.stat()].filter(Boolean).join(" · ");
    }
  }

  function buildView() {
    viewEl = node("section", "flow-lounge-view");
    viewEl.id = "flow-lounge-view";
    viewEl.hidden = true;
    const bar = node("div", "flow-lounge-view-bar");
    const back = button("flow-lounge-back", "", () => showHome());
    back.id = "flow-lounge-back";
    back.append(icon("back", "flow-lounge-back-icon"), node("span", undefined, "All activities"));
    const titles = node("div", "flow-lounge-view-titles");
    viewTitleEl = node("h2", "flow-lounge-view-title");
    viewTitleEl.id = "flow-lounge-view-title";
    viewNoteEl = node("p", "flow-lounge-view-note");
    titles.append(viewTitleEl, viewNoteEl);
    bar.append(back, titles);
    const body = node("div", "flow-lounge-view-body");
    body.append(...Object.values(activityPanels));
    viewEl.setAttribute("aria-labelledby", viewTitleEl.id);
    viewEl.append(bar, body);
    return viewEl;
  }

  function pauseGames(except) {
    // A game you leave waits, paused, where you left it.
    if (except !== "breakout") setBreakoutPaused(true);
    if (except !== "snake") setSnakePaused(true);
  }

  function openActivity(id) {
    const a = ACTIVITIES.find(item => item.id === id);
    if (!a || !viewEl) return;
    pauseGames(id);
    activity = id;
    for (const [key, panel] of Object.entries(activityPanels)) panel.hidden = key !== id;
    viewTitleEl.textContent = a.title;
    viewNoteEl.textContent = a.description;
    homeEl.hidden = true;
    viewEl.hidden = false;
    viewEl.setAttribute("data-activity", id);
    fitBoards();
    // Keys go straight to what was opened: a game's board, the typing box, the first answer.
    try { a.focus(activityPanels[id])?.focus?.({ preventScroll: true }); } catch {}
    updateObstacleRects();
  }

  function showHome() {
    if (!homeEl || !viewEl) return;
    const from = activity;
    pauseGames(null);
    activity = null;
    viewEl.hidden = true;
    homeEl.hidden = false;
    refreshTiles();
    try { tiles.find(tile => tile.getAttribute("data-activity") === from)?.focus?.({ preventScroll: true }); } catch {}
    updateObstacleRects();
  }

  loungeLeft.addEventListener("keydown", e => {
    if (e.key !== "Escape" || !activity || e.defaultPrevented) return;
    e.preventDefault();
    showHome();
  });

  function mountLoungeDecks() {
    try { boardObserver?.disconnect(); } catch {}
    activityPanels = {};
    for (const a of ACTIVITIES) {
      const panel = a.build();
      panel.hidden = true;
      panel.setAttribute("data-activity", a.id);
      activityPanels[a.id] = panel;
    }
    activity = null;
    loungeLeft.replaceChildren(buildHome(), buildView());

    initBreakout();
    initSnake();
    updateBreakoutScores();
    updateSnakeScores();
  }

  function enter() {
    if (!window.relayFlow?.isOn?.()) return;
    active = true;
    wanted = true;
    receded = false;

    toggle.setAttribute("aria-pressed", "true");
    toggle.classList.remove("flow-lounge-receded");
    toggle.title = "Leave Lounge: restore standard cards and full brightness";

    mountLoungeDecks();
    initWeatherSystem();
    showStage();

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

    toggle.setAttribute("aria-pressed", "false");
    toggle.classList.remove("flow-lounge-receded");
    toggle.title = "Lounge: ambient games and relaxation while agents work";

    if (breakoutAnimId) { safeCancelAnim(breakoutAnimId); breakoutAnimId = null; }
    if (snakeAnimId) { safeCancelAnim(snakeAnimId); snakeAnimId = null; }
    if (weatherAnimId) { safeCancelAnim(weatherAnimId); weatherAnimId = null; }
    if (quoteTimer) { safeClearInterval(quoteTimer); quoteTimer = null; }

    syncWeather();
    hideStage();
  }

  function recede(reason = "attention") {
    if (!active || receded) return;
    receded = true;

    toggle.setAttribute("aria-pressed", "false");
    toggle.classList.add("flow-lounge-receded");
    toggle.title = reason === "done" ? "Run finished · Click to return to Lounge" : "Approval/question required · Click to return to Lounge";

    if (breakoutAnimId) { safeCancelAnim(breakoutAnimId); breakoutAnimId = null; }
    if (snakeAnimId) { safeCancelAnim(snakeAnimId); snakeAnimId = null; }
    if (weatherAnimId) { safeCancelAnim(weatherAnimId); weatherAnimId = null; }

    syncWeather();
    hideStage();
  }

  function resume() {
    if (!active || !receded) return;
    receded = false;

    toggle.setAttribute("aria-pressed", "true");
    toggle.classList.remove("flow-lounge-receded");
    toggle.title = "Leave Lounge: restore standard cards and full brightness";

    initWeatherSystem();
    showStage();

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
    open: openActivity,
    home: showHome,
    current: () => activity,
    activities: () => ACTIVITIES.map(a => ({ id: a.id, title: a.title })),
    sync: (flowOn) => {
      toggle.hidden = !flowOn;
      if (!flowOn && active) exit();
      syncWeather();
    },
  };
})();
