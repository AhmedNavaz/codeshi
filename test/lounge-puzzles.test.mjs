import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The rules of the Lounge puzzles, run without a page: public/flow-lounge-puzzles.js only touches the page when a
// panel is built, so loading it needs nothing but a window to put its activities on.
const source = fs.readFileSync(new URL('../public/flow-lounge-puzzles.js', import.meta.url), 'utf8');
function load() {
  const saved = new Map();
  const window = {};
  const context = vm.createContext({ window, localStorage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, String(v)) } });
  vm.runInContext(source, context, { filename: 'public/flow-lounge-puzzles.js' });
  return window.relayLoungePuzzles;
}
// A small seeded generator, so a failure can be replayed.
function seeded(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const { activities, logic } = load();

test('Lounge puzzles are six activities, each with a title, a description, a panel and a way in', () => {
  assert.deepEqual([...activities.map(a => a.id)], ['codle', '2048', 'mines', 'sudoku', 'pairs', 'fifteen']);
  for (const a of activities) {
    assert.ok(a.title && a.kind && a.keys && a.icon, `${a.id} has its tile facts`);
    assert.ok(a.description.length > 40, `${a.id} has a description`);
    assert.equal(typeof a.build, 'function'); assert.equal(typeof a.focus, 'function'); assert.equal(typeof a.stat, 'function');
    assert.equal(a.stat(), '', `${a.id} has no best before it's played`);
  }
  // Only the games with a clock need pausing.
  assert.deepEqual([...activities.filter(a => a.pause).map(a => a.id)], ['mines', 'sudoku']);
});

test('Codle scores a guess as Wordle does, counting repeated letters only as often as the word has them', () => {
  assert.deepEqual([...logic.scoreGuess('SASSY', 'STASH')], ['correct', 'present', 'absent', 'correct', 'absent']);
  assert.deepEqual([...logic.scoreGuess('EERIE', 'QUEUE')], ['present', 'absent', 'absent', 'absent', 'correct']);
  assert.deepEqual([...logic.scoreGuess('MUTEX', 'MUTEX')], Array(5).fill('correct'));
  // The keyboard keeps the best each letter has scored.
  const marks = logic.letterMarks(['QUEUE', 'STATE'], [logic.scoreGuess('QUEUE', 'STASH'), logic.scoreGuess('STATE', 'STASH')]);
  assert.equal(marks.S, 'correct'); assert.equal(marks.E, 'absent'); assert.equal(marks.Q, 'absent');
  // Every answer is five capital letters, with no repeats in the list.
  assert.ok(logic.words.length >= 60);
  assert.ok(logic.words.every(w => /^[A-Z]{5}$/.test(w)));
  assert.equal(new Set(logic.words).size, logic.words.length);
});

test('2048 merges each pair once per move, towards the edge it slides to', () => {
  { const r = logic.slideLine([2, 2, 2, 2]); assert.deepEqual({ line: [...r.line], gained: r.gained, merged: [...r.merged], moved: r.moved }, { line: [4, 4, 0, 0], gained: 8, merged: [0, 1], moved: true }); }
  assert.deepEqual([...logic.slideLine([2, 2, 4, 0]).line], [4, 4, 0, 0], 'a merged tile does not merge again in the same move');
  assert.deepEqual([...logic.slideLine([4, 0, 4, 8]).line], [8, 8, 0, 0]);
  assert.equal(logic.slideLine([2, 4, 8, 16]).moved, false);
  const grid = [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4];
  assert.deepEqual([...logic.move2048(grid, 'right').grid.slice(0, 4)], [0, 0, 0, 4]);
  assert.equal(logic.move2048(grid, 'down').grid[12], 2);
  assert.equal(logic.move2048(grid, 'right').gained, 4);
  // Full with no equal neighbours: no moves left.
  const stuck = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2];
  assert.equal(logic.canMove2048(stuck), false);
  stuck[1] = 2;
  assert.equal(logic.canMove2048(stuck), true);
  const empty = Array(16).fill(0), at = logic.addTile2048(empty, seeded(1));
  assert.ok([2, 4].includes(empty[at]));
});

