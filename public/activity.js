(() => {
  'use strict';
  // Work time and activity. Today's working time sits in the status bar (in Flow, in the header); a card suggests a break,
  // lunch or an end to a long day; and Activity shows each day, week and month: the time, what you did, and this month's
  // badges. The app does the counting (src/activity.mjs). This page only says, every 30 seconds and whenever it changes,
  // how long ago your last input was and whether Codeshi is in front. Nothing leaves the computer.
  const $ = id => document.getElementById(id), api = window.relayUI, desktop = window.relayDesktop;
  if (!api || !$('activity-popover')) return;
  const { t, tn } = window.codeshiText;
  const BEAT_MS = 30_000, IDLE_MS = 5 * 60_000, BREAK_MS = 5 * 60_000, LUNCH_MS = 30 * 60_000;
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const glyph = (name, cls = '') => { const value = node('span', `activity-glyph${cls ? ' ' + cls : ''}`); value.dataset.icon = name; value.setAttribute('aria-hidden', 'true'); return value; };
  const button = (text, handler, cls = 'secondary-button') => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };

  // Times and numbers.
  const parts = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return { h: Math.floor(seconds / 3600), m: Math.floor(seconds % 3600 / 60), s: seconds % 60 }; };
  const short = ms => { const { h, m } = parts(ms); return h ? `${h}h ${m}m` : `${m}m`; };
  const exact = ms => { const { h, m, s } = parts(ms); return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`; };
  const clock = ms => { const seconds = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
  const compact = value => value >= 1e9 ? `${(value / 1e9).toFixed(1)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e4 ? `${Math.round(value / 1e3)}k` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(Math.round(value));
  const dateOf = key => { const [year, month, day] = key.split('-').map(Number); return new Date(year, month - 1, day); };
  const keyOf = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const timeOf = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  // A month's name starts with a capital, as a tab or a heading, in languages that write it in lower case.
  const monthName = key => { const name = dateOf(`${key}-01`).toLocaleDateString(undefined, { month: 'long' }); return name.charAt(0).toLocaleUpperCase() + name.slice(1); };
  const AGENTS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', local: t('Local model') };

  // This month's badges, in the order the app counts them.
  const BADGES = {
    'steady-week': { icon: 'steady-week', name: t('Steady week'), description: t('Work on 5 days of one week') },
    'good-rhythm': { icon: 'good-rhythm', name: t('Good rhythm'), description: t('5 days of 4 hours or more, with a break at least every 90 minutes') },
    'lunch-breaks': { icon: 'lunch', name: t('Lunch breaks'), description: t('Take a 30-minute lunch break on 5 days') },
    'forty-hours': { icon: 'forty-hours', name: t('40 hours'), description: t('Work 40 hours this month') },
    finisher: { icon: 'finisher', name: t('Finisher'), description: t('Get 10 Plan cards done this month') },
    'hundred-prompts': { icon: 'hundred-prompts', name: t('100 prompts'), description: t('Send 100 prompts this month') },
    'million-tokens': { icon: 'million-tokens', name: t('1M tokens'), description: t('Your agents use a million new tokens this month') },
    arcade: { icon: 'arcade', name: t('Arcade'), description: t('Play 10 games in the Lounge this month') },
  };
  const progressOf = badge => badge.id === 'forty-hours' ? `${Math.floor(badge.value / 3_600_000)} / 40h` : badge.id === 'million-tokens' ? `${compact(badge.value)} / 1M` : `${badge.value} / ${badge.target}`;
  // Ideas for a break, one per stretch, so the card says the same thing until you take it.
  const TIPS = [
    t('Stand up and walk for five minutes. Your agents keep working while you’re away.'),
    t('Get a glass of water, and look at something far away for a minute.'),
    t('Stretch your neck, shoulders and wrists, then roll your shoulders back.'),
    t('Step outside or open a window. Fresh air helps the next idea.'),
    t('Look away from the screen and let your eyes rest.'),
  ];

  let live = null, received = 0, view = null, range = 'week', selected = null, anchor = null, beating = false, lastInput = Date.now(), timer = null, ticker = null;
  let shownReminder = null, pause = null, pauseTimer = null, toasted = new Set();
  const bannered = new Set();
  const popover = $('activity-popover'), cards = $('activity-cards');
  const isOpen = () => popover.matches?.(':popover-open') === true;

  // What the window reports. The desktop app knows the last input anywhere on the computer, so time spent in another
  // app while an agent works counts; a browser knows only its own page.
  async function idleMs() {
    if (desktop?.getIdle) { try { const value = await desktop.getIdle(); if (Number.isFinite(value?.idleMs)) return value.idleMs; } catch { /* The page's own input instead. */ } }
    return Date.now() - lastInput;
  }
  async function beat() {
    if (beating) return;
    beating = true;
    try { apply(await api.post('/api/activity/beat', { idleMs: await idleMs(), focused: document.hasFocus?.() === true })); }
    catch { /* The next report tries again. */ }
    finally { beating = false; }
  }
  function schedule(delay = BEAT_MS) { clearTimeout(timer); timer = setTimeout(async () => { await beat(); schedule(); }, delay); }
  const touched = () => { const away = Date.now() - lastInput; lastInput = Date.now(); if (away > 60_000) schedule(0); };
  for (const type of ['keydown', 'pointerdown', 'wheel']) window.addEventListener(type, touched, { passive: true, capture: true });
  window.addEventListener('pointermove', () => { if (Date.now() - lastInput > 5000) touched(); }, { passive: true });
  window.addEventListener('focus', () => schedule(0));
  window.addEventListener('blur', () => schedule(0));
  document.addEventListener('visibilitychange', () => schedule(0));

  function apply(result) {
    if (!result || typeof result !== 'object') return;
    live = result; received = Date.now();
    render(); remind(); announce();
    // An open Activity view follows along: drawn again with each report, so today's counts stay current.
    if (isOpen()) { if (result.months) { view = result; draw(); } else refreshView(); }
  }
  let refreshing = false;
  async function refreshView() {
    if (refreshing) return;
    refreshing = true;
    try { view = await api.api('/api/activity'); if (isOpen()) draw(); } catch { /* The next report tries again. */ }
    finally { refreshing = false; }
  }
  // Today's time, with what has passed since the last report while it is still counting.
  const todayMs = () => !live?.tracking ? 0 : live.activeMs + (live.counting ? Math.min(Date.now() - received, IDLE_MS) : 0);
  const pausing = () => Boolean(pause && pause.until > Date.now());

  // The timer in the status bar, and in Flow's header. Its words change once a minute, or each second during a break.
  function render() {
    const shown = Boolean(live?.tracking && live.settings?.statusBar), resting = pausing();
    const text = resting ? clock(pause.until - Date.now()) : short(todayMs());
    const title = resting ? t('On a break. Click to see your day.') : t('Worked today: {time}. Click for your week, your month and badges.', { time: exact(todayMs()) });
    for (const id of ['status-work-time', 'header-work-time']) {
      const control = $(id); if (!control) continue;
      control.hidden = !shown;
      control.dataset.state = resting ? 'break' : live?.counting ? 'counting' : 'paused';
      const label = $(`${id}-label`); if (label && label.textContent !== text) label.textContent = text;
      if (control.title !== title) { control.title = title; control.setAttribute('aria-label', resting ? t('On a break: {time} left', { time: text }) : t('Worked today: {time}', { time: exact(todayMs()) })); }
    }
  }

  // Cards at the foot of the window: a reminder, a break in progress, a badge.
  function card(kind, { icon, title, body, actions = [], dismiss = null, extra = null }) {
    const box = node('section', 'activity-card'); box.dataset.kind = kind; box.setAttribute('role', 'status');
    const text = node('div', 'activity-card-text'), head = node('div', 'activity-card-head');
    head.append(node('strong', 'activity-card-title', title)); if (extra) head.append(extra);
    text.append(head); if (body) text.append(node('p', 'activity-card-body', body));
    if (actions.length) { const row = node('div', 'activity-card-actions'); row.append(...actions); text.append(row); }
    const mark = node('span', 'activity-card-mark'); mark.append(glyph(icon));
    box.append(mark, text);
    if (dismiss) { const close = node('button', 'icon-button activity-card-close'); close.type = 'button'; close.setAttribute('aria-label', t('Dismiss')); close.title = t('Dismiss'); close.append(glyph('close')); close.addEventListener('click', dismiss); box.append(close); }
    return box;
  }
  function place(kind, element) {
    cards.querySelector?.(`.activity-card[data-kind="${kind}"]`)?.remove();
    if (element) cards.prepend(element);
    cards.hidden = !cards.querySelector?.('.activity-card');
  }
  const clearSlot = kinds => { for (const kind of kinds) place(kind, null); };

  // A reminder the app says is due, shown once; a banner too while Codeshi is behind other windows.
  function words(due) {
    if (due.kind === 'lunch') return { icon: 'lunch', title: t('Time for lunch?'), body: t('You’ve worked {time} today. Step away and eat; your agents keep going while you’re gone.', { time: short(due.activeMs) }) };
    if (due.kind === 'long-day') return { icon: 'sunset', title: t('That’s a full day'), body: t('You’ve worked {time} today. Stopping at a good point beats stopping tired.', { time: short(due.activeMs) }) };
    if (due.kind === 'late') return { icon: 'moon', title: t('It’s getting late'), body: t('Sleep does more for tomorrow’s work than another hour tonight.') };
    return { icon: 'walk', title: t('You’ve worked {time} without a break', { time: short(due.stretchMs) }), body: TIPS[(due.tip || 0) % TIPS.length] };
  }
  async function answer(due, action) {
    try { apply(await api.post('/api/activity/reminder', { action, id: due.id })); }
    catch (error) { api.showNotice?.(error.message); }
  }
  function remind() {
    const due = live?.tracking ? live.reminder : null;
    if (pausing()) return;
    if (!due) { if (shownReminder) clearSlot(['reminder']); shownReminder = null; return; }
    if (shownReminder === due.id) return;
    shownReminder = due.id;
    const text = words(due), later = button(t('Later'), () => { clearSlot(['reminder']); answer(due, 'later'); });
    later.title = t('Remind me in 15 minutes');
    const primary = due.kind === 'break' ? button(t('Take a 5-minute break'), () => { startPause('break'); answer(due, 'ok'); }, 'primary-button')
      : due.kind === 'lunch' ? button(t('Take a lunch break'), () => { startPause('lunch'); answer(due, 'ok'); }, 'primary-button')
      : button(due.kind === 'long-day' ? t('Wrap up') : t('OK'), () => { clearSlot(['reminder']); answer(due, 'ok'); }, 'primary-button');
    place('reminder', card('reminder', { ...text, actions: [primary, later], dismiss: () => { clearSlot(['reminder']); answer(due, 'ok'); } }));
    if (document.hasFocus?.() !== true && desktop?.breakBanner && !bannered.has(due.id)) { bannered.add(due.id); desktop.breakBanner({ title: text.title, body: text.body }).catch(() => {}); }
  }

  // A break you chose to take: a countdown here and in the status bar, then a welcome back.
  function startPause(kind) {
    const length = kind === 'lunch' ? LUNCH_MS : BREAK_MS, tip = live?.reminder?.tip || 0;
    pause = { kind, until: Date.now() + length, length, tip };
    clearSlot(['reminder']); shownReminder = null;
    drawPause(); render();
    clearInterval(pauseTimer); pauseTimer = setInterval(() => { if (pausing()) { tickPause(); render(); } else endPause(true); }, 1000);
  }
  function drawPause() {
    const time = node('span', 'activity-card-time', clock(pause.until - Date.now())), bar = node('span', 'activity-card-progress');
    const box = card('pause', { icon: pause.kind === 'lunch' ? 'lunch' : 'cup', title: pause.kind === 'lunch' ? t('Lunch break') : t('On a break'),
      body: pause.kind === 'lunch' ? t('Enjoy it. Codeshi will be here when you’re back.') : TIPS[pause.tip % TIPS.length],
      actions: [button(t('I’m back'), () => endPause(false))], extra: time });
    box.append(bar); place('pause', box); tickPause();
  }
  function tickPause() {
    const box = cards.querySelector?.('.activity-card[data-kind="pause"]'); if (!box || !pause) return;
    const left = Math.max(0, pause.until - Date.now()), time = box.querySelector('.activity-card-time'), bar = box.querySelector('.activity-card-progress');
    if (time) time.textContent = clock(left);
    if (bar) bar.style.transform = `scaleX(${(left / pause.length).toFixed(4)})`;
  }
  function endPause(finished) {
    clearInterval(pauseTimer); pauseTimer = null;
    const was = pause; pause = null; clearSlot(['pause']); render();
    if (finished && was) {
      const welcome = card('welcome', { icon: 'check', title: t('Welcome back'), body: tn(live?.settings?.every || 60, 'Break taken. The next reminder comes after a minute of work.', 'Break taken. The next reminder comes after {count} minutes of work.'), dismiss: () => clearSlot(['welcome']) });
      place('welcome', welcome); setTimeout(() => welcome.isConnected && clearSlot(['welcome']), 12_000);
    }
    remind();
  }

  // A badge earned this month, said once.
  function announce() {
    const fresh = (live?.announce || []).filter(item => BADGES[item.id] && !toasted.has(`${item.month}:${item.id}`));
    if (!fresh.length) return;
    for (const item of fresh) toasted.add(`${item.month}:${item.id}`);
    const first = BADGES[fresh[0].id], names = fresh.map(item => BADGES[item.id].name).join(', ');
    const toast = card('badge', { icon: first.icon, title: tn(fresh.length, 'Badge earned: {name}', '{count} badges earned', { name: first.name }),
      body: fresh.length === 1 ? first.description : names, actions: [button(t('See badges'), () => { clearSlot(['badge']); open({ section: 'badges' }); })], dismiss: () => clearSlot(['badge']) });
    place('badge', toast); setTimeout(() => toast.isConnected && clearSlot(['badge']), 15_000);
    api.post('/api/activity/seen', { ids: fresh.map(item => item.id) }).catch(() => {});
  }

  // Activity: the chosen day at the top, then the week, this month or last month, then the month's badges.
  async function open({ from = null, section = null } = {}) {
    anchor = from || [$('status-work-time'), $('header-work-time')].find(item => item && !item.hidden && item.getClientRects?.().length) || $('relay-settings');
    try { view = await api.api('/api/activity'); }
    catch (error) { api.showNotice?.(error.message); return; }
    live = { ...live, ...view, months: undefined }; received = Date.now();
    selected = null; range = section === 'badges' ? 'month' : range;
    if (!isOpen()) popover.showPopover?.();
    for (const id of ['status-work-time', 'header-work-time']) $(id)?.setAttribute('aria-expanded', 'true');
    draw(); render();
    if (section === 'badges') popover.querySelector?.('.activity-badges')?.scrollIntoView?.({ block: 'nearest' });
    clearInterval(ticker); ticker = setInterval(() => { if (!isOpen()) { clearInterval(ticker); ticker = null; return; } tickHero(); }, 1000);
  }
  function close() { if (isOpen()) popover.hidePopover?.(); }
  popover.addEventListener('toggle', event => {
    if (event.newState === 'open') return;
    clearInterval(ticker); ticker = null;
    for (const id of ['status-work-time', 'header-work-time']) $(id)?.setAttribute('aria-expanded', 'false');
  });
  $('close-activity')?.addEventListener('click', close);
  for (const id of ['status-work-time', 'header-work-time']) $(id)?.addEventListener('click', event => { if (isOpen()) close(); else open({ from: event.currentTarget }); });
  window.addEventListener('resize', () => { if (isOpen()) position(); });

  function position() {
    if (!isOpen() || !anchor) return;
    const edge = 12, gap = 8, width = Math.min(412, window.innerWidth - edge * 2), rect = anchor.getBoundingClientRect(), below = rect.top < window.innerHeight / 2;
    popover.style.width = `${width}px`;
    popover.style.maxHeight = `${Math.max(240, below ? window.innerHeight - rect.bottom - gap - edge : rect.top - gap - edge)}px`;
    const height = popover.getBoundingClientRect().height;
    popover.style.left = `${Math.max(edge, Math.min(rect.right - width, window.innerWidth - width - edge))}px`;
    popover.style.top = `${below ? rect.bottom + gap : Math.max(edge, rect.top - gap - height)}px`;
  }

  function daysByDate() { const map = new Map(); for (const month of view?.months || []) for (const day of month.days) map.set(day.date, day); return map; }
  const empty = date => ({ date, activeMs: 0, breaks: 0, longestMs: 0, firstAt: null, lastAt: null, spans: [], prompts: 0, runs: 0, tokens: 0, agents: {}, cards: 0, groups: 0, merges: 0, games: 0 });

  function draw() {
    if (!view) return;
    const content = $('activity-content'), today = view.today || keyOf(new Date());
    $('activity-date').textContent = dateOf(today).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    if (!view.tracking) {
      const off = node('div', 'activity-off');
      off.append(glyph('stopwatch', 'activity-off-mark'), node('strong', undefined, t('Work time is off')), node('p', undefined, t('Turn it on to see how long you work each day, with breaks, prompts, tokens, cards and games. It stays on this computer.')),
        button(t('Turn on'), () => change({ track: true }), 'primary-button'));
      content.replaceChildren(off, footer()); position(); return;
    }
    content.replaceChildren(hero(today), ranges(today), badges(), footer());
    position();
  }

  // The chosen day, today unless you picked another in the chart.
  function hero(today) {
    const days = daysByDate(), key = selected || today, day = days.get(key) || empty(key), isToday = key === today;
    const section = node('section', 'activity-hero');
    const top = node('div', 'activity-hero-top'), label = node('div', 'activity-hero-label');
    label.append(node('span', 'activity-eyebrow', isToday ? t('Today') : dateOf(key).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })));
    if (!isToday) label.append(button(t('Back to today'), () => { selected = null; draw(); }, 'text-link activity-today-link'));
    top.append(label);
    if (isToday) top.append(nextBreak());
    const total = node('div', 'activity-total'); total.dataset.part = 'total';
    fillTotal(total, isToday ? todayMs() : day.activeMs);
    const facts = [];
    if (day.firstAt) facts.push(isToday && live?.counting ? t('Since {time}', { time: timeOf(day.firstAt) }) : t('{from} – {to}', { from: timeOf(day.firstAt), to: timeOf(day.lastAt) }));
    if (day.activeMs) facts.push(tn(day.breaks, 'One break', '{count} breaks'));
    if (day.longestMs >= 60_000) facts.push(t('Longest stretch {time}', { time: short(day.longestMs) }));
    const meta = node('p', 'activity-hero-meta', facts.length ? facts.join(' · ') : isToday ? t('Nothing yet today. The timer starts when you work with Codeshi.') : t('No work this day.'));
    section.append(top, total, meta, timeline(day), stats([
      ['prompts', t('Prompts'), String(day.prompts)], ['tokens', t('Tokens'), compact(day.tokens)], ['cards', t('Cards done'), String(day.cards)], ['games', t('Games'), String(day.games)],
    ], 'activity-day-stats'));
    return section;
  }
  function fillTotal(element, ms) {
    const { h, m, s } = parts(ms), unit = text => node('span', 'activity-unit', text);
    const pieces = h ? [String(h), unit('h'), ' ', String(m), unit('m')] : [String(m), unit('m')];
    pieces.push(' ', node('span', 'activity-seconds', `${s}s`));
    element.replaceChildren(...pieces.map(item => typeof item === 'string' ? document.createTextNode(item) : item));
    element.dataset.ms = String(Math.floor(ms / 1000));
  }
  function tickHero() {
    const total = popover.querySelector?.('.activity-total');
    if (total && !selected && live?.counting) { const ms = todayMs(); if (total.dataset.ms !== String(Math.floor(ms / 1000))) fillTotal(total, ms); }
    if (pausing() || live?.counting) { const pill = popover.querySelector?.('.activity-next'); if (pill) pill.replaceWith(nextBreak()); }
  }
  function nextBreak() {
    const pill = node('span', 'activity-next');
    if (pausing()) { pill.dataset.state = 'break'; pill.append(glyph('cup'), document.createTextNode(t('On a break · {time}', { time: clock(pause.until - Date.now()) }))); return pill; }
    if (!live?.settings?.reminders || !live.present || !Number.isFinite(live.breakInMs)) { pill.hidden = true; return pill; }
    const left = live.breakInMs - (live.counting ? Math.min(Date.now() - received, IDLE_MS) : 0);
    pill.dataset.state = left <= 0 ? 'due' : 'counting';
    pill.append(glyph('walk'), document.createTextNode(left <= 0 ? t('Time for a break') : t('Break in {time}', { time: short(left + 59_999) })));
    return pill;
  }
  // The day from midnight to midnight, with each stretch of work on it.
  function timeline(day) {
    const strip = node('div', 'activity-timeline'), start = dateOf(day.date).getTime(), length = 86_400_000;
    strip.setAttribute('role', 'img');
    strip.setAttribute('aria-label', day.spans.length ? t('Worked from {from} to {to}', { from: timeOf(day.firstAt), to: timeOf(day.lastAt) }) : t('No work this day.'));
    const track = node('div', 'activity-timeline-track');
    for (const [from, to] of day.spans) {
      const block = node('span', 'activity-timeline-span');
      block.style.left = `${((from - start) / length * 100).toFixed(3)}%`;
      block.style.width = `${Math.max(0.35, (to - from) / length * 100).toFixed(3)}%`;
      track.append(block);
    }
    const marks = node('div', 'activity-timeline-marks');
    for (const hour of [0, 6, 12, 18, 24]) { const mark = node('span', undefined, new Date(2000, 0, 1, hour % 24).toLocaleTimeString(undefined, { hour: 'numeric' })); mark.style.left = `${hour / 24 * 100}%`; marks.append(mark); }
    strip.append(track, marks);
    return strip;
  }
  function stats(items, cls) {
    const grid = node('dl', `activity-stats ${cls}`);
    for (const [key, label, value] of items) { const item = node('div', 'activity-stat'); item.dataset.stat = key; item.append(node('dd', undefined, value), node('dt', undefined, label)); grid.append(item); }
    return grid;
  }

  // This week, this month or last month: a chart to pick a day from, then the totals.
  function ranges(today) {
    const section = node('section', 'activity-range'), tabs = node('div', 'segmented activity-tabs');
    tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', t('Period'));
    const [current, last] = view.months;
    for (const [id, text] of [['week', t('This week')], ['month', monthName(current.month)], ['last', monthName(last.month)]]) {
      const tab = button(text, () => { range = id; selected = null; draw(); }, ''); tab.setAttribute('aria-pressed', String(range === id)); tabs.append(tab);
    }
    const days = daysByDate();
    let list;
    if (range === 'week') {
      const now = dateOf(today), monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
      list = Array.from({ length: 7 }, (_, index) => { const key = keyOf(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index)); return days.get(key) || empty(key); });
    } else {
      const month = range === 'month' ? current : last;
      list = Array.from({ length: month.length }, (_, index) => { const key = `${month.month}-${String(index + 1).padStart(2, '0')}`; return days.get(key) || empty(key); });
    }
    if (range === 'week' || range === 'month') { const index = list.findIndex(day => day.date === today); if (index >= 0 && live?.tracking) list[index] = { ...list[index], activeMs: Math.max(list[index].activeMs, todayMs()) }; }
    section.append(tabs, range === 'week' ? bars(list, today) : calendar(list, today));
    // The totals, worked out here for a week, which can cross into last month; a month's come from the app.
    const totals = range === 'week' ? sum(list) : (range === 'month' ? current : last).totals;
    const worked = list.filter(day => day.activeMs >= 60_000).length;
    const summary = node('p', 'activity-range-summary');
    summary.append(node('strong', undefined, short(range === 'week' ? list.reduce((total, day) => total + day.activeMs, 0) : totals.activeMs)),
      document.createTextNode(' · ' + tn(worked, 'One day worked', '{count} days worked') + (worked ? ' · ' + t('{time} a day', { time: short((range === 'week' ? list.reduce((total, day) => total + day.activeMs, 0) : totals.activeMs) / worked) }) : '')));
    section.append(summary, stats([
      ['prompts', t('Prompts'), compact(totals.prompts)], ['tokens', t('Tokens'), compact(totals.tokens)], ['cards', t('Cards done'), compact(totals.cards)],
      ['merges', t('Merges'), compact(totals.merges)], ['games', t('Games'), compact(totals.games)], ['breaks', t('Breaks'), compact(totals.breaks)],
    ], 'activity-range-stats'), agents(totals.agents));
    return section;
  }
  function sum(list) {
    const totals = { prompts: 0, tokens: 0, cards: 0, merges: 0, games: 0, breaks: 0, agents: {} };
    for (const day of list) { for (const key of ['prompts', 'tokens', 'cards', 'merges', 'games', 'breaks']) totals[key] += day[key] || 0; for (const [agent, value] of Object.entries(day.agents || {})) totals.agents[agent] = (totals.agents[agent] || 0) + value; }
    return totals;
  }
  const dayTitle = day => `${dateOf(day.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${day.activeMs ? exact(day.activeMs) : t('no work')}`;
  function pick(day, today) { selected = day.date === (selected || today) ? null : day.date; if (selected === today) selected = null; draw(); }
  // A week: one bar a day, scaled to the longest day or four hours, whichever is more.
  function bars(list, today) {
    const chart = node('div', 'activity-bars'), most = Math.max(4 * 3_600_000, ...list.map(day => day.activeMs));
    for (const day of list) {
      const future = day.date > today, column = node('button', 'activity-bar'); column.type = 'button';
      column.dataset.today = String(day.date === today); column.setAttribute('aria-pressed', String(day.date === (selected || today))); column.disabled = future;
      column.title = dayTitle(day); column.setAttribute('aria-label', dayTitle(day));
      const value = node('span', 'activity-bar-value', day.activeMs >= 60_000 ? short(day.activeMs) : '');
      const track = node('span', 'activity-bar-track'), fill = node('span', 'activity-bar-fill');
      fill.style.height = `${day.activeMs ? Math.max(4, day.activeMs / most * 100).toFixed(2) : 0}%`;
      track.append(fill);
      column.append(value, track, node('span', 'activity-bar-day', dateOf(day.date).toLocaleDateString(undefined, { weekday: 'narrow' })));
      column.addEventListener('click', () => pick(day, today));
      chart.append(column);
    }
    return chart;
  }
  // A month: a calendar, each day shaded by how long you worked.
  function calendar(list, today) {
    const grid = node('div', 'activity-calendar'), first = dateOf(list[0].date), monday = new Date(2024, 0, 1);
    for (let index = 0; index < 7; index++) grid.append(node('span', 'activity-weekday', new Date(monday.getFullYear(), 0, 1 + index).toLocaleDateString(undefined, { weekday: 'narrow' })));
    for (let blank = 0; blank < (first.getDay() + 6) % 7; blank++) grid.append(node('span', 'activity-day-blank'));
    for (const day of list) {
      const hours = day.activeMs / 3_600_000, level = !day.activeMs ? 0 : hours < 1 ? 1 : hours < 3 ? 2 : hours < 6 ? 3 : 4;
      const cell = node('button', 'activity-day', String(dateOf(day.date).getDate())); cell.type = 'button';
      cell.dataset.level = String(level); cell.dataset.today = String(day.date === today); cell.disabled = day.date > today;
      cell.setAttribute('aria-pressed', String(day.date === selected)); cell.title = dayTitle(day); cell.setAttribute('aria-label', dayTitle(day));
      cell.addEventListener('click', () => pick(day, today));
      grid.append(cell);
    }
    return grid;
  }
  // Which agents the tokens went to.
  function agents(totals) {
    const entries = Object.entries(totals || {}).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]), all = entries.reduce((total, [, value]) => total + value, 0);
    const box = node('div', 'activity-agents'); if (!all) { box.hidden = true; return box; }
    const bar = node('div', 'activity-agents-bar'), legend = node('p', 'activity-agents-legend');
    entries.forEach(([agent, value], index) => {
      const share = value / all, part = node('span'); part.dataset.agent = agent; part.style.flexGrow = String(share); bar.append(part);
      const item = node('span', 'activity-agent'); item.dataset.agent = agent; item.append(node('i'), document.createTextNode(`${AGENTS[agent] || agent} ${Math.round(share * 100)}%`));
      if (index) legend.append(document.createTextNode(' '));
      legend.append(item);
    });
    box.append(bar, legend);
    return box;
  }

  // The badges of the month being looked at: this month's, or last month's in Last month.
  function badges() {
    const month = range === 'last' ? view.months[1] : view.months[0], earned = month.badges.filter(badge => badge.earnedOn).length;
    const section = node('section', 'activity-badges'), head = node('header', 'activity-section-head');
    head.append(node('h3', undefined, t('Badges · {month}', { month: monthName(month.month) })), node('span', 'activity-count', t('{earned} of {total}', { earned, total: month.badges.length })));
    const grid = node('ul', 'activity-badge-grid');
    for (const badge of month.badges) {
      const about = BADGES[badge.id]; if (!about) continue;
      const item = node('li', 'activity-badge'); item.dataset.earned = String(Boolean(badge.earnedOn));
      const ring = node('span', 'activity-badge-ring'); ring.style.setProperty('--progress', String(Math.min(1, badge.value / badge.target)));
      ring.append(glyph(about.icon));
      item.append(ring, node('span', 'activity-badge-name', about.name), node('span', 'activity-badge-progress', badge.earnedOn ? dateOf(badge.earnedOn).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : progressOf(badge)));
      item.title = `${about.name}: ${about.description}${badge.earnedOn ? ' · ' + t('Earned {date}', { date: dateOf(badge.earnedOn).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) }) : ''}`;
      grid.append(item);
    }
    section.append(head, grid);
    return section;
  }
  function footer() {
    const foot = node('footer', 'activity-foot');
    foot.append(node('span', undefined, t('Only on this computer, for this month and last month.')), button(t('Settings'), () => { close(); window.relaySettings?.open('general', 'Work time'); }, 'text-link'));
    return foot;
  }

  async function change(patch) {
    const result = await api.post('/api/activity/settings', patch);
    view = result; apply(result);
    if (patch.track === false) { clearSlot(['reminder', 'pause', 'welcome']); pause = null; clearInterval(pauseTimer); }
    if (isOpen()) draw();
    return result;
  }
  // Settings › General › Work time.
  function settings(host, kit) {
    const rows = kit.group(host, t('Work time'), t('Codeshi counts time while you’re at the computer and Codeshi is in front, or an agent is working for you. Five minutes away is a break. It stays on this computer, for this month and last month.'));
    const current = live?.settings || { track: true, statusBar: true, reminders: true, every: 60 };
    const controls = [];
    const set = async (patch, control) => {
      for (const item of controls) item.disabled = true;
      try { const result = await change(patch); Object.assign(current, result.settings); }
      catch (error) { if (control.type === 'checkbox') control.checked = !control.checked; api.showNotice?.(error.message); }
      finally { for (const item of controls) item.disabled = item.dataset.needsTracking === 'true' && !current.track; }
    };
    const track = kit.toggle(rows, { label: t('Track working time'), description: t('Count your working time each day, with your prompts, tokens, cards done and games.'), keywords: 'timer hours work time activity tracking', checked: current.track, onChange: value => set({ track: value }, track) });
    const bar = kit.toggle(rows, { label: t('Show today’s time'), description: t('In the status bar, or in the header in Flow. Click it for your week, month and badges.'), keywords: 'timer status bar header clock', checked: current.statusBar, onChange: value => set({ statusBar: value }, bar) });
    const breaks = kit.toggle(rows, { label: t('Break reminders'), description: t('Suggests a walk, water or stretch after a stretch without a break, lunch around midday, and stopping after a long day or late at night.'), keywords: 'break reminder walk lunch health rest', checked: current.reminders, onChange: value => set({ reminders: value }, breaks) });
    const every = kit.select(rows, { label: t('Remind me after'), description: t('Working this long without five minutes away.'), keywords: 'break interval minutes',
      options: [[30, t('30 minutes')], [45, t('45 minutes')], [60, t('1 hour')], [90, t('1 hour 30 minutes')], [120, t('2 hours')]].map(([value, text]) => [String(value), text]), value: String(current.every), onChange: value => set({ every: Number(value) }, every) });
    for (const item of [bar, breaks, every]) item.dataset.needsTracking = 'true';
    controls.push(track, bar, breaks, every);
    for (const item of [bar, breaks, every]) item.disabled = !current.track;
    const show = kit.button(t('Open activity'), () => { window.relaySettings?.close(); open(); });
    let armed = null;
    const clear = node('button', 'settings-button danger', t('Clear history…')); clear.type = 'button';
    clear.addEventListener('click', async () => {
      if (!armed) { clear.textContent = t('Clear all activity'); armed = setTimeout(() => { armed = null; clear.textContent = t('Clear history…'); }, 4000); return; }
      clearTimeout(armed); armed = null; clear.disabled = true;
      try { await api.post('/api/activity/clear', {}).then(apply); toasted = new Set(); clear.textContent = t('Cleared'); }
      catch (error) { api.showNotice?.(error.message); clear.textContent = t('Clear history…'); }
      finally { clear.disabled = false; }
    });
    kit.row(rows, { label: t('Activity history'), description: t('Each day of this month and last month. Older days are deleted, and nothing is sent anywhere.'), keywords: 'history delete clear privacy', control: [show, clear] });
  }

  // A game started in the Lounge.
  function played() { if (live?.tracking !== false) api.post('/api/activity/note', { kind: 'games' }).then(apply).catch(() => {}); }

  window.relayActivity = { open, close, settings, played, refresh: () => schedule(0), state: () => live };
  schedule(0);
})();
