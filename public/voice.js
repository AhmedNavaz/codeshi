(() => {
  'use strict';
  // Voice mode (#11). Push to talk: the microphone button or ⌥⌘V starts listening, and again stops it. What you say
  // appears in the message box as it is heard, for you to review and send; "Send when I stop talking" sends it after
  // a three-second countdown that Esc cancels. When a run you started by voice finishes, its reply is read aloud as
  // written, without code or tables, in the system's own voice; that costs no agent usage. Speech is recognized on this Mac by Codeshi Speech; audio never leaves it.
  //
  // Conversation mode (#72) works hands-free, and belongs to Flow: the arrow beside the microphone there switches between
  // it and dictation. Outside Flow the microphone always dictates. The microphone stays on until you end it: saying "send" as the last word,
  // then pausing, sends the message, and so can a pause alone if chosen. While a run works, what you send goes into it
  // (as Add to run does) or joins the queue. A listening session is limited to two minutes, so a new one starts
  // whenever one ends. Listening pauses while Codeshi speaks, so it never hears itself, and a short sound says when it
  // listens again. An approval is read out and can be answered by voice, but approving needs "yes, approve" after
  // "approve"; a question from the agent pauses listening until it is answered on screen.
  const $ = id => document.getElementById(id), api = window.relayUI;
  const button = $('voice-input'), status = $('voice-status'), input = $('message-input');
  if (!api || !button || !status || !input) return;
  const KEY = 'throughline:voice', COUNTDOWN = 3, PAUSE = 1000, PAUSE_SEND = 2000, GAP = 700;
  const modeButton = $('voice-mode'), modeMenu = $('voice-menu'), shell = $('app-shell');
  const defaults = { sendAfter: false, readAloud: 'voice', voice: '', rate: 1, mode: 'dictation', pauseSend: false, whileWorking: 'add' };
  const mac = /Mac/.test(globalThis.navigator?.platform || '') || window.relayDesktop?.platform === 'darwin';
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const load = () => { try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...defaults }; } };
  // talk is conversation mode while it is on: the approval being answered by voice, if any, and why listening is paused.
  let prefs = load(), support = null, session = null, countdown = null, speaking = false, voiceDraft = false, awaitingRun = false, settingsHost = null, settingsKit = null, talk = null;
  // Starting a session waits for the one before it to finish starting, since the server listens to one at a time.
  let starting = Promise.resolve();
  const voiceRuns = new Set();
  const save = patch => { prefs = { ...prefs, ...patch }; try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* A preference for this device only. */ } };
  const shortcut = mac ? '⌥⌘V' : 'Ctrl+Alt+V';
  // Conversation is a Flow mode: the choice is kept, and applies while Flow is on.
  const flowing = () => Boolean(shell?.classList.contains('flow'));
  const handsFree = () => prefs.mode === 'conversation' && flowing();

  // The status line above the message box: what voice is doing, and how to stop it.
  function show(text, actions = [], state = '') {
    status.hidden = !text; status.dataset.state = state;
    $('voice-status-text').textContent = text || '';
    // Where speech goes matters most while the microphone is on. It sits inside the status, so a screen reader hears it too.
    if ($('voice-status-where')) $('voice-status-where').hidden = state !== 'listening';
    $('voice-status-actions').replaceChildren(...actions.map(([label, handler]) => { const action = node('button', label, 'text-link'); action.type = 'button'; action.addEventListener('click', handler); return action; }));
  }
  function render() {
    const listening = Boolean(session) || Boolean(talk);
    button.hidden = !support?.supported;
    button.setAttribute('aria-pressed', String(listening));
    button.dataset.state = session?.state || (talk ? 'paused' : '');
    button.title = talk ? `End the voice conversation (${shortcut})` : listening ? `Stop listening (${shortcut})` : handsFree() ? `Start a voice conversation (${shortcut})` : `Voice input (${shortcut})`;
    document.getElementById('composer')?.classList.toggle('listening', listening);
    button.dataset.mode = handsFree() ? 'conversation' : 'dictation';
    if (modeButton) { modeButton.hidden = !support?.supported || !flowing(); if (modeButton.hidden) modeMenu?.hidePopover?.(); }
    renderMenu();
    if (settingsHost?.isConnected) renderSettings(settingsHost);
  }
  // Text in the message box: the draft from before, then what was heard. In a conversation the draft is read when the
  // first words arrive, not when listening starts, because sending can take a moment to empty the message box.
  function write(text) {
    if (session.kind === 'answer') return;
    if (session.base === null) session.base = input.value && !/\s$/.test(input.value) ? input.value + ' ' : input.value;
    input.value = session.base + text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.setSelectionRange?.(input.value.length, input.value.length);
  }
  // What the status says while listening: how to stop it and, in a conversation, where "send" puts the message.
  function listening() {
    if (!talk) { show(`Listening… ${shortcut} or the microphone to stop, Esc to cancel`, [['Stop', stop]], 'listening'); return; }
    if (session?.kind === 'answer') { show(talk.step === 'confirm' ? 'Say “yes, approve” to confirm' : 'Say “approve” or “deny”, or answer on screen', [['End', endConversation]], 'listening'); return; }
    const steer = $('steer-button'), running = api.isRunning?.(), adds = running && prefs.whileWorking !== 'queue' && steer && !steer.hidden;
    show(`Conversation · say “send” to ${running ? adds ? 'add it to this run' : 'queue it' : 'send'}, “stop listening” or Esc to end`, [['End', endConversation]], 'listening');
  }

  // kind is "draft" for words that go into the message box, or "answer" for a spoken answer to an approval.
  async function start(kind = 'draft') {
    if (session || !support?.supported) return;
    if (!talk) { stopSpeaking(); cancelCountdown(); }
    const lazy = Boolean(talk), base = lazy ? null : input.value && !/\s$/.test(input.value) ? input.value + ' ' : input.value;
    const mine = session = { id: null, kind, original: input.value, base, text: '', state: 'starting', startedAt: Date.now() };
    render();
    show(support.helper === 'ready' ? 'Starting…' : 'Preparing voice input… The first time, Codeshi builds its speech helper.', [['Cancel', talk ? endConversation : cancel]], 'starting');
    const before = starting; let done; starting = new Promise(resolve => { done = resolve; });
    try {
      await before;
      if (session !== mine) return;
      const started = await api.post('/api/voice/start', {}, null);
      if (session !== mine) { await api.post('/api/voice/cancel', { id: started.id }, null).catch(() => {}); return; }
      mine.id = started.id; support = { ...support, helper: 'ready' };
      const token = window.relayDesktop?.token;
      const stream = new EventSource(`/api/voice/stream?id=${encodeURIComponent(started.id)}${token ? `&token=${encodeURIComponent(token)}` : ''}`);
      mine.stream = stream;
      const current = mine;
      stream.addEventListener('ready', () => { if (session !== current) return; current.state = 'listening'; render(); listening(); });
      stream.addEventListener('level', event => button.style.setProperty('--level', String(JSON.parse(event.data).value)));
      stream.addEventListener('partial', event => {
        if (session !== current) return;
        const text = JSON.parse(event.data).text;
        // Silence with nothing new is not a reason to drop what was heard.
        if (!String(text).trim() && current.text) return;
        carry(current, text);
        current.text = text; current.heardAt = Date.now(); write(text); if (talk) quiet(current);
      });
      stream.addEventListener('final', event => { if (session === current) finish(JSON.parse(event.data).text); });
      stream.addEventListener('error', event => {
        if (session !== current) return;
        const data = event.data ? JSON.parse(event.data) : null;
        if (!data) { if (stream.readyState === 2) finish(current.text); return; }
        if (data.code === 'cancelled') return;
        end(); if (talk) endConversation(); show(data.message, [['Dismiss', () => show('')]], 'error');
      });
    } catch (error) { if (session === mine) { end(); if (talk) endConversation(); show(error.message, [['Dismiss', () => show('')]], 'error'); } }
    finally { done(); }
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
  function end() { if (session) clearTimeout(session.quiet); session?.stream?.close(); session = null; button.style.removeProperty('--level'); render(); }
  // Stops listening and keeps what is in the message box: used when the message is sent, or Codeshi is about to speak.
  function drop() {
    if (!session) return;
    const { id } = session;
    if (id) api.post('/api/voice/cancel', { id }, null).catch(() => {});
    end();
  }
  // After a pause the recognizer may start again from nothing, sending only the new words. What was heard before then
  // stays in the message box and the new words follow it. A restart looks like this: the text begins with another
  // word after a pause, or it suddenly has far fewer words than before. A correction keeps about as many.
  const count = text => String(text).trim().split(/\s+/).filter(Boolean).length;
  function restarted(before, text, gap) {
    if (!before.trim() || !String(text).trim()) return false;
    const was = count(before), now = count(text);
    if (firstWord(text) !== firstWord(before)) return (gap >= GAP && now <= was) || (was >= 3 && now < was);
    return was >= 3 && now * 2 <= was;
  }
  function carry(current, text) {
    if (current.kind !== 'draft' || current.base === null || !restarted(current.text, text, Date.now() - current.heardAt)) return;
    current.base += current.text.trim() + ' '; current.carried = true;
  }
  function finish(text) {
    let heard = String(text || '').trim();
    // The last words stay if the recognizer ends with nothing, or with only its newest part.
    if (!heard) heard = session.text.trim(); else carry(session, heard);
    session.text = heard;
    if (talk) { finishTalking(heard); return; }
    const carried = session.carried;
    write(heard); end();
    if (!heard && !carried) { show('Nothing was heard. Try again a little closer to the microphone.', [['Dismiss', () => show('')]], 'error'); return; }
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

  // Conversation mode (#72).
  // "send" and "stop listening" are commands only as the last words before a pause, so "send the email after login"
  // stays part of the message.
  const SEND = /(?:^|[\s,.;:!?–—-])send[.!?]*\s*$/i, STOP = /(?:^|[\s,.;:!?–—-])stop listening[.!?]*\s*$/i;
  const without = (text, command) => text.replace(command, '').replace(/[\s,;:–—-]+$/, '');
  const firstWord = text => (String(text).toLowerCase().match(/[\p{L}\p{N}']+/u) || [''])[0];
  function beginConversation() {
    if (talk || !support?.supported || !flowing()) return;
    stopSpeaking(); cancelCountdown();
    talk = { waiting: null, step: null, paused: null, announced: new Set(), note: '' };
    render(); chime();
    watch();
    if (!session && !speaking && !talk.paused) start(talk.waiting ? 'answer' : 'draft');
  }
  // Ending keeps what is in the message box; anything already sent stays sent.
  function endConversation() {
    if (!talk) return;
    talk = null; drop(); stopSpeaking(); render(); show('');
  }
  // Listens again unless something else is happening: Codeshi is speaking, or a question waits on screen.
  function listenAgain() { if (talk && !session && !speaking && !talk.paused) start(talk.waiting ? 'answer' : 'draft'); }
  function resume() { if (!talk || session || speaking) return; if (talk.paused) { paused(); return; } chime(); listenAgain(); }
  function paused() { show('Answer the question on screen. Listening starts again after.', [['End', endConversation]], 'paused'); }
  // Codeshi speaks with the microphone off, then listens again.
  function say(text, label, options = {}) {
    drop();
    const onEnd = () => Promise.resolve().then(resume);
    if (!speak(text, label, { ...options, onEnd })) resume();
  }
  // A pause after words: a command at the end acts, and "Send after a pause" sends what was said.
  function quiet(current) {
    clearTimeout(current.quiet);
    current.quiet = setTimeout(() => {
      if (session !== current || !talk) return;
      const text = current.text;
      if (current.kind === 'answer') { drop(); answer(text); return; }
      if (STOP.test(text)) { write(without(text, STOP)); endConversation(); return; }
      if (SEND.test(text)) { write(without(text, SEND)); deliver(); return; }
      if (prefs.pauseSend && text.trim()) current.quiet = setTimeout(() => { if (session === current && current.text === text) deliver(); }, PAUSE_SEND - PAUSE);
    }, PAUSE);
  }
  // A session ended on its own: the two-minute limit, or the recognizer finishing. Its words stay, and listening goes on.
  function finishTalking(heard) {
    const kind = session.kind;
    // A helper that keeps ending at once with nothing heard is not listening; three in a row end the conversation.
    talk.empty = !heard && Date.now() - session.startedAt < 5000 ? (talk.empty || 0) + 1 : 0;
    if (talk.empty >= 3) { end(); endConversation(); show('Voice stopped because nothing was being heard. Check the microphone, then try again.', [['Dismiss', () => show('')]], 'error'); return; }
    if (kind === 'answer') { end(); if (heard) answer(heard); else listenAgain(); return; }
    if (STOP.test(heard)) { write(without(heard, STOP)); end(); endConversation(); return; }
    if (SEND.test(heard)) { write(without(heard, SEND)); end(); deliver(); return; }
    if (heard) write(heard);
    end(); listenAgain();
  }
  // Sends the message box: into the running task when the agent takes additions and that is chosen, otherwise as a
  // new message, which joins the queue while a run works.
  function deliver() {
    drop();
    if (input.value.trim()) {
      const steer = $('steer-button');
      if (prefs.whileWorking !== 'queue' && steer && !steer.hidden && !steer.disabled) steer.click();
      else { voiceDraft = true; const form = $('composer'); if (form?.requestSubmit) form.requestSubmit(); else form?.dispatchEvent(new Event('submit', { cancelable: true })); }
    }
    listenAgain();
  }

  // Approvals are read out and can be answered by voice. "approve" alone never approves: Codeshi asks again, and only
  // "yes, approve" does. "deny" denies at once. An approval answered on screen ends the spoken one. Questions from the
  // agent are answered on screen; listening waits for them.
  const target = item => item.input?.file_path || item.input?.path;
  function request(item) {
    const who = agentNames[item.provider] || 'The agent', command = item.command || item.input?.command, file = target(item);
    const what = command ? `wants to run ${String(command).replace(/\s+/g, ' ').trim().slice(0, 160)}` : item.connector ? `wants to use ${item.connector}`
      : item.kind === 'item/permissions/requestApproval' ? 'wants more access' : file ? `wants to change ${String(file).split('/').pop()}` : item.kind?.includes('fileChange') ? 'wants to change files' : 'needs your permission';
    return `${who} ${what}.`;
  }
  function watch() {
    if (!talk) return;
    const c = api.getState().conversation, pending = c?.pendingApprovals || [];
    if (talk.waiting && !pending.some(item => item.id === talk.waiting.id)) {
      talk.waiting = null; talk.step = null;
      if (session?.kind === 'answer') drop();
      if (speaking) stopSpeaking(); else resume();
    }
    const question = pending.find(item => item.kind === 'question');
    if (question && !talk.paused) { talk.paused = 'question'; say(`${agentNames[question.provider] || 'The agent'} has a question. Answer it on screen.`, 'Reading aloud'); return; }
    const answered = !question && talk.paused; if (answered) talk.paused = null;
    if (talk.paused || talk.waiting) { if (session?.state === 'listening') listening(); return; }
    const item = pending.find(next => next.kind !== 'question' && !talk.announced.has(next.id));
    if (item) {
      talk.announced.add(item.id);
      talk.waiting = { id: item.id, runId: item.runId, conversationId: c.id }; talk.step = 'ask';
      const note = talk.note; talk.note = '';
      say(`${note ? `${note} ` : ''}${request(item)} Say approve or deny.`, 'Reading the request aloud');
      return;
    }
    if (talk.note && !speaking) { const note = talk.note; talk.note = ''; say(note, 'Reading aloud'); return; }
    if (answered) resume();
    else if (session?.state === 'listening') listening();
  }
  function answer(text) {
    const waiting = talk?.waiting; if (!waiting) return;
    const said = String(text || '').toLowerCase().trim();
    if (!said) { listenAgain(); return; }
    if (talk.step === 'confirm') {
      if (/\byes\W+(?:i\W+)?(?:approve|allow)\b/.test(said)) { reply(waiting, true); return; }
      talk.step = 'ask'; say('Not approved. Say approve or deny.', 'Reading aloud'); return;
    }
    if (/\b(?:deny|reject|refuse)\b/.test(said) || /^(?:no|nope)[.!]?$/.test(said)) { reply(waiting, false); return; }
    if (/\b(?:approve|allow)\b/.test(said)) { talk.step = 'confirm'; say('To approve, say yes, approve.', 'Reading aloud'); return; }
    say('Say approve or deny, or answer on screen.', 'Reading aloud');
  }
  async function reply(waiting, allow) {
    talk.waiting = null; talk.step = null;
    const c = api.getState().conversation;
    // Only the request that was read out, and only while it still waits.
    if (c?.id !== waiting.conversationId || !(c.pendingApprovals || []).some(item => item.id === waiting.id)) { resume(); return; }
    try { await api.post(`/api/conversations/${waiting.conversationId}/approval`, { runId: waiting.runId, approvalId: waiting.id, allow }); }
    catch (error) { api.showNotice?.(error.message || 'This action could not be completed. Please try again.'); if (talk) say('That answer didn’t go through. Answer it on screen.', 'Reading aloud'); return; }
    if (talk) talk.note = allow ? 'Approved.' : 'Denied.';
    await api.refresh?.();
    watch();
  }

  // A short rising tone: listening again.
  let audio = null;
  function chime() {
    const Context = window.AudioContext || window.webkitAudioContext; if (!Context) return;
    try {
      audio ||= new Context();
      if (audio.state === 'suspended') audio.resume?.().catch?.(() => {});
      const now = audio.currentTime;
      [660, 880].forEach((pitch, index) => {
        const at = now + index * 0.09, tone = audio.createOscillator(), gain = audio.createGain();
        tone.frequency.value = pitch;
        gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
        tone.connect(gain).connect(audio.destination); tone.start(at); tone.stop(at + 0.18);
      });
    } catch { /* No sound, then; the status still says it listens. */ }
  }

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
  function speakable(text, limit = 320, brief = true) {
    const plain = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, '').replace(/^\s*\|?\s*[-:]{3,}.*$/gm, ' ').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
    if (!brief) return plain;
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

  // What is read when a run finishes: the reply as written, a paragraph at a time, and nothing else. Code blocks and
  // tables are left out, since they do not read well. A run that stopped early, or left no reply, gets the short
  // summary instead, so there is still something to hear.
  function replyAloud(run, messages) {
    const reply = run.status === 'complete' ? [...messages].reverse().find(message => message.role === 'assistant' && message.text) : null;
    const parts = reply ? String(reply.text).replace(/```[\s\S]*?(?:```|$)/g, '\n\n').replace(/^\s*\|.*$/gm, '').split(/\n\s*\n/).map(part => speakable(part, Infinity, false)).filter(Boolean) : [];
    return parts.length ? parts : [summarize(run, reply ? messages.filter(message => message !== reply) : messages)];
  }

  const synth = () => window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function' ? window.speechSynthesis : null;
  // Speaks one text, or several in turn. With several, onPart says which is being read, so the page can follow along, and
  // gets null when reading ends or is stopped (#103). Stopping cancels the rest, whose ends then mean nothing.
  let reading = 0, finishReading = null;
  // onEnd runs when reading ends or is stopped. It returns false when there is nothing to read or no voice to read it.
  function speak(text, label = 'Reading the summary aloud', { onPart = null, onEnd = null } = {}) {
    const speech = synth(), parts = (Array.isArray(text) ? text : [text]).filter(Boolean); if (!speech || !parts.length) return false;
    finishReading?.();
    speech.cancel();
    const turn = ++reading, voice = speech.getVoices?.().find(item => item.voiceURI === prefs.voice);
    const finish = () => { if (finishReading !== finish) return; finishReading = null; speaking = false; if (status.dataset.state === 'speaking') show(''); onPart?.(null); onEnd?.(); };
    finishReading = finish;
    speaking = true; show(label, [['Stop', stopSpeaking]], 'speaking');
    parts.forEach((part, index) => {
      const utterance = new window.SpeechSynthesisUtterance(part);
      if (voice) utterance.voice = voice;
      utterance.rate = Number(prefs.rate) || 1;
      utterance.onstart = () => { if (turn === reading) onPart?.(index); };
      utterance.onend = () => { if (turn === reading && index === parts.length - 1) finish(); };
      utterance.onerror = () => { if (turn === reading) finish(); };
      speech.speak(utterance);
    });
    return true;
  }
  function stopSpeaking() { if (!speaking) return; finishReading?.(); reading++; synth()?.cancel(); }

  // A message sent from a voice draft marks the run it starts; that run's summary is read aloud when it finishes.
  // The message box may already be empty here: sending clears it at once. An emptied voice draft has voiceDraft off already.
  $('composer')?.addEventListener('submit', () => { if (voiceDraft) awaitingRun = true; voiceDraft = false; cancelCountdown(); if (status.dataset.state === 'countdown') show(''); }, true);
  input.addEventListener('input', event => { if (!input.value.trim()) voiceDraft = false; if (countdown !== null && event.isTrusted) { cancelCountdown(); show(''); } });
  let runningId = null, announced = null;
  window.addEventListener('relay-state', () => {
    const c = api.getState().conversation;
    const active = c?.status === 'running' ? c.activeRun : null;
    if (active?.id && active.id !== runningId) { runningId = active.id; if (awaitingRun) { voiceRuns.add(active.id); awaitingRun = false; } return; }
    const run = c?.lastRun;
    if (active || !run?.id || run.id !== runningId || announced === run.id) return;
    announced = run.id; runningId = null;
    // In a conversation the summary is read with the microphone off, then listening starts again with a sound.
    if (prefs.readAloud === 'never' || (prefs.readAloud === 'voice' && !voiceRuns.has(run.id))) { if (talk && !speaking) chime(); return; }
    const reply = replyAloud(run, (c.messages || []).filter(message => message.runId === run.id));
    if (talk) say(reply, 'Reading the reply aloud'); else speak(reply, 'Reading the reply aloud');
  });

  // Approvals and questions in a conversation, and where "send" goes now.
  window.addEventListener('relay-state', watch);

  // The microphone and ⌥⌘V: in a conversation they end it; otherwise they start one, or dictation, as chosen.
  const toggle = () => {
    if (talk) endConversation();
    else if (session) { if (session.state === 'starting') cancel(); else stop(); }
    else if (handsFree()) beginConversation();
    else start();
  };
  button.addEventListener('click', toggle);

  // The arrow beside the microphone in Flow: dictation or conversation, without opening Settings.
  const MODES = [['dictation', 'Dictation', 'Speak, then send it yourself'], ['conversation', 'Conversation', 'Hands-free: say “send” to send']];
  function setMode(mode) {
    if (mode === prefs.mode) return;
    // The microphone stops with the mode it was started in.
    if (talk) endConversation(); else if (session) stop();
    save({ mode }); render();
  }
  function renderMenu() {
    if (!modeMenu) return;
    const chosen = prefs.mode === 'conversation' ? 'conversation' : 'dictation';
    const items = MODES.map(([mode, label, hint]) => {
      const item = node('button', undefined, 'voice-menu-item'); item.type = 'button'; item.setAttribute('role', 'menuitemradio'); item.setAttribute('aria-checked', String(mode === chosen)); item.dataset.mode = mode;
      item.append(node('span', label, 'voice-menu-label'), node('span', hint, 'voice-menu-hint'));
      item.addEventListener('click', () => { modeMenu.hidePopover?.(); setMode(mode); });
      return item;
    });
    const settings = node('button', 'Voice settings…', 'voice-menu-item voice-menu-settings'); settings.type = 'button'; settings.setAttribute('role', 'menuitem');
    settings.addEventListener('click', () => { modeMenu.hidePopover?.(); window.relaySettings?.open('voice'); });
    modeMenu.replaceChildren(...items, settings);
    if (modeButton) modeButton.title = `Voice mode: ${chosen === 'conversation' ? 'Conversation' : 'Dictation'}`;
  }
  // Leaving Flow ends a conversation; what is in the message box stays.
  window.addEventListener('relay-flow', () => { if (talk && !flowing()) endConversation(); render(); });
  document.addEventListener('keydown', event => {
    if (event.code === 'KeyV' && event.altKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.shiftKey) { if (support?.supported) { event.preventDefault(); toggle(); } return; }
    if (event.key !== 'Escape') return;
    if (talk) { event.preventDefault(); endConversation(); }
    else if (session) { event.preventDefault(); cancel(); }
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
  // The Voice page of Settings: speaking a message, and reading summaries aloud. Settings lends the kit its rows are
  // built with (settings.js).
  function renderSettings(host, kit = settingsKit) {
    settingsHost = host; settingsKit = kit;
    if (!kit) return;
    host.replaceChildren();
    if (support?.supported) {
      const input = kit.group(host, 'Voice input', `Speak a message with ${shortcut} or the microphone in the message box. Speech is recognized on this Mac by Codeshi Speech and the audio never leaves it; what you say appears in the message box for you to review.`);
      const denied = [support.speech, support.microphone].includes('denied');
      kit.row(input, { label: 'Permissions', description: permissions(support) + (denied ? ' To allow it, open System Settings › Privacy & Security, then Speech Recognition and Microphone, and turn on Codeshi Speech.' : ''), keywords: 'microphone speech recognition privacy' });
      kit.select(input, { label: 'Mode', description: prefs.mode === 'conversation' ? `Hands-free, in Flow: ${shortcut} starts a conversation that keeps listening until you say “stop listening”, press Esc or click the microphone. Say “send” at the end to send. Listening pauses while Codeshi speaks. Outside Flow the microphone dictates.` : 'What you say goes into the message box, and you send it. In Flow, the arrow beside the microphone also changes this.', keywords: 'voice dictation conversation hands-free', options: [['dictation', 'Dictation'], ['conversation', 'Conversation']], value: prefs.mode === 'conversation' ? 'conversation' : 'dictation', onChange: value => { save({ mode: value }); render(); } });
      if (prefs.mode === 'conversation') {
        kit.toggle(input, { label: 'Send after a pause', description: 'Sends after 2 seconds of silence, without saying “send”.', keywords: 'voice conversation automatic send silence', checked: prefs.pauseSend, onChange: value => save({ pauseSend: value }) });
        kit.select(input, { label: 'While the agent works', description: 'Where a message you send by voice goes during a run. Approvals are read out; say “approve”, then “yes, approve”, or “deny”.', keywords: 'voice conversation queue add to run approvals', options: [['add', 'Add it to the run when the agent allows, otherwise queue'], ['queue', 'Queue it for after the run']], value: prefs.whileWorking === 'queue' ? 'queue' : 'add', onChange: value => save({ whileWorking: value }) });
      } else kit.toggle(input, { label: 'Send when I stop talking', description: 'After a 3-second countdown, which Esc cancels.', keywords: 'voice dictation automatic send', checked: prefs.sendAfter, onChange: value => save({ sendAfter: value }) });
    } else kit.note(host, 'Voice input is available on macOS for now. Replies can still be read aloud when a run finishes.');
    const aloud = kit.group(host, 'Reading aloud');
    kit.select(aloud, { label: 'Read the reply aloud', description: 'When a run finishes, its reply is read as written, without code or tables.', keywords: 'speech speak voice summary reply response', options: [['voice', 'After runs I started by voice'], ['always', 'After every run'], ['never', 'Never']], value: prefs.readAloud, onChange: value => save({ readAloud: value }) });
    if (!synth()) return;
    const voices = synth().getVoices?.() || [], language = (globalThis.navigator?.language || 'en').split('-')[0];
    const options = [['', 'System voice'], ...[...voices].sort((a, b) => Number(b.lang.startsWith(language)) - Number(a.lang.startsWith(language)) || a.name.localeCompare(b.name)).map(voice => [voice.voiceURI, `${voice.name} (${voice.lang})`])];
    kit.select(aloud, { label: 'Voice', description: 'The voice that reads replies and recaps.', keywords: 'speech speak', options, value: voices.some(voice => voice.voiceURI === prefs.voice) ? prefs.voice : '', onChange: value => save({ voice: value }) });
    kit.row(aloud, { label: 'Hear it', description: 'A sample reply in the chosen voice.', keywords: 'voice test sample', control: kit.button('Play a sample', () => speak('The checkout now applies promo codes. I changed checkout.js and promo.js, and the tests pass.')) });
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
    settings: (host, kit) => { renderSettings(host, kit); refreshSupport(); },
    summarize, replyAloud,
    // Other parts of the page read aloud through here, so a conversation's microphone pauses for them too.
    speak: (text, label, options) => { if (talk) say(text, label, options); else speak(text, label, options); },
    conversation: () => Boolean(talk),
  };
})();
