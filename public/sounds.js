(() => {
  'use strict';
  // Sound alerts. When an agent needs your approval, finishes, or stops, the server tells the page which sound fits
  // and the page plays it. Each sound is a few short tones made with Web Audio, so there are no audio files, and it
  // plays in the desktop app and the browser alike. What plays, and how loud, is chosen in Settings.
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
  const LABELS = [['attention', 'An agent needs your approval or a decision'], ['finished', 'A task finishes'], ['stopped', 'A task stops: an error, a usage limit or failing tests']];
  let context = null, lastAt = 0, host = null, settings = null;

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
    // "Only when Throughline isn't in front" skips sounds while you are looking at it.
    if (alert.background && document.visibilityState !== 'hidden' && document.hasFocus?.()) return;
    if (alert.id && !claim(alert.id)) return;
    play(alert.sound, alert.volume);
  });

  async function save(patch) {
    try { settings = await api.post('/api/notifications', patch, null); }
    catch (error) { api.showNotice?.(error.message || 'Sound settings could not be saved.'); }
    if (host) render();
  }
  function render() {
    host.classList.add('sound-section');
    host.replaceChildren(node('h3', 'Sounds'), node('p', 'Play a short sound when an agent needs you, finishes or stops. Throughline plays it itself, so it works without notification permission, and notification banners stay silent so you never hear two.', 'section-description'));
    if (!settings) { host.append(node('p', 'Loading sound settings…', 'section-description')); return; }
    const check = (text, checked, change, disabled = false) => { const label = node('label', undefined, 'review-check'), box = node('input'); box.type = 'checkbox'; box.checked = checked; box.disabled = disabled; box.addEventListener('change', () => change(box.checked)); label.append(box, node('span', text)); return label; };
    host.append(check('Play sounds', settings.sound, value => save({ sound: value })));
    const options = node('div', undefined, 'sound-options'); options.setAttribute('aria-disabled', String(!settings.sound));
    for (const [name, text] of LABELS) {
      const row = node('div', undefined, 'sound-row'), test = node('button', 'Play', 'text-link sound-play');
      test.type = 'button'; test.setAttribute('aria-label', `Play the sound for: ${text}`); test.addEventListener('click', () => { lastAt = 0; play(name, settings.sounds.volume || 70); });
      row.append(check(text, settings.sounds[name], value => save({ sounds: { [name]: value } }), !settings.sound), test);
      options.append(row);
    }
    const volume = node('label', undefined, 'sound-volume'), slider = node('input'), shown = node('output', `${settings.sounds.volume}%`);
    slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '5'; slider.value = String(settings.sounds.volume); slider.disabled = !settings.sound;
    slider.setAttribute('aria-valuetext', `${settings.sounds.volume}%`);
    slider.addEventListener('input', () => { shown.textContent = `${slider.value}%`; });
    slider.addEventListener('change', () => { const value = Number(slider.value); save({ sounds: { volume: value } }); lastAt = 0; play('finished', value); });
    volume.append(node('span', 'Volume'), slider, shown);
    options.append(volume, check('Only when Throughline isn’t in front', settings.sounds.background, value => save({ sounds: { background: value } }), !settings.sound));
    host.append(options);
  }
  window.relaySounds = {
    play,
    async settings(section) {
      host = section; render();
      try { settings = await api.api('/api/notifications', {}, null); } catch (error) { settings = null; host.replaceChildren(node('h3', 'Sounds'), node('p', error.message || 'Sound settings are unavailable.', 'section-description')); return; }
      if (host === section) render();
    },
  };
})();