test('Minesweeper lays its mines away from the first square, and an empty square opens its neighbours', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const mines = logic.layMines(9, 9, 10, 40, seeded(seed));
    assert.equal(mines.filter(Boolean).length, 10);
    for (const i of [40, ...logic.neighbours(40, 9, 9)]) assert.equal(mines[i], false, 'the first square and its neighbours are clear');
  }
  // A corner start on a crowded board still gets the exact count.
  assert.equal(logic.layMines(9, 9, 77, 0, seeded(3)).filter(Boolean).length, 77);
  assert.deepEqual([...logic.neighbours(0, 9, 9)].sort((a, b) => a - b), [1, 9, 10]);
  // One mine in a corner of a 3×3 field: opening the far corner opens everything else.
  const mines = [true, false, false, false, false, false, false, false, false];
  const state = { rows: 3, cols: 3, mines, counts: logic.mineCounts(mines, 3, 3), open: Array(9).fill(false), flag: Array(9).fill(false) };
  assert.deepEqual([...state.counts], [0, 1, 0, 1, 1, 0, 0, 0, 0]);
  const opened = logic.openFrom(state, 8);
  assert.equal(opened.length, 8); assert.equal(state.open[0], false);
  // A flag holds a square shut.
  const flagged = { ...state, open: Array(9).fill(false), flag: [false, false, false, false, false, true, false, false, false] };
  assert.equal(logic.openFrom(flagged, 8).includes(5), false);
});

test('Sudoku puzzles have the givens asked for, a single solution, and a solution that keeps every rule', () => {
  const valid = grid => {
    for (let k = 0; k < 9; k++) {
      const row = new Set(), col = new Set(), box = new Set();
      for (let j = 0; j < 9; j++) {
        row.add(grid[k * 9 + j]); col.add(grid[j * 9 + k]);
        box.add(grid[(Math.floor(k / 3) * 3 + Math.floor(j / 3)) * 9 + (k % 3) * 3 + (j % 3)]);
      }
      if (row.size !== 9 || col.size !== 9 || box.size !== 9) return false;
    }
    return grid.every(v => v >= 1 && v <= 9);
  };
  for (const [seed, givens] of [[1, 40], [2, 32], [3, 26]]) {
    const { puzzle, solution } = logic.makeSudoku(givens, seeded(seed));
    assert.ok(valid(solution), 'the solution is a full, valid grid');
    assert.ok(puzzle.every((v, i) => !v || v === solution[i]), 'every given is from the solution');
    const left = puzzle.filter(Boolean).length;
    assert.ok(left >= givens && left <= givens + 4, `about ${givens} givens (got ${left})`);
    const solved = logic.solveSudoku(puzzle, 2);
    assert.equal(solved.count, 1, 'a single solution');
    assert.deepEqual([...solved.solution], [...solution]);
  }
  // A grid that breaks a rule has no solution, and an empty one has many.
  const broken = Array(81).fill(0); broken[0] = 5; broken[1] = 5;
  assert.equal(logic.solveSudoku(broken, 2).count, 0);
  assert.equal(logic.solveSudoku(Array(81).fill(0), 2).count, 2);
});

test('Pairs deals eight symbols twice each; Fifteen deals only boards that can be solved', () => {
  const cards = logic.dealPairs(seeded(4));
  assert.equal(cards.length, 16);
  const counts = {};
  for (const c of cards) counts[c.symbol] = (counts[c.symbol] || 0) + 1;
  assert.equal(Object.keys(counts).length, 8);
  assert.ok(Object.values(counts).every(n => n === 2));
  assert.ok(cards.every(c => !c.up && !c.matched));

  // On a 4×4 board, a deal can be solved when its inversions plus the gap's row (from the top) are odd.
  for (let seed = 1; seed <= 25; seed++) {
    const tiles = logic.shuffleFifteen(seeded(seed));
    assert.deepEqual([...tiles].sort((a, b) => a - b), [...Array(16).keys()]);
    assert.equal(logic.isSolvedFifteen(tiles), false);
    const numbers = tiles.filter(Boolean);
    let inversions = 0;
    for (let i = 0; i < numbers.length; i++) for (let j = i + 1; j < numbers.length; j++) if (numbers[i] > numbers[j]) inversions++;
    assert.equal((inversions + Math.floor(tiles.indexOf(0) / 4)) % 2, 1, `deal ${seed} can be solved`);
  }
  // A tile in line with the gap slides it and every tile between; one out of line doesn't move.
  const solved = [...Array(15).keys()].map(n => n + 1).concat(0);
  assert.equal(logic.isSolvedFifteen(solved), true);
  assert.deepEqual([...logic.slideFifteen(solved, 12)].slice(12), [0, 13, 14, 15]);
  assert.deepEqual([...logic.slideFifteen(solved, 3)].filter((_, i) => i % 4 === 3), [0, 4, 8, 12]);
  assert.equal(logic.slideFifteen(solved, 0), null);
  assert.equal(logic.slideFifteen(solved, 15), null);
});
