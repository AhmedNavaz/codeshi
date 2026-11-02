(() => {
  'use strict';
  // Voice mode (#11). Push to talk: the microphone button or ⌥⌘V starts listening, and again stops it. What you say
  // appears in the message box as it is heard, for you to review and send; "Send when I stop talking" sends it after
  // a three-second countdown that Esc cancels. When a run you started by voice finishes, a short summary is read
  // aloud. It is built here from the run's recorded steps and reply, so it costs no agent usage, and spoken with the
  // system's own voice. Speech is recognized on this Mac by Throughline Speech; audio never leaves it.
  const $ = id => document.getElementById(id), api = window.relayUI;
  const button = $('voice-input'), status = $('voice-status'), input = $('message-input');
  if (!api || !button || !status || !input) return;
  const KEY = 'throughline:voice', COUNTDOWN = 3;
  const defaults = { sendAfter: false, readAloud: 'voice', voice: '', rate: 1 };
  const mac = /Mac/.test(globalThis.navigator?.platform || '') || window.relayDesktop?.platform === 'darwin';
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const load = () => { try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...defaults }; } };
  let prefs = load(), support = null, session = null, countdown = null, speaking = false, voiceDraft = false, awaitingRun = false, settingsHost = null;
  const voiceRuns = new Set();
  const save = patch => { prefs = { ...prefs, ...patch }; try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* A preference for this device only. */ } };
  const shortcut = mac ? '⌥⌘V' : 'Ctrl+Alt+V';

  // The status line above the message box: what voice is doing, and how to stop it.
  function show(text, actions = [], state = '') {
    status.hidden = !text; status.dataset.state = state;
    $('voice-status-text').textContent = text || '';
    $('voice-status-actions').replaceChildren(...actions.map(([label, handler]) => { const action = node('button', label, 'text-link'); action.type = 'button'; action.addEventListener('click', handler); return action; }));
  }
  function render() {
    const listening = Boolean(session);
    button.hidden = !support?.supported;
    button.setAttribute('aria-pressed', String(listening));
    button.dataset.state = session?.state || '';
    button.title = listening ? `Stop listening (${shortcut})` : `Voice input (${shortcut})`;
    document.getElementById('composer')?.classList.toggle('listening', listening);
    if (settingsHost?.isConnected) renderSettings(settingsHost);
  }
  // Text in the message box: the draft from before, then what was heard.
  function write(text) {
    input.value = session.base + text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.setSelectionRange?.(input.value.length, input.value.length);
  }

  async function start() {
    if (session || !support?.supported) return;
    stopSpeaking(); cancelCountdown();
    const base = input.value && !/\s$/.test(input.value) ? input.value + ' ' : input.value;
    session = { id: null, original: input.value, base, text: '', state: 'starting' };
    render();
    show(support.helper === 'ready' ? 'Starting…' : 'Preparing voice input… The first time, Throughline builds its speech helper.', [['Cancel', cancel]], 'starting');
    try {
      const started = await api.post('/api/voice/start', {}, null);
      if (!session) { api.post('/api/voice/cancel', { id: started.id }, null).catch(() => {}); return; }
      session.id = started.id; support = { ...support, helper: 'ready' };
      const token = window.relayDesktop?.token;
      const stream = new EventSource(`/api/voice/stream?id=${encodeURIComponent(started.id)}${token ? `&token=${encodeURIComponent(token)}` : ''}`);
      session.stream = stream;
      const current = session;
      stream.addEventListener('ready', () => { if (session !== current) return; current.state = 'listening'; render(); show(`Listening… ${shortcut} or the microphone to stop, Esc to cancel`, [['Stop', stop]], 'listening'); });
      stream.addEventListener('level', event => button.style.setProperty('--level', String(JSON.parse(event.data).value)));
      stream.addEventListener('partial', event => { if (session !== current) return; current.text = JSON.parse(event.data).text; write(current.text); });
      stream.addEventListener('final', event => { if (session === current) finish(JSON.parse(event.data).text); });
      stream.addEventListener('error', event => {
        if (session !== current) return;
        const data = event.data ? JSON.parse(event.data) : null;
        if (!data) { if (stream.readyState === 2) finish(current.text); return; }
        if (data.code === 'cancelled') return;
        end(); show(data.message, [['Dismiss', () => show('')]], 'error');
      });
    } catch (error) { end(); show(error.message, [['Dismiss', () => show('')]], 'error'); }
  }
  function stop() {
    if (!session) return;
    if (!session.id) { cancel(); return; }
    session.state = 'stopping'; render(); show('Finishing…', [], 'stopping');
    api.post('/api/voice/stop', { id: session.id }, null).catch(() => {});
  }
  function cancel() {
    if (!session) return;
    const { id, original } = session;
    if (id) api.post('/api/voice/cancel', { id }, null).catch(() => {});
    input.value = original; input.dispatchEvent(new Event('input', { bubbles: true }));
    end(); show('');
  }
  function end() { session?.stream?.close(); session = null; button.style.removeProperty('--level'); render(); }
  function finish(text) {
    const heard = String(text || '').trim();
    write(heard); end();
    if (!heard) { show('Nothing was heard. Try again a little closer to the microphone.', [['Dismiss', () => show('')]], 'error'); return; }
    voiceDraft = true; input.focus();
    if (prefs.sendAfter) startCountdown(); else show('');
  }

  // "Send when I stop talking": a short countdown, so a mistaken request can still be stopped.
  function startCountdown() {
    let left = COUNTDOWN;
    const tick = () => {
      if (left === 0) { cancelCountdown(); show(''); const form = $('composer'); if (form?.requestSubmit) form.requestSubmit(); else form?.dispatchEvent(new Event('submit', { cancelable: true })); return; }
      show(`Sending in ${left}… Esc to cancel`, [['Send now', () => { left = 0; tick(); }], ['Cancel', () => { cancelCountdown(); show(''); }]], 'countdown');
      left--; countdown = setTimeout(tick, 1000);
    };
    tick();
  }
  function cancelCountdown() { if (countdown !== null) { clearTimeout(countdown); countdown = null; } }

  // A summary of a finished run, read aloud. Built from what the run recorded: no agent call, no usage.
  const agentNames = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  function spokenDuration(ms) {
    const seconds = Math.round(ms / 1000);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const minutes = Math.floor(seconds / 60), rest = seconds % 60;
    return minutes ? `${plural(minutes, 'minute')}${rest ? ` ${plural(rest, 'second')}` : ''}` : plural(rest, 'second');
  }
  const join = items => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  // Reply text as it would be said: code, links and Markdown marks left out, the first sentence or two.
  function speakable(text, limit = 320) {
    const plain = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, '').replace(/^\s*\|?\s*[-:]{3,}.*$/gm, ' ').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
    let said = '';
    // A sentence ends at a stop followed by a space, so file names such as theme.js stay whole.
    for (const sentence of plain.split(/(?<=[.!?])\s+/).filter(Boolean)) {
      const next = `${said} ${sentence.trim()}`.trim();
      if (said && next.length > limit) break;
      said = next;
      if (said.length >= 140) break;
    }
    return said.length > limit ? said.slice(0, limit).replace(/\s+\S*$/, '') + '…' : said;
  }
  function summarize(run, messages, describe = api.describeActivity) {
    const agent = run.connection === 'local' ? 'The local model' : agentNames[run.provider] || 'The agent';
    const files = new Set(); let commands = 0, tests = false;
    for (const message of messages) {
      if (message.role !== 'activity' || !describe) continue;
      const step = describe(message.text);
      for (const file of step.paths || []) files.add(file.split('/').pop());
      if (['Edit', 'MultiEdit', 'Write', 'edit_file', 'write_file'].includes(step.toolName) && (step.input?.file_path || step.input?.path)) files.add(String(step.input.file_path || step.input.path).split('/').pop());
      if (step.kind === 'command' || step.toolName === 'Bash') { commands++; if (/\b(?:test|tests|jest|vitest|pytest|mocha|rspec|go test|cargo test)\b/.test(step.cmd || step.input?.command || step.detail || '')) tests = true; }
    }
    const elapsed = run.elapsedMs ?? Date.parse(run.endedAt) - Date.parse(run.startedAt), time = spokenDuration(elapsed);
    const parts = [run.status === 'complete' ? `${agent} finished${time ? ` in ${time}` : ''}.` : run.errorCategory === 'quota' ? `${agent} stopped at a usage limit.` : `${agent} stopped before finishing.`];
    const names = [...files], did = [];
    if (names.length) did.push(names.length <= 3 ? `changed ${join(names)}` : `changed ${names.length} files, including ${join(names.slice(0, 2))}`);
    if (tests) did.push('ran the tests'); else if (commands) did.push(`ran ${commands === 1 ? 'a command' : plural(commands, 'command')}`);
    if (did.length) parts.push(`It ${did.join(did.some(item => item.includes(' and ')) ? ', and ' : ' and ')}.`);
    const reply = [...messages].reverse().find(message => message.role === 'assistant' && message.text);
    const said = reply ? speakable(reply.text) : '';
    if (said) parts.push(said);
    return parts.join(' ');
  }

  const synth = () => window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function' ? window.speechSynthesis : null;
  function speak(text, label = 'Reading the summary aloud') {
    const speech = synth(); if (!speech || !text) return;
    speech.cancel();
    const utterance = new window.SpeechSynthesisUtterance(text);
    const voice = speech.getVoices?.().find(item => item.voiceURI === prefs.voice);
    if (voice) utterance.voice = voice;
    utterance.rate = Number(prefs.rate) || 1;
    utterance.onend = utterance.onerror = () => { speaking = false; if (status.dataset.state === 'speaking') show(''); };
    speaking = true; show(label, [['Stop', stopSpeaking]], 'speaking');
    speech.speak(utterance);
  }
  function stopSpeaking() { if (!speaking) return; speaking = false; synth()?.cancel(); if (status.dataset.state === 'speaking') show(''); }

  // A message sent from a voice draft marks the run it starts; that run's summary is read aloud when it finishes.
  $('composer')?.addEventListener('submit', () => { if (voiceDraft && input.value.trim()) awaitingRun = true; voiceDraft = false; cancelCountdown(); if (status.dataset.state === 'countdown') show(''); }, true);
  input.addEventListener('input', event => { if (!input.value.trim()) voiceDraft = false; if (countdown !== null && event.isTrusted) { cancelCountdown(); show(''); } });
  let runningId = null, announced = null;
  window.addEventListener('relay-state', () => {
    const c = api.getState().conversation;
    const active = c?.status === 'running' ? c.activeRun : null;
    if (active?.id && active.id !== runningId) { runningId = active.id; if (awaitingRun) { voiceRuns.add(active.id); awaitingRun = false; } return; }
    const run = c?.lastRun;
    if (active || !run?.id || run.id !== runningId || announced === run.id) return;
    announced = run.id; runningId = null;
    if (prefs.readAloud === 'never' || (prefs.readAloud === 'voice' && !voiceRuns.has(run.id))) return;
    speak(summarize(run, (c.messages || []).filter(message => message.runId === run.id)));
  });

  const toggle = () => { if (session) { if (session.state === 'starting') cancel(); else stop(); } else start(); };
  button.addEventListener('click', toggle);
  document.addEventListener('keydown', event => {
    if (event.code === 'KeyV' && event.altKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.shiftKey) { if (support?.supported) { event.preventDefault(); toggle(); } return; }
    if (event.key !== 'Escape') return;
    if (session) { event.preventDefault(); cancel(); }
    else if (countdown !== null) { event.preventDefault(); cancelCountdown(); show(''); }
    else if (speaking) { event.preventDefault(); stopSpeaking(); }
  });

  // The Voice part of Settings.
  // What macOS currently allows, in one sentence.
  function permissions(info) {
    if (info.helper !== 'ready') return 'The speech helper is prepared the first time you use voice input.';
    if (info.error) return info.error;
    const both = [info.speech, info.microphone];
    let text = both.every(value => value === 'authorized') ? 'Speech recognition and the microphone are allowed.'
      : both.every(value => value === 'not-determined') ? 'macOS asks for the microphone and speech recognition the first time you speak.'
      : `Speech recognition is ${info.speech === 'authorized' ? 'allowed' : info.speech === 'not-determined' ? 'not asked yet' : 'not allowed'}, and the microphone is ${info.microphone === 'authorized' ? 'allowed' : info.microphone === 'not-determined' ? 'not asked yet' : 'not allowed'}.`;
    if (info.onDevice === false) text += ' On-device recognition isn’t installed for this language; turn on Dictation for it in System Settings › Keyboard.';
    return text;
  }
  function renderSettings(host) {
    settingsHost = host;
    host.replaceChildren(node('h3', 'Voice'));
    if (support?.supported) {
      host.append(node('p', `Speak a message with ${shortcut} or the microphone in the message box. Speech is recognized on this Mac by Throughline Speech; the audio never leaves it. What you say appears in the message box for you to review.`, 'section-description'));
      host.append(node('p', permissions(support), 'section-description voice-facts'));
      if ([support.speech, support.microphone].includes('denied')) host.append(node('p', 'To allow it, open System Settings › Privacy & Security, then Speech Recognition and Microphone, and turn on Throughline Speech.', 'section-description'));
      const check = node('label', undefined, 'review-check'), box = node('input');
      box.type = 'checkbox'; box.checked = prefs.sendAfter; box.addEventListener('change', () => save({ sendAfter: box.checked }));
      check.append(box, document.createTextNode('Send when I stop talking, after a 3-second countdown that Esc cancels'));
      host.append(check);
    } else host.append(node('p', 'Voice input is available on macOS for now. Summaries of finished runs can still be read aloud.', 'section-description'));
    const field = (text, control) => { const label = node('label', undefined, 'voice-field'); label.append(node('span', text), control); host.append(label); return control; };
    const read = node('select');
    for (const [value, text] of [['voice', 'After runs I started by voice'], ['always', 'After every run'], ['never', 'Never']]) { const option = node('option', text); option.value = value; read.append(option); }
    read.value = prefs.readAloud; read.addEventListener('change', () => save({ readAloud: read.value }));
    field('Read a summary aloud', read);
    const voices = synth()?.getVoices?.() || [], picker = node('select'), automatic = node('option', 'System voice'); automatic.value = ''; picker.append(automatic);
    const language = (globalThis.navigator?.language || 'en').split('-')[0];
    for (const voice of [...voices].sort((a, b) => Number(b.lang.startsWith(language)) - Number(a.lang.startsWith(language)) || a.name.localeCompare(b.name))) { const option = node('option', `${voice.name} (${voice.lang})`); option.value = voice.voiceURI; picker.append(option); }
    picker.value = voices.some(voice => voice.voiceURI === prefs.voice) ? prefs.voice : ''; picker.addEventListener('change', () => save({ voice: picker.value }));
    if (synth()) {
      field('Voice', picker);
      const test = node('button', 'Play a sample', 'secondary-button'); test.type = 'button';
      test.addEventListener('click', () => speak('Claude finished in 1 minute 40 seconds. It changed checkout.js and promo.js, and ran the tests. The checkout now applies promo codes.'));
      const actions = node('div', undefined, 'workbench-actions'); actions.append(test); host.append(actions);
    }
  }
  synth()?.addEventListener?.('voiceschanged', () => { if (settingsHost?.isConnected) renderSettings(settingsHost); });

  async function refreshSupport() {
    try { support = await api.api('/api/voice', {}, null); } catch { support = { supported: false }; }
    render();
  }
  refreshSupport();
  window.relayVoice = {
    toggle: () => { if (!support?.supported) return false; toggle(); return true; },
    available: () => Boolean(support?.supported),
    settings: host => { renderSettings(host); refreshSupport(); },
    summarize, speak,
  };
})();
