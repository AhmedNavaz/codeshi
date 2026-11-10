(() => {
  "use strict";
  // Lounge puzzles (#14): Codle, 2048, Minesweeper, Sudoku, Pairs and Fifteen.
  // - Each is an activity on the Lounge's grid (flow-lounge.js adds them after its own), with a panel built here.
  // - They're made of page elements, not a canvas, and have no animation loop: nothing runs between your moves.
  //   The only clocks (Minesweeper, Sudoku) tick once a second while you play and stop when you leave.
  // - Keys go to the board that holds focus. Escape is left alone, so it still goes back to the grid.
  // - Each game keeps its state while the Lounge is closed, and best results are kept on this computer.
  // - The rules are plain functions in `logic`, so tests can check them without a page.

  const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  const button = (cls, text, handler) => { const el = node("button", cls, text); el.type = "button"; if (handler) el.addEventListener("click", handler); return el; };
  const focusQuietly = el => { try { el?.focus?.({ preventScroll: true }); } catch {} };

  const PREFIX = "throughline:lounge-";
  const store = {
    get(key, fallback) {
      try { const raw = localStorage.getItem(PREFIX + key); return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch {} },
  };

  const range = n => Array.from({ length: n }, (_, i) => i);
  function shuffle(list, random = Math.random) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  const clockText = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // A clock that counts only while it runs. It redraws once a second, and not at all while stopped.
  function makeClock(onTick) {
    let elapsed = 0, since = null, timer = null;
    const now = () => Date.now();
    return {
      ms: () => elapsed + (since == null ? 0 : now() - since),
      running: () => since != null,
      run() {
        if (since != null) return;
        since = now();
        if (typeof setInterval === "function") timer = setInterval(onTick, 1000);
      },
      stop() {
        if (since == null) return;
        elapsed += now() - since;
        since = null;
        if (timer != null && typeof clearInterval === "function") clearInterval(timer);
        timer = null;
        onTick();
      },
      reset() { this.stop(); elapsed = 0; onTick(); },
    };
  }

  // Board keys: nothing with Command, Control or Option (those are the app's), nothing mid-composition, and
  // never Escape or Tab, which belong to the Lounge and the page.
  function onBoardKeys(el, handler) {
    el.addEventListener("keydown", e => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.key === "Escape" || e.key === "Tab") return;
      if (handler(e) === true) e.preventDefault();
    });
  }
  const ARROWS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  const WASD = { w: "up", W: "up", s: "down", S: "down", a: "left", A: "left", d: "right", D: "right" };
  const STEP = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };

  // The parts every panel shares: a row of figures, the board, and a foot with a spoken status line and buttons.
  function panel(id, extra) {
    const card = node("section", "flow-lounge-card flow-lounge-panel flow-lounge-puzzle" + (extra ? " " + extra : ""));
    card.id = "flow-card-lounge-" + id;
    return card;
  }
  function figures(list) {
    const row = node("div", "flow-lounge-score-pill flow-lounge-puzzle-figures");
    const values = {};
    for (const [key, label, value] of list) {
      const item = node("span", undefined, label);
      values[key] = node("strong", undefined, String(value ?? ""));
      item.append(values[key]);
      row.append(item);
    }
    return { el: row, set: (key, value) => { if (values[key]) values[key].textContent = String(value); } };
  }
  function statusLine(text) {
    const el = node("p", "flow-lounge-status-line flow-lounge-puzzle-status", text);
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    return el;
  }
  function foot(...items) {
    const el = node("div", "flow-card-foot flow-lounge-foot");
    el.append(...items);
    return el;
  }
  // A small set of choices, such as a level, drawn like the weather switch.
  function choices(label, options, current, pick) {
    const group = node("div", "flow-lounge-puzzle-levels");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    const buttons = options.map(option => {
      const b = button("flow-lounge-puzzle-level", option.label, () => pick(option.id));
      b.setAttribute("data-level", option.id);
      if (option.note) b.title = option.note;
      return b;
    });
    const mark = id => buttons.forEach(b => {
      const on = b.getAttribute("data-level") === id;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    mark(current);
    group.append(...buttons);
    return { el: group, mark };
  }

  // ==========================================
  // 1. CODLE: GUESS THE PROGRAMMING WORD
  // ==========================================
  const CODLE_WORDS = [
    ["AGENT", "a model that takes actions with tools"], ["ARRAY", "an ordered list of values"],
    ["ASYNC", "marks a function that returns a promise"], ["AWAIT", "waits for a promise to settle"],
    ["BLOCK", "code between braces, with a scope of its own"], ["BREAK", "leaves a loop or a switch early"],
    ["BUILD", "turns source code into something you can run"], ["BYTES", "units of eight bits"],
    ["CACHE", "a fast store of results you may need again"], ["CATCH", "handles an error thrown in a try block"],
    ["CHMOD", "changes a file's permissions on Unix"], ["CLASS", "a blueprint for objects"],
    ["CLONE", "copies a repository, or an object"], ["CONST", "a name that can't be assigned again"],
    ["CRASH", "a program stopping when it shouldn't"], ["DEBUG", "find out what's wrong, and fix it"],
    ["DEFER", "run something later, once the current work is done"], ["DEPTH", "how far down a tree goes"],
    ["ERROR", "what went wrong, as a value"], ["EVENT", "something that happened, for handlers to answer"],
    ["FALSE", "the other boolean"], ["FETCH", "asks for a resource over the network"],
    ["FLOAT", "a number with a fractional part"], ["FLUSH", "writes buffered data out"],
    ["FRAME", "one entry on the call stack, or one drawn picture"], ["GRAPH", "nodes joined by edges"],
    ["GUARD", "an early check that returns before the main work"], ["INDEX", "a position in a list, or a lookup table in a database"],
    ["INPUT", "data given to a program"], ["LINUX", "the open-source kernel behind most servers"],
    ["LOCAL", "a variable that lives only in its scope"], ["MACRO", "code that writes code"],
    ["MERGE", "joins two branches' histories"], ["MODEL", "the data layer of an app, or a trained network"],
    ["MOUNT", "attaches a component to the page, or a disk to a folder"], ["MUTEX", "a lock that lets one thread in at a time"],
    ["PARSE", "turns text into a structure"], ["PATCH", "a small change, or the HTTP method for one"],
    ["PIXEL", "one dot on the screen"], ["PRINT", "writes to the output"],
    ["PROPS", "values passed into a React component"], ["PROXY", "stands between a client and a server, or wraps an object"],
    ["QUERY", "a question asked of a database"], ["QUEUE", "first in, first out"],
    ["RANGE", "a span of values from a start to an end"], ["REACT", "a library for building interfaces from components"],
    ["REGEX", "a pattern for matching text"], ["RESET", "moves a Git branch back to an earlier commit"],
    ["ROUTE", "maps a URL to the code that answers it"], ["SCOPE", "where a name can be seen"],
    ["SHELL", "the program that runs your commands"], ["SLICE", "a part of an array or a string"],
    ["SPAWN", "starts a new process"], ["SPLIT", "breaks a string into parts"],
    ["STACK", "last in, first out"], ["STASH", "Git's shelf for changes you aren't ready to commit"],
    ["STATE", "data that changes over time"], ["STORE", "where an app keeps its shared state"],
    ["SUPER", "calls the parent class"], ["TABLE", "rows and columns in a database"],
    ["TESTS", "code that checks your code"], ["THROW", "raises an error"],
    ["TOKEN", "a word-sized piece of text, or a credential"], ["TRACE", "a record of what ran, and when"],
    ["TUPLE", "a fixed-size, ordered group of values"], ["VALUE", "what a variable holds"],
    ["WHILE", "loops for as long as a condition holds"], ["YIELD", "hands a value out of a generator"],
  ].filter(([word]) => /^[A-Z]{5}$/.test(word));
  const CODLE_TRIES = 6, CODLE_LEN = 5;
  const CODLE_KEYS = ["QWERTYUIOP", "ASDFGHJKL", "+ZXCVBNM-"];
  const CODLE_RANK = { absent: 1, present: 2, correct: 3 };
  const CODLE_SAID = { correct: "right", present: "elsewhere", absent: "not in the word" };

  // Green for the right letter in the right place, then yellow for letters elsewhere, counted so a letter guessed
  // twice is yellow only as often as the word has it.
  function scoreGuess(guess, answer) {
    const marks = Array(answer.length).fill("absent"), left = {};
    for (let i = 0; i < answer.length; i++) {
      if (guess[i] === answer[i]) marks[i] = "correct";
      else left[answer[i]] = (left[answer[i]] || 0) + 1;
    }
    for (let i = 0; i < answer.length; i++) {
      if (marks[i] !== "correct" && left[guess[i]] > 0) { marks[i] = "present"; left[guess[i]]--; }
    }
    return marks;
  }
  // The best each letter has scored so far, for the keyboard.
  function letterMarks(guesses, marks) {
    const best = {};
    guesses.forEach((guess, row) => [...guess].forEach((letter, i) => {
      const mark = marks[row][i];
      if (!best[letter] || CODLE_RANK[mark] > CODLE_RANK[best[letter]]) best[letter] = mark;
    }));
    return best;
  }

  const codle = { word: null, note: "", guesses: [], marks: [], current: "", done: false, won: false };
  let codleEls = null;

  function pickCodle(random = Math.random) {
    let pick;
    do pick = CODLE_WORDS[Math.floor(random() * CODLE_WORDS.length)]; while (CODLE_WORDS.length > 1 && pick[0] === codle.word);
    Object.assign(codle, { word: pick[0], note: pick[1], guesses: [], marks: [], current: "", done: false, won: false });
  }
  const codleStats = () => store.get("codle-stats", { played: 0, won: 0, streak: 0, best: 0 });

  function codleKey(key) {
    if (codle.done) {
      if (key === "Enter") { pickCodle(); renderCodle("New word. Type a guess and press Enter."); }
      return;
    }
    if (key === "Backspace") { codle.current = codle.current.slice(0, -1); renderCodle(); return; }
    if (key === "Enter") { submitCodle(); return; }
    const letter = key.length === 1 ? key.toUpperCase() : "";
    if (!/^[A-Z]$/.test(letter) || codle.current.length >= CODLE_LEN) return;
    codle.current += letter;
    renderCodle();
  }

  function submitCodle() {
    if (codle.current.length < CODLE_LEN) { renderCodle(`Not enough letters: a guess has ${CODLE_LEN}.`); return; }
    const guess = codle.current, marks = scoreGuess(guess, codle.word);
    codle.guesses.push(guess);
    codle.marks.push(marks);
    codle.current = "";
    const said = [...guess].map((letter, i) => `${letter} ${CODLE_SAID[marks[i]]}`).join(", ");
    if (guess === codle.word || codle.guesses.length >= CODLE_TRIES) {
      codle.done = true;
      codle.won = guess === codle.word;
      const stats = codleStats();
      stats.played++;
      if (codle.won) { stats.won++; stats.streak++; stats.best = Math.max(stats.best, stats.streak); } else stats.streak = 0;
      store.set("codle-stats", stats);
      renderCodle(codle.won
        ? `Solved in ${codle.guesses.length} of ${CODLE_TRIES}. ${codle.word}: ${codle.note}. Press Enter for another.`
        : `The word was ${codle.word}: ${codle.note}. Press Enter for another.`);
      return;
    }
    renderCodle(`${guess}: ${said}. ${plural(CODLE_TRIES - codle.guesses.length, "try", "tries")} left.`);
  }

  function buildCodle() {
    if (!codle.word) pickCodle();
    const card = panel("codle", "flow-lounge-codle");
    const figs = figures([["played", "Played", 0], ["won", "Won", 0], ["streak", "Streak", 0]]);

    const board = node("div", "flow-lounge-puzzle-board flow-lounge-codle-board");
    board.tabIndex = 0;
    board.setAttribute("role", "grid");
    board.setAttribute("aria-label", "Codle board. Type five letters and press Enter to guess; Backspace deletes.");
    const cells = [];
    const rows = range(CODLE_TRIES).map(r => {
      const row = node("div", "flow-lounge-codle-row");
      row.setAttribute("role", "row");
      cells[r] = range(CODLE_LEN).map(() => {
        const cell = node("div", "flow-lounge-codle-cell");
        cell.setAttribute("role", "gridcell");
        row.append(cell);
        return cell;
      });
      board.append(row);
      return row;
    });
    onBoardKeys(board, e => {
      if (e.key === "Enter" || e.key === "Backspace" || /^[a-z]$/i.test(e.key)) { codleKey(e.key); return true; }
      return false;
    });

    const keyboard = node("div", "flow-lounge-codle-keys");
    keyboard.setAttribute("aria-label", "Letters");
    const keys = {};
    for (const line of CODLE_KEYS) {
      const row = node("div", "flow-lounge-codle-keyrow");
      for (const ch of line) {
        const key = ch === "+" ? "Enter" : ch === "-" ? "Backspace" : ch;
        const b = button("flow-lounge-codle-key", key === "Backspace" ? "⌫" : key, () => { codleKey(key); focusQuietly(board); });
        b.tabIndex = -1;
        b.setAttribute("data-key", key);
        if (key === "Backspace") b.setAttribute("aria-label", "Delete letter");
        if (key.length > 1) b.classList.add("wide");
        keys[key] = b;
        row.append(b);
      }
      keyboard.append(row);
    }

    const status = statusLine("");
    const again = button("secondary-button flow-lounge-btn", "New word", () => { pickCodle(); renderCodle("New word. Type a guess and press Enter."); focusQuietly(board); });
    const stage = node("div", "flow-lounge-puzzle-stage");
    stage.append(board);
    card.append(figs.el, stage, keyboard, foot(status, again));
    codleEls = { board, rows, cells, keys, status, figs };
    renderCodle("Type a guess and press Enter. Any five letters count.");
    return card;
  }

  function renderCodle(message) {
    if (!codleEls) return;
    const { rows, cells, keys, status, figs } = codleEls;
    for (let r = 0; r < CODLE_TRIES; r++) {
      const guess = codle.guesses[r] ?? (r === codle.guesses.length ? codle.current : "");
      const marks = codle.marks[r];
      rows[r].classList.toggle("revealed", Boolean(marks));
      rows[r].classList.toggle("current", !codle.done && r === codle.guesses.length);
      for (let i = 0; i < CODLE_LEN; i++) {
        const cell = cells[r][i], letter = guess[i] || "";
        cell.textContent = letter;
        cell.setAttribute("data-state", marks ? marks[i] : letter ? "typed" : "empty");
        cell.setAttribute("aria-label", letter ? `${letter}${marks ? ", " + CODLE_SAID[marks[i]] : ""}` : "empty");
      }
    }
    const best = letterMarks(codle.guesses, codle.marks);
    for (const [key, b] of Object.entries(keys)) {
      if (key.length === 1) b.setAttribute("data-state", best[key] || "unused");
    }
    const stats = codleStats();
    figs.set("played", stats.played);
    figs.set("won", stats.played ? `${Math.round((stats.won / stats.played) * 100)}%` : "0%");
    figs.set("streak", stats.streak);
    if (message !== undefined) status.textContent = message;
  }

  // ==========================================
  // 2. 2048: SLIDE AND MERGE
  // ==========================================
  const SIZE_2048 = 4;

  // Slides one line towards its start, merging equal neighbours once each, as the original game does.
  function slideLine(line) {
    const tiles = line.filter(Boolean), out = [], merged = [];
    let gained = 0;
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] === tiles[i + 1]) {
        out.push(tiles[i] * 2);
        gained += tiles[i] * 2;
        merged.push(out.length - 1);
        i++;
      } else out.push(tiles[i]);
    }
    while (out.length < line.length) out.push(0);
    return { line: out, gained, merged, moved: out.some((v, i) => v !== line[i]) };
  }
  function move2048(grid, dir, size = SIZE_2048) {
    const next = grid.slice(), merged = [];
    let gained = 0, moved = false;
    for (let k = 0; k < size; k++) {
      // Each line is read from the edge the tiles move towards.
      const cells = range(size).map(j => {
        const [r, c] = dir === "left" ? [k, j] : dir === "right" ? [k, size - 1 - j] : dir === "up" ? [j, k] : [size - 1 - j, k];
        return r * size + c;
      });
      const result = slideLine(cells.map(i => grid[i]));
      cells.forEach((i, j) => { next[i] = result.line[j]; });
      gained += result.gained;
      moved = moved || result.moved;
      result.merged.forEach(j => merged.push(cells[j]));
    }
    return { grid: next, gained, moved, merged };
  }
  function canMove2048(grid, size = SIZE_2048) {
    if (grid.includes(0)) return true;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      const v = grid[r * size + c];
      if (c + 1 < size && grid[r * size + c + 1] === v) return true;
      if (r + 1 < size && grid[(r + 1) * size + c] === v) return true;
    }
    return false;
  }
  // A new 2 (or, one time in ten, a 4) in a random empty square. Returns where it went, or -1.
  function addTile2048(grid, random = Math.random) {
    const empty = grid.map((v, i) => v ? -1 : i).filter(i => i >= 0);
    if (!empty.length) return -1;
    const at = empty[Math.floor(random() * empty.length)];
    grid[at] = random() < 0.9 ? 2 : 4;
    return at;
  }

  const g2048 = { grid: null, score: 0, won: false, over: false, fresh: [], merged: [] };
  let els2048 = null;

  function new2048() {
    const grid = Array(SIZE_2048 * SIZE_2048).fill(0);
    const a = addTile2048(grid), b = addTile2048(grid);
    Object.assign(g2048, { grid, score: 0, won: false, over: false, fresh: [a, b], merged: [] });
  }
  function play2048(dir) {
    if (g2048.over) return;
    const result = move2048(g2048.grid, dir);
    if (!result.moved) return;
    g2048.grid = result.grid;
    g2048.score += result.gained;
    g2048.merged = result.merged;
    g2048.fresh = [addTile2048(g2048.grid)];
    if (g2048.score > (Number(store.get("2048-best", 0)) || 0)) store.set("2048-best", g2048.score);
    let message;
    if (!g2048.won && g2048.grid.includes(2048)) { g2048.won = true; message = "You made 2048! Keep going for a higher score."; }
    if (!canMove2048(g2048.grid)) { g2048.over = true; message = `No moves left. You scored ${g2048.score}.`; }
    render2048(message);
  }

  function build2048() {
    if (!g2048.grid) new2048();
    const card = panel("2048", "flow-lounge-2048");
    const figs = figures([["score", "Score", 0], ["best", "Best", 0]]);
    const wrap = node("div", "flow-lounge-puzzle-stage");
    const board = node("div", "flow-lounge-puzzle-board flow-lounge-2048-board");
    board.tabIndex = 0;
    board.setAttribute("role", "grid");
    board.setAttribute("aria-label", "2048 board. Arrow keys or W, A, S and D slide the tiles.");
    onBoardKeys(board, e => {
      const dir = ARROWS[e.key] || WASD[e.key];
      if (!dir) return false;
      play2048(dir);
      return true;
    });
    // A swipe or a drag on the board slides the tiles too.
    let start = null;
    board.addEventListener("pointerdown", e => { start = { x: e.clientX, y: e.clientY }; });
    board.addEventListener("pointerup", e => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      start = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
      play2048(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
    });
    wrap.append(board);
    const status = statusLine("");
    const again = button("secondary-button flow-lounge-btn", "New game", () => { new2048(); render2048("New game. Slide the tiles with the arrow keys."); focusQuietly(board); });
    card.append(figs.el, wrap, foot(status, again));
    els2048 = { board, status, figs };
    render2048("Slide the tiles with the arrow keys. Equal numbers merge.");
    return card;
  }

  function render2048(message) {
    if (!els2048) return;
    const { board, status, figs } = els2048;
    // The cells are made again on every move, so a new or merged tile plays its short entrance once.
    const rows = range(SIZE_2048).map(r => {
      const row = node("div", "flow-lounge-2048-row");
      row.setAttribute("role", "row");
      for (let c = 0; c < SIZE_2048; c++) {
        const i = r * SIZE_2048 + c, v = g2048.grid[i];
        const cell = node("div", "flow-lounge-2048-cell", v ? String(v) : "");
        cell.setAttribute("role", "gridcell");
        cell.setAttribute("data-value", v > 2048 ? "big" : String(v));
        if (!v) cell.setAttribute("aria-label", "empty");
        if (v && g2048.fresh.includes(i)) cell.classList.add("fresh");
        if (v && g2048.merged.includes(i)) cell.classList.add("merged");
        row.append(cell);
      }
      return row;
    });
    board.replaceChildren(...rows);
    figs.set("score", g2048.score);
    figs.set("best", Math.max(g2048.score, Number(store.get("2048-best", 0)) || 0));
    if (message !== undefined) status.textContent = message;
  }

  // ==========================================
  // 3. MINESWEEPER
  // ==========================================
  const MINE_LEVELS = [
    { id: "easy", label: "Easy", rows: 9, cols: 9, mines: 10, note: "9 × 9, 10 mines" },
    { id: "medium", label: "Medium", rows: 16, cols: 16, mines: 40, note: "16 × 16, 40 mines" },
    { id: "hard", label: "Hard", rows: 16, cols: 30, mines: 99, note: "16 × 30, 99 mines" },
  ];
  function neighbours(i, rows, cols) {
    const r = Math.floor(i / cols), c = i % cols, out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) out.push(nr * cols + nc);
    }
    return out;
  }
  // Mines are laid after the first click, away from it and its neighbours, so the first click always opens ground.
  function layMines(rows, cols, count, safe, random = Math.random) {
    const keepClear = new Set([safe, ...neighbours(safe, rows, cols)]);
    let spots = range(rows * cols).filter(i => !keepClear.has(i));
    if (spots.length < count) spots = range(rows * cols).filter(i => i !== safe);
    const mines = Array(rows * cols).fill(false);
    for (const i of shuffle(spots, random).slice(0, count)) mines[i] = true;
    return mines;
  }
  function mineCounts(mines, rows, cols) {
    return mines.map((_, i) => neighbours(i, rows, cols).filter(n => mines[n]).length);
  }
  // Opens a square, and from any square with no mines around it, everything next to it. Returns the squares opened.
  function openFrom(state, start) {
    const opened = [], stack = [start];
    while (stack.length) {
      const i = stack.pop();
      if (state.open[i] || state.flag[i]) continue;
      state.open[i] = true;
      opened.push(i);
      if (!state.mines[i] && state.counts[i] === 0) stack.push(...neighbours(i, state.rows, state.cols));
    }
    return opened;
  }

  let mineLevel = store.get("mines-level", "easy");
  if (!MINE_LEVELS.some(l => l.id === mineLevel)) mineLevel = "easy";
  const mines = { state: null, cursor: 0 };
  let mineEls = null;
  const mineClock = makeClock(() => mineEls?.figs.set("time", clockText(mineClock.ms())));

  function newMines() {
    const level = MINE_LEVELS.find(l => l.id === mineLevel);
    const size = level.rows * level.cols;
    mines.state = {
      level: level.id, rows: level.rows, cols: level.cols, count: level.mines,
      mines: null, counts: null, open: Array(size).fill(false), flag: Array(size).fill(false),
      over: false, won: false, boom: -1,
    };
    mines.cursor = Math.floor(level.rows / 2) * level.cols + Math.floor(level.cols / 2);
    mineClock.reset();
  }
  const minesLeft = s => s.count - s.flag.filter(Boolean).length;

  function revealMine(i) {
    const s = mines.state;
    if (s.over || s.flag[i]) return;
    if (!s.mines) {
      s.mines = layMines(s.rows, s.cols, s.count, i);
      s.counts = mineCounts(s.mines, s.rows, s.cols);
    }
    mineClock.run();
    // A number whose mines are all flagged opens the rest of its neighbours ("chording").
    let targets = [i];
    if (s.open[i]) {
      const around = neighbours(i, s.rows, s.cols);
      if (!s.counts[i] || around.filter(n => s.flag[n]).length !== s.counts[i]) return;
      targets = around.filter(n => !s.open[n] && !s.flag[n]);
    }
    for (const t of targets) {
      if (s.mines[t]) { s.over = true; s.boom = t; break; }
      openFrom(s, t);
    }
    if (s.over) {
      mineClock.stop();
      renderMines("Boom. That was a mine. Press New game to try again.");
      return;
    }
    if (s.open.filter(Boolean).length === s.rows * s.cols - s.count) {
      s.over = s.won = true;
      s.mines.forEach((m, n) => { if (m) s.flag[n] = true; });
      mineClock.stop();
      const seconds = Math.max(1, Math.round(mineClock.ms() / 1000));
      const key = "mines-best-" + s.level, best = Number(store.get(key, 0)) || 0;
      if (!best || seconds < best) store.set(key, seconds);
      renderMines(`Cleared in ${clockText(seconds * 1000)}${!best || seconds < best ? ", your best on this level" : ""}.`);
      return;
    }
    renderMines(targets.length === 1 && s.counts[targets[0]] ? `${s.counts[targets[0]]} around this square.` : undefined);
  }
  function flagMine(i) {
    const s = mines.state;
    if (s.over || s.open[i]) return;
    s.flag[i] = !s.flag[i];
    if (s.mines) mineClock.run();
    renderMines(`${s.flag[i] ? "Flagged" : "Unflagged"}. ${plural(minesLeft(s), "mine", "mines")} left.`);
  }

  function buildMines() {
    if (!mines.state) newMines();
    const card = panel("mines", "flow-lounge-mines");
    const figs = figures([["left", "Mines", 0], ["time", "Time", "0:00"], ["best", "Best", "–"]]);
    const levels = choices("Level", MINE_LEVELS, mineLevel, id => {
      mineLevel = id;
      store.set("mines-level", id);
      levels.mark(id);
      newMines();
      layoutMines();
      renderMines("New field. Click a square to start.");
      focusQuietly(mineEls.board);
    });
    const head = node("div", "flow-lounge-puzzle-head");
    head.append(figs.el, levels.el);

    const wrap = node("div", "flow-lounge-puzzle-stage");
    const board = node("div", "flow-lounge-puzzle-board flow-lounge-mines-board");
    board.tabIndex = 0;
    board.setAttribute("role", "grid");
    board.setAttribute("aria-label", "Minefield. Arrow keys move, Space or Enter opens a square, F flags it.");
    const cellAt = target => { const el = target?.closest?.("[data-cell]"); return el ? Number(el.getAttribute("data-cell")) : -1; };
    board.addEventListener("click", e => {
      const i = cellAt(e.target);
      if (i < 0) return;
      mines.cursor = i;
      if (e.shiftKey) flagMine(i); else revealMine(i);
    });
    board.addEventListener("contextmenu", e => {
      const i = cellAt(e.target);
      if (i < 0) return;
      e.preventDefault();
      mines.cursor = i;
      flagMine(i);
    });
    onBoardKeys(board, e => {
      const s = mines.state, dir = ARROWS[e.key];
      if (dir) {
        const r = Math.floor(mines.cursor / s.cols), c = mines.cursor % s.cols, [dr, dc] = STEP[dir];
        mines.cursor = Math.min(s.rows - 1, Math.max(0, r + dr)) * s.cols + Math.min(s.cols - 1, Math.max(0, c + dc));
        renderMines();
        return true;
      }
      if (e.key === " " || e.key === "Enter") { revealMine(mines.cursor); return true; }
      if (e.key === "f" || e.key === "F") { flagMine(mines.cursor); return true; }
      return false;
    });
    wrap.append(board);

    const status = statusLine("");
    const again = button("secondary-button flow-lounge-btn", "New game", () => { newMines(); renderMines("New field. Click a square to start."); focusQuietly(board); });
    card.append(head, wrap, foot(status, again));
    mineEls = { board, status, figs, cells: [] };
    layoutMines();
    renderMines("Click a square to start. Right-click or Shift-click flags a mine.");
    return card;
  }

  function layoutMines() {
    const s = mines.state, { board } = mineEls;
    board.setAttribute("data-level", s.level);
    // The stylesheet sizes the squares from these, to fit the field in the room the stage has.
    try { board.style.setProperty("--rows", String(s.rows)); board.style.setProperty("--cols", String(s.cols)); } catch {}
    mineEls.cells = [];
    const rows = range(s.rows).map(r => {
      const row = node("div", "flow-lounge-mines-row");
      row.setAttribute("role", "row");
      for (let c = 0; c < s.cols; c++) {
        const i = r * s.cols + c, cell = node("div", "flow-lounge-mines-cell");
        cell.id = "flow-lounge-mines-" + i;
        cell.setAttribute("role", "gridcell");
        cell.setAttribute("data-cell", String(i));
        mineEls.cells.push(cell);
        row.append(cell);
      }
      return row;
    });
    board.replaceChildren(...rows);
  }

  function renderMines(message) {
    if (!mineEls) return;
    const s = mines.state, { board, cells, status, figs } = mineEls;
    if (cells.length !== s.rows * s.cols) layoutMines();
    mineEls.cells.forEach((cell, i) => {
      let state = "hidden", text = "", said = "unopened";
      if (s.open[i]) {
        state = "open";
        const n = s.counts[i];
        text = n ? String(n) : "";
        said = n ? String(n) : "clear";
      } else if (s.over && s.mines?.[i] && !s.flag[i]) { state = i === s.boom ? "boom" : "mine"; said = "mine"; }
      else if (s.flag[i]) { state = s.over && s.mines && !s.mines[i] ? "wrong" : "flag"; said = state === "wrong" ? "flagged, no mine" : "flagged"; }
      cell.textContent = text;
      cell.setAttribute("data-state", state);
      cell.setAttribute("data-n", text);
      cell.setAttribute("aria-label", said);
      cell.classList.toggle("cursor", i === mines.cursor);
    });
    board.setAttribute("aria-activedescendant", "flow-lounge-mines-" + mines.cursor);
    board.setAttribute("data-over", s.over ? (s.won ? "won" : "lost") : "");
    figs.set("left", minesLeft(s));
    figs.set("time", clockText(mineClock.ms()));
    const best = Number(store.get("mines-best-" + s.level, 0)) || 0;
    figs.set("best", best ? clockText(best * 1000) : "–");
    if (message !== undefined) status.textContent = message;
  }

  // ==========================================
  // 4. SUDOKU
  // ==========================================
  const SUDOKU_LEVELS = [
    { id: "easy", label: "Easy", givens: 40 },
    { id: "medium", label: "Medium", givens: 32 },
    { id: "hard", label: "Hard", givens: 26 },
  ];
  const ALL_DIGITS = 0x3fe; // bits 1 to 9
  const boxOf = i => Math.floor(Math.floor(i / 9) / 3) * 3 + Math.floor((i % 9) / 3);
  const bitCount = mask => { let n = 0; while (mask) { mask &= mask - 1; n++; } return n; };

  // Counts a grid's solutions, up to `limit`, filling the square with the fewest choices first. With `random`
  // it tries digits in a random order, which is how a new full grid is made. Returns the count and the first one.
  function solveSudoku(grid, limit = 2, random = null) {
    const g = grid.slice(), rows = Array(9).fill(0), cols = Array(9).fill(0), boxes = Array(9).fill(0);
    for (let i = 0; i < 81; i++) {
      if (!g[i]) continue;
      const bit = 1 << g[i], r = Math.floor(i / 9), c = i % 9, b = boxOf(i);
      if ((rows[r] | cols[c] | boxes[b]) & bit) return { count: 0, solution: null };
      rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
    }
    let count = 0, solution = null;
    const search = () => {
      let at = -1, atMask = 0, fewest = 10;
      for (let i = 0; i < 81; i++) {
        if (g[i]) continue;
        const mask = ALL_DIGITS & ~(rows[Math.floor(i / 9)] | cols[i % 9] | boxes[boxOf(i)]);
        const n = bitCount(mask);
        if (!n) return;
        if (n < fewest) { at = i; atMask = mask; fewest = n; if (n === 1) break; }
      }
      if (at < 0) { count++; if (!solution) solution = g.slice(); return; }
      const r = Math.floor(at / 9), c = at % 9, b = boxOf(at);
      let digits = range(9).map(d => d + 1).filter(d => atMask & (1 << d));
      if (random) digits = shuffle(digits, random);
      for (const d of digits) {
        const bit = 1 << d;
        g[at] = d; rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
        search();
        g[at] = 0; rows[r] &= ~bit; cols[c] &= ~bit; boxes[b] &= ~bit;
        if (count >= limit) return;
      }
    };
    search();
    return { count, solution };
  }
  // A full grid, then squares taken away in a random order for as long as the puzzle keeps a single solution.
  function makeSudoku(givens = 32, random = Math.random) {
    const solution = solveSudoku(Array(81).fill(0), 1, random).solution;
    const puzzle = solution.slice();
    let left = 81;
    for (const i of shuffle(range(81), random)) {
      if (left <= givens) break;
      const keep = puzzle[i];
      puzzle[i] = 0;
      if (solveSudoku(puzzle, 2).count !== 1) puzzle[i] = keep;
      else left--;
    }
    return { puzzle, solution };
  }

  let sudokuLevel = store.get("sudoku-level", "easy");
  if (!SUDOKU_LEVELS.some(l => l.id === sudokuLevel)) sudokuLevel = "easy";
  const sudoku = { puzzle: null, solution: null, values: null, notes: null, selected: 40, noting: false, mistakes: 0, done: false, level: sudokuLevel };
  let sudokuEls = null;
  const sudokuClock = makeClock(() => sudokuEls?.figs.set("time", clockText(sudokuClock.ms())));

  function newSudoku() {
    const level = SUDOKU_LEVELS.find(l => l.id === sudokuLevel);
    const { puzzle, solution } = makeSudoku(level.givens);
    Object.assign(sudoku, { puzzle, solution, values: puzzle.slice(), notes: Array(81).fill(0), selected: 40, mistakes: 0, done: false, level: level.id });
    sudokuClock.reset();
  }
  const peersOf = i => {
    const r = Math.floor(i / 9), c = i % 9, b = boxOf(i);
    return range(81).filter(j => j !== i && (Math.floor(j / 9) === r || j % 9 === c || boxOf(j) === b));
  };

  function enterSudoku(digit) {
    const s = sudoku, i = s.selected;
    if (s.done || s.puzzle[i]) return;
    sudokuClock.run();
    if (!digit) { s.values[i] = 0; s.notes[i] = 0; renderSudoku("Cleared."); return; }
    if (s.noting) {
      if (s.values[i]) return;
      s.notes[i] ^= 1 << digit;
      renderSudoku();
      return;
    }
    if (s.values[i] === digit) return;
    s.values[i] = digit;
    s.notes[i] = 0;
    if (digit !== s.solution[i]) {
      s.mistakes++;
      renderSudoku(`${digit} doesn't go there. ${plural(s.mistakes, "mistake", "mistakes")} so far.`);
      return;
    }
    // A right digit rubs out the same pencil mark from its row, column and box.
    for (const j of peersOf(i)) s.notes[j] &= ~(1 << digit);
    if (s.values.every((v, j) => v === s.solution[j])) {
      s.done = true;
      sudokuClock.stop();
      const seconds = Math.max(1, Math.round(sudokuClock.ms() / 1000));
      const key = "sudoku-best-" + s.level, best = Number(store.get(key, 0)) || 0;
      if (!best || seconds < best) store.set(key, seconds);
      store.set("sudoku-solved", (Number(store.get("sudoku-solved", 0)) || 0) + 1);
      renderSudoku(`Solved in ${clockText(seconds * 1000)} with ${plural(s.mistakes, "mistake", "mistakes")}.`);
      return;
    }
    renderSudoku();
  }

  function buildSudoku() {
    const card = panel("sudoku", "flow-lounge-sudoku");
    const figs = figures([["mistakes", "Mistakes", 0], ["time", "Time", "0:00"], ["best", "Best", "–"]]);
    const levels = choices("Level", SUDOKU_LEVELS, sudokuLevel, id => {
      sudokuLevel = id;
      store.set("sudoku-level", id);
      levels.mark(id);
      newSudoku();
      renderSudoku("New puzzle.");
      focusQuietly(sudokuEls.board);
    });
    const head = node("div", "flow-lounge-puzzle-head");
    head.append(figs.el, levels.el);

    const wrap = node("div", "flow-lounge-puzzle-stage flow-lounge-sudoku-stage");
    const board = node("div", "flow-lounge-puzzle-board flow-lounge-sudoku-board");
    board.tabIndex = 0;
    board.setAttribute("role", "grid");
    board.setAttribute("aria-label", "Sudoku. Arrow keys move, 1 to 9 fill a square, Backspace clears it, N switches pencil notes.");
    const cells = [];
    for (let r = 0; r < 9; r++) {
      const row = node("div", "flow-lounge-sudoku-row");
      row.setAttribute("role", "row");
      for (let c = 0; c < 9; c++) {
        const i = r * 9 + c, cell = node("div", "flow-lounge-sudoku-cell");
        cell.id = "flow-lounge-sudoku-" + i;
        cell.setAttribute("role", "gridcell");
        cell.setAttribute("data-cell", String(i));
        cell.setAttribute("data-r", String(r));
        cell.setAttribute("data-c", String(c));
        cells.push(cell);
        row.append(cell);
      }
      board.append(row);
    }
    board.addEventListener("click", e => {
      const el = e.target?.closest?.("[data-cell]");
      if (!el) return;
      sudoku.selected = Number(el.getAttribute("data-cell"));
      if (!sudoku.done) sudokuClock.run();
      renderSudoku();
    });
    onBoardKeys(board, e => {
      const dir = ARROWS[e.key];
      if (dir) {
        const r = Math.floor(sudoku.selected / 9), c = sudoku.selected % 9, [dr, dc] = STEP[dir];
        sudoku.selected = ((r + dr + 9) % 9) * 9 + ((c + dc + 9) % 9);
        renderSudoku();
        return true;
      }
      if (/^[1-9]$/.test(e.key)) { enterSudoku(Number(e.key)); return true; }
      if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") { enterSudoku(0); return true; }
      if (e.key === "n" || e.key === "N") { toggleNotes(); return true; }
      return false;
    });

    // Digits to click, each greyed out once all nine are in place, then Erase and pencil Notes.
    const pad = node("div", "flow-lounge-sudoku-pad");
    pad.setAttribute("aria-label", "Digits");
    const digits = range(9).map(d => {
      const b = button("flow-lounge-sudoku-digit", String(d + 1), () => { enterSudoku(d + 1); focusQuietly(board); });
      b.tabIndex = -1;
      return b;
    });
    const erase = button("flow-lounge-sudoku-tool", "Erase", () => { enterSudoku(0); focusQuietly(board); });
    const notes = button("flow-lounge-sudoku-tool", "Notes", () => { toggleNotes(); focusQuietly(board); });
    erase.tabIndex = notes.tabIndex = -1;
    notes.title = "Pencil notes (N)";
    pad.append(...digits, erase, notes);
    wrap.append(board, pad);

    const status = statusLine("");
    const again = button("secondary-button flow-lounge-btn", "New puzzle", () => { newSudoku(); renderSudoku("New puzzle."); focusQuietly(board); });
    card.append(head, wrap, foot(status, again));
    sudokuEls = { board, cells, digits, notes, status, figs };
    // The first puzzle is made when Sudoku is first opened, not every time the Lounge is.
    if (sudoku.puzzle) renderSudoku("Pick a square, then type a digit.");
    return card;
  }
  function toggleNotes() {
    sudoku.noting = !sudoku.noting;
    renderSudoku(sudoku.noting ? "Notes on: digits are pencilled in." : "Notes off.");
  }
  function openSudoku() {
    if (!sudoku.puzzle) { newSudoku(); renderSudoku("Pick a square, then type a digit."); }
    if (!sudoku.done) sudokuClock.run();
    return sudokuEls?.board;
  }

  function renderSudoku(message) {
    if (!sudokuEls || !sudoku.puzzle) return;
    const s = sudoku, { board, cells, digits, notes, status, figs } = sudokuEls;
    const sel = s.selected, selRow = Math.floor(sel / 9), selCol = sel % 9, selBox = boxOf(sel), selValue = s.values[sel];
    cells.forEach((cell, i) => {
      const v = s.values[i];
      cell.setAttribute("data-given", s.puzzle[i] ? "true" : "false");
      cell.setAttribute("data-error", v && v !== s.solution[i] ? "true" : "false");
      cell.classList.toggle("selected", i === sel);
      cell.classList.toggle("peer", i !== sel && (Math.floor(i / 9) === selRow || i % 9 === selCol || boxOf(i) === selBox));
      cell.classList.toggle("same", Boolean(v) && v === selValue && i !== sel);
      if (v) {
        cell.textContent = String(v);
        cell.setAttribute("aria-label", `${v}${s.puzzle[i] ? ", given" : v !== s.solution[i] ? ", wrong" : ""}`);
      } else if (s.notes[i]) {
        const marks = node("span", "flow-lounge-sudoku-notes");
        for (let d = 1; d <= 9; d++) marks.append(node("span", undefined, s.notes[i] & (1 << d) ? String(d) : ""));
        cell.replaceChildren(marks);
        cell.setAttribute("aria-label", "notes " + range(9).map(d => d + 1).filter(d => s.notes[i] & (1 << d)).join(" "));
      } else {
        cell.textContent = "";
        cell.setAttribute("aria-label", "empty");
      }
    });
    board.setAttribute("aria-activedescendant", "flow-lounge-sudoku-" + sel);
    board.setAttribute("data-done", String(s.done));
    digits.forEach((b, d) => {
      const placed = s.values.filter((v, i) => v === d + 1 && v === s.solution[i]).length;
      b.disabled = placed >= 9 || s.done;
    });
    notes.classList.toggle("active", s.noting);
    notes.setAttribute("aria-pressed", String(s.noting));
    figs.set("mistakes", s.mistakes);
    figs.set("time", clockText(sudokuClock.ms()));
    const best = Number(store.get("sudoku-best-" + s.level, 0)) || 0;
    figs.set("best", best ? clockText(best * 1000) : "–");
    if (message !== undefined) status.textContent = message;
  }

  // ==========================================
  // 5. PAIRS: A MEMORY GAME WITH CODE SYMBOLS
  // ==========================================
  const PAIR_SYMBOLS = ["{ }", "=>", "&&", "//", "[ ]", "</>", "#!", "++", "!=", "::", "$_", "??", "||", "0x", "λ", "%"];
  const PAIR_COUNT = 8;
  function dealPairs(random = Math.random) {
    const symbols = shuffle(PAIR_SYMBOLS, random).slice(0, PAIR_COUNT);
    return shuffle([...symbols, ...symbols], random).map(symbol => ({ symbol, up: false, matched: false }));
  }

  const pairs = { cards: null, first: -1, second: -1, moves: 0, done: false, timer: null };
  let pairEls = null;

  function newPairs() {
    if (pairs.timer) clearTimeout(pairs.timer);
    Object.assign(pairs, { cards: dealPairs(), first: -1, second: -1, moves: 0, done: false, timer: null });
  }
  // Two cards that don't match stay up for a moment; turning a third card puts them back straight away.
  function settlePairs() {
    if (pairs.timer) { clearTimeout(pairs.timer); pairs.timer = null; }
    if (pairs.second < 0) return;
    pairs.cards[pairs.first].up = pairs.cards[pairs.second].up = false;
    pairs.first = pairs.second = -1;
  }
  function turnPair(i) {
    const card = pairs.cards[i];
    if (pairs.done || card.matched || card.up) return;
    settlePairs();
    card.up = true;
    if (pairs.first < 0) { pairs.first = i; renderPairs(); return; }
    pairs.second = i;
    pairs.moves++;
    const a = pairs.cards[pairs.first];
    if (a.symbol === card.symbol) {
      a.matched = card.matched = true;
      pairs.first = pairs.second = -1;
      if (pairs.cards.every(c => c.matched)) {
        pairs.done = true;
        const best = Number(store.get("pairs-best", 0)) || 0;
        if (!best || pairs.moves < best) store.set("pairs-best", pairs.moves);
        renderPairs(`All ${PAIR_COUNT} pairs in ${plural(pairs.moves, "move", "moves")}${!best || pairs.moves < best ? ", your best yet" : ""}.`);
        return;
      }
      renderPairs(`A pair: ${card.symbol}.`);
      return;
    }
    renderPairs(`${a.symbol} and ${card.symbol} don't match.`);
    pairs.timer = setTimeout(() => { settlePairs(); renderPairs(); }, 900);
  }

  function buildPairs() {
    if (!pairs.cards) newPairs();
    const card = panel("pairs", "flow-lounge-pairs");
    const figs = figures([["moves", "Moves", 0], ["found", "Pairs", 0], ["best", "Best", "–"]]);
    const wrap = node("div", "flow-lounge-puzzle-stage");
    const board = node("div", "flow-lounge-puzzle-board flow-lounge-pairs-board");
    board.setAttribute("role", "group");
    board.setAttribute("aria-label", "Cards. Arrow keys move between cards; Space or Enter turns one over.");
    const faces = [];
    const buttons = pairs.cards.map((_, i) => {
      const b = button("flow-lounge-pairs-card", "", () => turnPair(i));
      const inner = node("span", "flow-lounge-pairs-inner");
      faces[i] = node("span", "flow-lounge-pairs-face");
      inner.append(node("span", "flow-lounge-pairs-back"), faces[i]);
      b.append(inner);
      return b;
    });
    board.append(...buttons);
    onBoardKeys(board, e => {
      const dir = ARROWS[e.key];
      if (!dir) return false;
      const at = buttons.indexOf(document.activeElement);
      const from = at < 0 ? 0 : at, [dr, dc] = STEP[dir], cols = 4;
      const r = Math.floor(from / cols) + dr, c = (from % cols) + dc;
      if (r >= 0 && r < buttons.length / cols && c >= 0 && c < cols) focusQuietly(buttons[r * cols + c]);
      return true;
    });
    wrap.append(board);
    const status = statusLine("");
    const again = button("secondary-button flow-lounge-btn", "New game", () => { newPairs(); renderPairs("New cards. Turn two over."); focusQuietly(pairEls.buttons[0]); });
    card.append(figs.el, wrap, foot(status, again));
    pairEls = { board, buttons, faces, status, figs };
    renderPairs("Turn two cards over to find a pair.");
    return card;
  }

  function renderPairs(message) {
    if (!pairEls) return;
    const { buttons, faces, status, figs } = pairEls;
    pairs.cards.forEach((c, i) => {
      const b = buttons[i];
      if (!b) return;
      b.setAttribute("data-state", c.matched ? "matched" : c.up ? "up" : "down");
      // The symbol is written only while the card is up, so it can't be read from a face-down card.
      faces[i].textContent = c.up || c.matched ? c.symbol : "";
      b.setAttribute("aria-label", `Card ${i + 1}, ${c.matched ? c.symbol + ", matched" : c.up ? c.symbol : "face down"}`);
    });
    figs.set("moves", pairs.moves);
    figs.set("found", `${pairs.cards.filter(c => c.matched).length / 2} of ${PAIR_COUNT}`);
    const best = Number(store.get("pairs-best", 0)) || 0;
    figs.set("best", best ? plural(best, "move", "moves") : "–");
    if (message !== undefined) status.textContent = message;
  }

  // ==========================================
  // 6. FIFTEEN: THE SLIDING PUZZLE
  // ==========================================
  const FIFTEEN = 4;
  const solvedFifteen = () => [...range(FIFTEEN * FIFTEEN - 1).map(n => n + 1), 0];
  const isSolvedFifteen = tiles => tiles.every((v, i) => v === (i === tiles.length - 1 ? 0 : i + 1));
  // Slides the tile at `i`, and any between it and the gap, into the gap. Returns the new tiles, or null.
  function slideFifteen(tiles, i, size = FIFTEEN) {
    const gap = tiles.indexOf(0);
    if (i === gap || i < 0 || i >= tiles.length) return null;
    const [gr, gc, r, c] = [Math.floor(gap / size), gap % size, Math.floor(i / size), i % size];
    if (gr !== r && gc !== c) return null;
    const next = tiles.slice(), step = gr === r ? (c < gc ? -1 : 1) : (r < gr ? -size : size);
    for (let at = gap; at !== i; at += step) next[at] = next[at + step];
    next[i] = 0;
    return next;
  }
  // Shuffled by random slides from the solved board, so every deal can be solved.
  function shuffleFifteen(random = Math.random, slides = 240) {
    let tiles = solvedFifteen(), last = -1;
    do {
      for (let n = 0; n < slides; n++) {
        const gap = tiles.indexOf(0);
        const options = neighbours(gap, FIFTEEN, FIFTEEN).filter(i => (Math.floor(i / FIFTEEN) === Math.floor(gap / FIFTEEN) || i % FIFTEEN === gap % FIFTEEN) && i !== last);
        const pick = options[Math.floor(random() * options.length)];
        tiles = slideFifteen(tiles, pick);
        last = gap;
      }
    } while (isSolvedFifteen(tiles));
    return tiles;
  }

  const fifteen = { tiles: null, moves: 0, done: false };
  let fifteenEls = null;

  function newFifteen() { Object.assign(fifteen, { tiles: shuffleFifteen(), moves: 0, done: false }); }
  function playFifteen(i) {
    if (fifteen.done) return;
    const next = slideFifteen(fifteen.tiles, i);
    if (!next) return;
    fifteen.tiles = next;
    fifteen.moves++;
    if (isSolvedFifteen(next)) {
      fifteen.done = true;
      const best = Number(store.get("fifteen-best", 0)) || 0;
      if (!best || fifteen.moves < best) store.set("fifteen-best", fifteen.moves);
      renderFifteen(`In order in ${plural(fifteen.moves, "move", "moves")}${!best || fifteen.moves < best ? ", your best yet" : ""}.`);
      return;
    }
    renderFifteen();
  }

  function buildFifteen() {
    if (!fifteen.tiles) newFifteen();
    const card = panel("fifteen", "flow-lounge-fifteen");
    const figs = figures([["moves", "Moves", 0], ["best", "Best", "–"]]);
    const wrap = node("div", "flow-lounge-puzzle-stage");
    const board = node("div", "flow-lounge-puzzle-board flow-lounge-fifteen-board");
    board.tabIndex = 0;
    board.setAttribute("role", "grid");
    board.setAttribute("aria-label", "Fifteen. Click a tile in line with the gap, or use the arrow keys to slide a tile into it.");
    board.addEventListener("click", e => {
      const el = e.target?.closest?.("[data-cell]");
      if (el) playFifteen(Number(el.getAttribute("data-cell")));
    });
    onBoardKeys(board, e => {
      const dir = ARROWS[e.key] || WASD[e.key];
      if (!dir) return false;
      // An arrow moves a tile that way: the tile on the other side of the gap.
      const gap = fifteen.tiles.indexOf(0), [dr, dc] = STEP[dir];
      const r = Math.floor(gap / FIFTEEN) - dr, c = (gap % FIFTEEN) - dc;
      if (r >= 0 && r < FIFTEEN && c >= 0 && c < FIFTEEN) playFifteen(r * FIFTEEN + c);
      return true;
    });
    wrap.append(board);
    const status = statusLine("");
    const again = button("secondary-button flow-lounge-btn", "Shuffle", () => { newFifteen(); renderFifteen("Shuffled. Put 1 to 15 back in order."); focusQuietly(board); });
    card.append(figs.el, wrap, foot(status, again));
    fifteenEls = { board, status, figs };
    renderFifteen("Put the tiles back in order, 1 to 15, with the gap last.");
    return card;
  }

  function renderFifteen(message) {
    if (!fifteenEls) return;
    const { board, status, figs } = fifteenEls;
    const rows = range(FIFTEEN).map(r => {
      const row = node("div", "flow-lounge-fifteen-row");
      row.setAttribute("role", "row");
      for (let c = 0; c < FIFTEEN; c++) {
        const i = r * FIFTEEN + c, v = fifteen.tiles[i];
        const cell = node("div", "flow-lounge-fifteen-cell", v ? String(v) : "");
        cell.setAttribute("role", "gridcell");
        cell.setAttribute("data-cell", String(i));
        cell.setAttribute("data-blank", String(!v));
        cell.setAttribute("data-home", String(Boolean(v) && v === i + 1));
        if (!v) cell.setAttribute("aria-label", "gap");
        row.append(cell);
      }
      return row;
    });
    board.replaceChildren(...rows);
    board.setAttribute("data-done", String(fifteen.done));
    figs.set("moves", fifteen.moves);
    const best = Number(store.get("fifteen-best", 0)) || 0;
    figs.set("best", best || "–");
    if (message !== undefined) status.textContent = message;
  }

  // ==========================================
  // 7. THE ACTIVITIES THE LOUNGE ADDS TO ITS GRID
  // ==========================================
  const bestTime = key => { const s = Number(store.get(key, 0)) || 0; return s ? `Best ${clockText(s * 1000)}` : ""; };
  const activities = [
    { id: "codle", title: "Codle", kind: "Word game", keys: "Keyboard", icon: "codle",
      description: "Guess the five-letter programming word in six tries. Green is the right letter in the right place, yellow is in the word somewhere else.",
      build: buildCodle, focus: () => codleEls?.board,
      stat: () => { const s = codleStats(); return s.played ? `Won ${s.won} of ${s.played}` : ""; } },
    { id: "2048", title: "2048", kind: "Puzzle", keys: "Arrow keys or swipe", icon: "2048",
      description: "Slide the tiles and merge equal numbers to reach 2048. Every move brings a new tile, so plan a few ahead.",
      build: build2048, focus: () => els2048?.board,
      stat: () => { const b = Number(store.get("2048-best", 0)) || 0; return b ? `Best ${b}` : ""; } },
    { id: "mines", title: "Minesweeper", kind: "Puzzle", keys: "Mouse or keyboard", icon: "mines",
      description: "Clear the field without setting off a mine. Each number counts the mines around it; right-click to flag one. Three sizes.",
      build: buildMines, focus: () => mineEls?.board, stat: () => bestTime("mines-best-" + mineLevel),
      pause: () => mineClock.stop() },
    { id: "sudoku", title: "Sudoku", kind: "Puzzle", keys: "Mouse or number keys", icon: "sudoku",
      description: "Fill the grid so every row, column and box holds 1 to 9. Three levels, each puzzle with a single solution, and pencil notes.",
      build: buildSudoku, focus: openSudoku, stat: () => bestTime("sudoku-best-" + sudokuLevel),
      pause: () => sudokuClock.stop() },
    { id: "pairs", title: "Pairs", kind: "Memory", keys: "Mouse or keyboard", icon: "pairs",
      description: "Turn over two cards at a time and find all eight pairs of code symbols in as few moves as you can.",
      build: buildPairs, focus: () => pairEls?.buttons[0],
      stat: () => { const b = Number(store.get("pairs-best", 0)) || 0; return b ? `Best ${plural(b, "move", "moves")}` : ""; } },
    { id: "fifteen", title: "Fifteen", kind: "Puzzle", keys: "Arrow keys or mouse", icon: "fifteen",
      description: "Slide the numbered tiles back into order, 1 to 15, through the one empty square.",
      build: buildFifteen, focus: () => fifteenEls?.board,
      stat: () => { const b = Number(store.get("fifteen-best", 0)) || 0; return b ? `Best ${plural(b, "move", "moves")}` : ""; } },
  ];

  window.relayLoungePuzzles = {
    activities,
    logic: {
      scoreGuess, letterMarks, words: CODLE_WORDS.map(([word]) => word),
      slideLine, move2048, canMove2048, addTile2048,
      neighbours, layMines, mineCounts, openFrom,
      solveSudoku, makeSudoku,
      dealPairs,
      slideFifteen, shuffleFifteen, isSolvedFifteen,
    },
  };
})();
