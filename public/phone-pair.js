(() => {
  'use strict';
  const $ = id => document.getElementById(id), form = $('phone-pair-form'), note = $('phone-pair-status');
  const secret = new URLSearchParams(location.hash.slice(1)).get('pair');
  history.replaceState(null, '', location.pathname);
  // A name the computer's list can tell apart. It's only a label.
  const agent = navigator.userAgent, guess = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android phone' : 'My phone';
  $('phone-name').value = guess;
  function deviceId() {
    try {
      let id = localStorage.getItem('codeshi:phone-device-id');
      if (!id || !/^[a-f0-9]{32}$/.test(id)) {
        id = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('codeshi:phone-device-id', id);
      }
      return id;
    } catch { return undefined; }
  }
  let pending = false, polling = false;
  async function check() {
    if (polling || document.hidden) return;
    polling = true;
    try {
      const response = await fetch('/phone/session'), value = await response.json();
      if (response.ok && value.state === 'active') return location.replace('/');
      if (response.ok && value.state === 'pending') {
        pending = true; form.hidden = true; $('phone-pair-intro').hidden = true; $('phone-pair-wait').hidden = false; $('phone-match-code').textContent = value.code; note.textContent = '';
      } else if (pending) {
        pending = false; form.hidden = false; $('phone-pair-intro').hidden = false; $('phone-pair-wait').hidden = true;
        note.textContent = 'The request expired or was declined. Scan a new code on the computer to try again.';
      } else if (!response.ok && value?.pairedElsewhere && !note.textContent) {
        note.textContent = value.error;
      }
    } catch { if (pending) note.textContent = 'Connection lost. Keep both devices on the same network and Codeshi open.'; }
    finally { polling = false; }
  }
  async function pair(code) {
    const button = form.querySelector('button'); button.disabled = true; note.textContent = 'Connecting…';
    try {
      const response = await fetch('/phone/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: JSON.stringify({ code, name: $('phone-name').value, deviceId: deviceId() }) });
      const value = await response.json(); if (!response.ok) throw Error(value.error);
      $('phone-code').value = ''; note.textContent = '';
      if (value.state === 'active') return location.replace('/');
      await check();
    } catch (error) {
      note.textContent = error.message || 'Could not connect. Try again.';
      form.hidden = false; $('phone-pair-intro').hidden = false;
    } finally { button.disabled = false; }
  }
  form.addEventListener('submit', event => { event.preventDefault(); pair($('phone-code').value.replace(/\s/g, '')); });
  // A scanned code goes straight on to the computer's approval: there's nothing to type, and the computer still has to allow it.
  if (secret) { form.hidden = true; $('phone-pair-intro').hidden = true; pair(secret); }
  setInterval(check, 2000); document.addEventListener('visibilitychange', check);
  if (!secret) check();
})();
