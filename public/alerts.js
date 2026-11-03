(() => {
  'use strict';
  // Alerts. When an agent needs you, finishes or stops while you are in another app, Codeshi can show a banner,
  // play a sound, bounce the Dock icon and count it on the Dock icon. Settings turns each way on or off, and for each
  // of those three moments (src/alerts.mjs keeps the rules). The page plays the sounds: each is a few short tones made
  // with Web Audio, so there are no audio files, and it plays in the desktop app and the browser alike.
  const api = window.relayUI;
  if (!api) return;
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  // [frequency in Hz, start in seconds, length in seconds] for each tone.
  const TONES = {
    // Two quick taps and a higher note: something is waiting for you.
    attention: { wave: 'triangle', notes: [[880, 0, 0.16], [880, 0.15, 0.16], [1174.66, 0.3, 0.5]] },
    // Two notes rising: done.
    finished: { wave: 'sine', notes: [[659.25, 0, 0.45], [987.77, 0.12, 0.65]] },
    // Two notes falling: it stopped before finishing.
    stopped: { wave: 'sine', notes: [[493.88, 0, 0.35], [369.99, 0.17, 0.6]] },
  };
  // The three moments, as the table's columns, with what each covers.
  const MOMENTS = [
    ['attention', 'Needs you', 'an agent needs you', 'An approval, a question or a handoff offer'],
    ['finished', 'Finished', 'a task finishes', 'A task finishes, or continues by itself after a usage limit'],
    ['stopped', 'Stopped', 'a task stops', 'An error, a usage limit or failing tests'],
  ];
  let context = null, lastAt = 0, host = null, settings = null, settingsKit = null;

  function audio() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    try { context ||= new AudioContext(); } catch { return null; }
    if (context.state === 'suspended') context.resume?.()?.catch?.(() => {});
    return context;
  }
  // Plays one sound at a volume from 0 to 100. A sound right after another is skipped, unless something needs you.
  function play(name, volume = 70) {
    const tone = TONES[name], ctx = audio(), now = Date.now();
    if (!tone || !ctx || !(volume > 0)) return false;
    if (now - lastAt < 400 && name !== 'attention') return false;
    lastAt = now;
    const master = ctx.createGain(); master.gain.value = Math.min(1, volume / 100) * 0.3; master.connect(ctx.destination);
    const start = ctx.currentTime + 0.02;
    for (const [frequency, offset, length] of tone.notes) {
      // Each note with a soft octave above it, for a bell-like tone that rises fast and fades out.
      for (const [ratio, level] of [[1, 1], [2, 0.16]]) {
        const oscillator = ctx.createOscillator(), gain = ctx.createGain(), at = start + offset;
        oscillator.type = tone.wave; oscillator.frequency.setValueAtTime(frequency * ratio, at);
        gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(level, at + 0.012); gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
        oscillator.connect(gain); gain.connect(master);
        oscillator.start(at); oscillator.stop(at + length + 0.05);
      }
    }
    return true;
  }
  // In the browser, several tabs may get the same alert; the first to take it plays it.
  function claim(id) {
    try {
      const key = `throughline:sound:${id}`;
      if (localStorage.getItem(key)) return false;
      localStorage.setItem(key, String(Date.now()));
      for (let index = localStorage.length - 1; index >= 0; index--) { const name = localStorage.key(index); if (name?.startsWith('throughline:sound:') && Date.now() - Number(localStorage.getItem(name)) > 600000) localStorage.removeItem(name); }
    } catch { /* Without storage, this tab plays it. */ }
    return true;
  }
  window.addEventListener('relay-alert', event => {
    const alert = event.detail;
    if (!alert?.sound || !TONES[alert.sound]) return;
    // "Only when Codeshi isn't in front" skips sounds while you are looking at it.
    if (alert.background && document.visibilityState !== 'hidden' && document.hasFocus?.()) return;
    if (alert.id && !claim(alert.id)) return;
    play(alert.sound, alert.volume);
  });

  async function save(patch) {
    try { settings = await api.post('/api/notifications', patch, null); }
    catch (error) { api.showNotice?.(error.message || 'Alert settings could not be saved.'); }
    if (host) render();
  }
  // The ways that apply here. Banners and the Dock icon belong to the desktop app; other systems flash the taskbar
  // button instead of bouncing an icon and have no badge or menu bar status. In a browser, only sounds apply.
  function ways() {
    const desktop = window.relayDesktop, platform = desktop ? desktop.platform || 'darwin' : null, mac = platform === 'darwin';
    return { mac, desktop: Boolean(desktop), rows: [
      ...desktop ? [['banner', 'Banner']] : [],
      ['sound', 'Sound'],
      ...desktop ? [['bounce', mac ? 'Bounce the Dock icon' : 'Flash the taskbar button']] : [],
      ...mac ? [['badge', 'Badge on the Dock icon']] : [],
    ] };
  }
  function checkbox(checked, change, { label, disabled = false } = {}) {
    const box = node('input'); box.type = 'checkbox'; box.checked = checked; box.disabled = disabled;
    if (label) box.setAttribute('aria-label', label);
    box.addEventListener('change', () => change(box.checked));
    return box;
  }

  // The Alerts page of Settings, drawn with the kit Settings lends (settings.js). The ways to alert you are a table:
  // one row for each way, switched on or off as a whole, then a box for each moment. A way that is off keeps its
  // choices for when it is turned back on. The options that belong to one way each follow as ordinary rows.
  function render() {
    const kit = settingsKit;
    if (!kit) return;
    host.replaceChildren();
    if (!settings) { kit.note(host, 'Loading alert settings…'); return; }
    const { mac, desktop, rows } = ways();
    const group = kit.group(host, 'Ways to alert you', 'How Codeshi tells you that an agent needs you, finished or stopped while you’re in another app. Turn each way on or off, and choose the moments it’s for.');
    const matrix = node('div', undefined, 'settings-row alert-matrix'); matrix.dataset.keywords = 'banner notification sound bounce dock badge needs you finished stopped approval';
    const table = node('table', undefined, 'alert-table'), head = node('tr'), body = node('tbody');
    head.append(node('th'));
    for (const [, name, , covers] of MOMENTS) { const column = node('th', name); column.scope = 'col'; column.title = covers; head.append(column); }
    const thead = node('thead'); thead.append(head);
    for (const [channel, name] of rows) {
      const row = node('tr'), way = settings[channel], label = node('label', undefined, 'alert-way'), title = node('th');
      row.dataset.channel = channel; if (!way.on) row.dataset.off = '';
      title.scope = 'row';
      label.append(checkbox(way.on, value => save({ [channel]: { on: value } })), node('span', name)); title.append(label); row.append(title);
      for (const [moment, column, phrase] of MOMENTS) {
        const cell = node('td');
        cell.append(checkbox(way[moment], value => save({ [channel]: { [moment]: value } }), { label: `${name} when ${phrase}`, disabled: !way.on }));
        if (channel === 'sound') {
          const test = node('button', undefined, 'alert-play'); test.type = 'button'; test.title = `Play the ${column} sound`; test.setAttribute('aria-label', `Play the ${column} sound`);
          test.addEventListener('click', () => { lastAt = 0; play(moment, settings.sound.volume ?? 70); });
          cell.append(test);
        }
        row.append(cell);
      }
      body.append(row);
    }
    table.append(thead, body);
    matrix.append(table, node('p', 'Needs you: an approval, a question or a handoff offer. Stopped: an error, a usage limit or failing tests.', 'alert-legend'));
    group.append(matrix);

    const options = kit.group(host, desktop ? 'Banners and sounds' : 'Sounds');
    // A banner is a macOS notification, or a panel near the top of the screen, which shows even where macOS holds
    // notifications back.
    if (mac) {
      const style = kit.segmented([[false, 'macOS notification'], [true, 'Panel at the top of the screen']], settings.banner.panel, panel => { if (settings.banner.panel !== panel) save({ banner: { panel } }); }, 'Banner style');
      for (const choice of style.querySelectorAll('button')) choice.disabled = !settings.banner.on;
      kit.row(options, { label: 'Banner style', description: settings.banner.panel ? 'A small panel under the menu bar, which shows even where macOS holds notifications back.' : 'If banners don’t appear, allow Codeshi in System Settings › Notifications, or choose the panel.', keywords: 'notification panel overlay top of the screen', control: style });
    }
    const slider = node('input', undefined, 'alert-volume'), shown = node('output', `${settings.sound.volume}%`, 'alert-volume-value');
    slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '5'; slider.value = String(settings.sound.volume); slider.disabled = !settings.sound.on;
    slider.setAttribute('aria-label', 'Sound volume'); slider.setAttribute('aria-valuetext', `${settings.sound.volume}%`);
    slider.addEventListener('input', () => { shown.textContent = `${slider.value}%`; });
    slider.addEventListener('change', () => { const value = Number(slider.value); save({ sound: { volume: value } }); lastAt = 0; play('finished', value); });
    kit.row(options, { label: 'Volume', description: 'How loud alert sounds play.', keywords: 'sound loud', control: [slider, shown] });
    kit.toggle(options, { label: 'Play sounds only when Codeshi isn’t in front', description: 'Keep sounds quiet while you’re looking at Codeshi.', keywords: 'sound background focus', checked: settings.sound.background, disabled: !settings.sound.on, onChange: value => save({ sound: { background: value } }) });
    if (mac) {
      const bar = kit.group(host, 'Menu bar');
      kit.toggle(bar, { label: 'Show what agents are doing in the menu bar', description: 'Codeshi’s mark in the menu bar says what needs you and what is running, with a menu for each workspace.', keywords: 'status item tray', checked: settings.statusItem, onChange: value => save({ statusItem: value }) });
    }
    if (!desktop) kit.note(host, 'Banners and the Dock icon are part of the desktop app.');
  }
  window.relayAlerts = {
    play,
    async settings(section, kit) {
      host = section; settingsKit = kit || settingsKit; render();
      try { settings = await api.api('/api/notifications', {}, null); } catch (error) { settings = null; if (settingsKit) { host.replaceChildren(); settingsKit.note(host, error.message || 'Alert settings are unavailable.'); } return; }
      if (host === section) render();
    },
  };
})();
