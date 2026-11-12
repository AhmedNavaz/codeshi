(() => {
  'use strict';
  // Alerts. When an agent needs you, finishes or stops while you are in another app, Codeshi can show a banner,
  // play a sound, bounce the Dock icon, count it on the Dock icon and notify a paired phone. Settings › Alerts shows
  // one card for each of those three moments, with a chip for each way, and Try it shows the real thing: the page
  // plays the sound and the desktop app shows the banner and the Dock (src/alerts.mjs keeps the rules). Above them,
  // live status: the menu bar item and the pill under it, which say what agents are doing without announcing it.
  // Each sound is a few short tones made with Web Audio, so there are no audio files, and it plays in the desktop app
  // and the browser alike.
  const api = window.relayUI;
  if (!api) return;
  const { t } = window.codeshiText;
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
  // The three moments, most important first: its name, what it covers, and a phrase for each chip's label.
  const MOMENTS = [
    ['attention', t('Needs you'), t('An approval, a question or a handoff offer'), t('an agent needs you')],
    ['finished', t('Finished'), t('A task is done, or continues by itself after a usage limit'), t('a task finishes')],
    ['stopped', t('Stopped'), t('An error, a usage limit or failing tests'), t('a task stops')],
  ];
  let context = null, lastAt = 0, host = null, settings = null, settingsKit = null, tried = null, cards = 0;

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

  // The ways that apply here, as chips: [channel, name, what it does]. Banners and the Dock icon belong to the desktop
  // app; other systems flash the taskbar button instead of bouncing an icon and have no badge. In a browser, only
  // sounds apply here. A paired phone's lock screen (#23) applies everywhere, as the server sends it.
  function ways(preferences = settings) {
    const desktop = window.relayDesktop, platform = desktop ? desktop.platform || 'darwin' : null, mac = platform === 'darwin', panel = Boolean(preferences?.banner?.panel);
    return { mac, platform, desktop: Boolean(desktop), rows: [
      ...desktop ? [['banner', mac && panel ? t('Panel') : t('Banner'), mac && panel ? t('A small panel under the menu bar for a few seconds') : t('A notification in the corner of the screen')]] : [],
      ['sound', t('Sound'), t('A short tone, different for each moment')],
      ...desktop ? [['bounce', mac ? t('Dock bounce') : t('Taskbar flash'), mac ? t('The Dock icon jumps once to catch your eye') : t('The taskbar button lights up until you come back')]] : [],
      ...mac ? [['badge', t('Dock badge'), t('A count on the Dock icon until you come back')]] : [],
      ['phone', t('Phone'), t('On the lock screen of a phone connected Away from home, once it turns notifications on')],
    ] };
  }
  // Whether a way tells you about one moment. A way that is off keeps its choices for each moment, so both count.
  const active = (preferences, channel, moment) => Boolean(preferences?.[channel]?.on && preferences[channel][moment]);
  // A chip turned on for one moment while its way is off turns the way on for that moment only, so nothing else
  // starts alerting you; turned off, it leaves the way's other moments alone.
  function chipPatch(preferences, channel, moment) {
    const way = preferences[channel];
    if (active(preferences, channel, moment)) return { [channel]: { [moment]: false } };
    if (way.on) return { [channel]: { [moment]: true } };
    return { [channel]: { on: true, ...Object.fromEntries(MOMENTS.map(([name]) => [name, name === moment])) } };
  }

  // Try it: the sound here, and the real banner or panel, Dock badge and bounce from the desktop app. Says what
  // happened, in sentences, so nothing is left to guess, including when macOS refuses the banner.
  async function tryMoment(moment, preferences) {
    const lines = [], { mac } = ways(preferences);
    if (active(preferences, 'sound', moment) && preferences.sound.volume > 0) { lastAt = 0; play(moment, preferences.sound.volume); lines.push(t('The sound played.')); }
    else if (active(preferences, 'sound', moment)) lines.push(t('The sound is on, but the volume is at 0.'));
    let shown = null;
    if (window.relayDesktop?.tryAlert) { try { shown = await window.relayDesktop.tryAlert(moment); } catch { shown = null; } }
    if (shown?.panel) lines.push(t('The panel showed under the menu bar.'));
    if (shown?.banner === 'shown') lines.push(t('The banner showed in the corner of the screen.'));
    if (shown?.banner === 'sent') lines.push(t('The banner was sent. If it didn’t appear, allow Codeshi in System Settings › Notifications, or choose the panel below.'));
    if (shown?.banner === 'refused') lines.push(mac ? t('macOS didn’t show the banner. Allow Codeshi in System Settings › Notifications, or choose the panel below.') : t('The system didn’t show the banner. Check that notifications are allowed for Codeshi.'));
    if (shown?.badge) lines.push(t('The Dock icon shows a 1 for a few seconds.'));
    if (shown?.bounce === 'now') lines.push(mac ? t('The Dock icon bounced.') : t('The taskbar button lit up.'));
    if (shown?.bounce === 'when-away') lines.push(mac ? t('Switch to another app in the next few seconds to see the Dock icon bounce. It only bounces while you’re elsewhere.') : t('Switch to another app in the next few seconds to see the taskbar button light up.'));
    if (active(preferences, 'phone', moment)) lines.push(t('A connected phone gets it for real alerts only, not for Try it.'));
    if (!lines.length) lines.push(t('Nothing is on for this moment.'));
    return lines;
  }

  // One moment as a card: its name and what it covers, a chip for each way, and Try it. Settings › Alerts shows all
  // three; the setup guide shows Needs you alone. `save` takes a patch and resolves with the saved settings.
  function momentCard(moment, preferences, { save, only = null, onTried = () => {}, lastTry = null } = {}) {
    const [, name, covers] = MOMENTS.find(([key]) => key === moment), card = node('div', undefined, 'alert-moment');
    card.dataset.moment = moment;
    const head = node('div', undefined, 'alert-moment-head'), title = node('div', undefined, 'alert-moment-title');
    const dot = node('span', undefined, 'alert-moment-dot'); dot.setAttribute('aria-hidden', 'true');
    const heading = node('span', name, 'alert-moment-name'); heading.id = `alert-moment-${moment}-${++cards}`;
    title.append(dot, heading, node('span', covers, 'alert-moment-covers'));
    const rows = ways(preferences).rows.filter(([channel]) => preferences[channel] && (!only || only.includes(channel)));
    // A phone gets real alerts only, so Try it needs a way it can show here.
    const any = rows.some(([channel]) => channel !== 'phone' && active(preferences, channel, moment));
    const tryButton = node('button', t('Try it'), 'settings-button alert-try'); tryButton.type = 'button'; tryButton.disabled = !any;
    tryButton.title = any ? t('See and hear what you get for this moment') : t('Nothing to try here: turn on a way other than Phone');
    const result = node('p', undefined, 'alert-try-result'); result.setAttribute('role', 'status');
    if (lastTry?.moment === moment) result.textContent = lastTry.lines.join(' ');
    tryButton.addEventListener('click', async () => { tryButton.disabled = true; try { const lines = await tryMoment(moment, preferences); result.textContent = lines.join(' '); onTried({ moment, lines }); } finally { tryButton.disabled = false; } });
    head.append(title, tryButton);
    const chips = node('div', undefined, 'alert-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-labelledby', heading.id);
    for (const [channel, label, what] of rows) {
      const on = active(preferences, channel, moment), chip = node('button', undefined, 'alert-chip'); chip.type = 'button';
      chip.dataset.channel = channel; chip.setAttribute('aria-pressed', String(on)); chip.title = what;
      const check = node('span', undefined, 'alert-chip-check'); check.setAttribute('aria-hidden', 'true');
      chip.append(check, node('span', label));
      chip.addEventListener('click', async () => {
        chip.disabled = true;
        const next = await save(chipPatch(preferences, channel, moment));
        // Turning the sound on plays it, so you know what it is straight away.
        if (channel === 'sound' && !on && next?.sound?.volume > 0) { lastAt = 0; play(moment, next.sound.volume); }
      });
      chips.append(chip);
    }
    card.append(head, chips);
    // Needs you is the one that matters most; without a sound it's easy to miss while you aren't looking.
    if (moment === 'attention' && preferences.sound && !active(preferences, 'sound', moment)) card.append(node('p', t('Tip: turn on Sound so you hear it even when you’re not looking at the screen.'), 'alert-moment-tip'));
    card.append(result);
    return card;
  }

  // A switch on its own, for rows that also have a button.
  function switchBox(checked, label, change) {
    const box = node('input', undefined, 'settings-switch'); box.type = 'checkbox'; box.setAttribute('role', 'switch'); box.checked = Boolean(checked);
    box.setAttribute('aria-label', label); box.addEventListener('change', () => change(box.checked));
    return box;
  }
  // Show the pill: the real pill under the menu bar for a few seconds, with an example line.
  async function showPill() { try { return Boolean(await window.relayDesktop?.tryPill?.()); } catch { return false; } }

  async function save(patch) {
    try { settings = await api.post('/api/notifications', patch, null); tried = null; }
    catch (error) { api.showNotice?.(error.message || t('Alert settings could not be saved.')); }
    if (host) render();
    return settings;
  }

  // The Alerts page of Settings, drawn with the kit Settings lends (settings.js): live status, the three moments,
  // then the options for banners and sounds.
  function render() {
    const kit = settingsKit;
    if (!kit) return;
    host.replaceChildren();
    if (!settings) { kit.note(host, t('Loading alert settings…')); return; }
    const { mac, platform, desktop } = ways();

    // Live status: quiet, always up to date, nothing to answer. The menu bar item and the pill read the same status.
    if (mac) {
      const live = kit.group(host, t('While agents work'), t('See what agents are doing without opening Codeshi. These stay quiet: no sound, no bouncing. For the moments that need you, see below.'));
      kit.toggle(live, { label: t('Status in the menu bar'), description: t('Codeshi’s mark in the menu bar, with what agents are doing beside it and a dot when something needs you. Click it for a menu of your workspaces.'), keywords: 'status item tray menu bar icon', checked: settings.statusItem, onChange: value => save({ statusItem: value }) });
      // A server from before the pill existed doesn't send it.
      if (typeof settings.progressPill === 'boolean') {
        const preview = node('button', t('Show the pill'), 'settings-button'); preview.type = 'button';
        preview.addEventListener('click', async () => { preview.disabled = true; await showPill(); setTimeout(() => { preview.disabled = false; }, 1500); });
        kit.row(live, { label: t('Pill under the menu bar'), description: t('While you’re in another app and agents work, a small pill says what they’re doing, such as “Codex · Editing”. It goes when the work ends or you come back. Its × hides it until you’ve been back to Codeshi.'), keywords: 'progress pill live status running working panel top of the screen', control: [preview, switchBox(settings.progressPill, t('Pill under the menu bar'), value => save({ progressPill: value }))] });
      }
    } else if (platform === 'win32') {
      const live = kit.group(host, t('While agents work'));
      kit.toggle(live, { label: t('Show Codeshi in the notification area'), description: t('Codeshi’s mark beside the clock gets a dot when something needs you. Point at it to read what is happening, click it to open Codeshi, or right-click for a menu of your workspaces.'), keywords: 'status item tray taskbar system tray icon', checked: settings.statusItem, onChange: value => save({ statusItem: value }) });
    }

    const moments = kit.group(host, t('When something happens'), t('Codeshi lets you know when an agent needs you, finishes or stops while you’re in another app. Pick the ways for each moment, then use Try it to see and hear exactly what you’ll get.'));
    for (const [moment] of MOMENTS) {
      const row = node('div', undefined, 'settings-row alert-moment-row');
      row.dataset.keywords = 'ways to alert you banner notification sound bounce dock badge phone lock screen push needs you finished stopped approval question try';
      row.append(momentCard(moment, settings, { save, lastTry: tried, onTried: value => { tried = value; } }));
      moments.append(row);
    }

    const options = kit.group(host, desktop ? t('Banners and sounds') : t('Sounds'));
    // A banner is a macOS notification, or a panel under the menu bar, which shows even where macOS holds them back.
    if (mac) {
      const style = kit.segmented([[false, t('macOS notification')], [true, t('Panel under the menu bar')]], settings.banner.panel, panel => { if (settings.banner.panel !== panel) save({ banner: { panel } }); }, t('Banner style'));
      kit.row(options, { label: t('Banner style'), description: settings.banner.panel ? t('A small panel under the menu bar, where the pill shows. It appears even where macOS holds notifications back, such as in Focus.') : t('In the corner of the screen, like other apps. If banners don’t appear, allow Codeshi in System Settings › Notifications, or choose the panel.'), keywords: 'notification panel overlay top of the screen', control: style });
    }
    const slider = node('input', undefined, 'alert-volume'), shown = node('output', `${settings.sound.volume}%`, 'alert-volume-value');
    slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '5'; slider.value = String(settings.sound.volume);
    slider.setAttribute('aria-label', t('Sound volume')); slider.setAttribute('aria-valuetext', `${settings.sound.volume}%`);
    slider.addEventListener('input', () => { shown.textContent = `${slider.value}%`; });
    slider.addEventListener('change', () => { const value = Number(slider.value); save({ sound: { volume: value } }); lastAt = 0; play('attention', value); });
    kit.row(options, { label: t('Volume'), description: t('How loud alert sounds play. You hear the Needs you sound when you let go.'), keywords: 'sound loud', control: [slider, shown] });
    kit.toggle(options, { label: t('Play sounds only when Codeshi isn’t in front'), description: t('Banners and the Dock only come while you’re in another app. Sounds play either way unless this is on.'), keywords: 'sound background focus', checked: settings.sound.background, onChange: value => save({ sound: { background: value } }) });
    kit.note(host, t('Phone: on the lock screen of a phone connected Away from home, once you turn on Notifications at the bottom of its workspace list. It says only what happened and in which workspace.'));
    if (!desktop) kit.note(host, t('Banners and the Dock icon are part of the desktop app.'));
  }
  window.relayAlerts = {
    play, ways, active, chipPatch, momentCard, showPill,
    async settings(section, kit) {
      host = section; settingsKit = kit || settingsKit; tried = null; render();
      try { settings = await api.api('/api/notifications', {}, null); } catch (error) { settings = null; if (settingsKit) { host.replaceChildren(); settingsKit.note(host, error.message || t('Alert settings are unavailable.')); } return; }
      if (host === section) render();
    },
  };
})();
