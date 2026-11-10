(() => {
  'use strict';
  const { t, tn } = window.codeshiText;
  const node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  let target, kit, signature = '', selectedAddress = '', connection = 'local', checking = false, mutating = false, revision = 0, focusPhone = false;
  const entry = document.getElementById('connect-phone');
  if (entry) {
    // In Flow the entry opens Flow's own remote-access sheet; otherwise it goes to the section in Settings.
    entry.addEventListener('click', async () => { if (window.relayFlow?.remoteAccess?.() === true) return; focusPhone = true; await window.relaySettings?.open('phone'); load(true); });
  }
  // The section draws only while it can be seen: in Settings, or wherever else hosts it and says so.
  let shown = null;
  const visible = () => Boolean(target?.isConnected) && Boolean(shown ? shown() : document.getElementById('settings')?.open);
  function seenAgo(at) {
    if (!Number.isFinite(at) || at <= 0) return '';
    const seconds = Math.max(1, Math.floor((Date.now() - at) / 1000));
    if (seconds < 60) return t('just now');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('{minutes}m ago', { minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('{hours}h ago', { hours });
    return t('{days}d ago', { days: Math.floor(hours / 24) });
  }
  function deviceDescription(device, durationText) {
    const lead = device.activeNow ? t('Active now') : device.lastSeenAt ? t('Allowed · last seen {time}', { time: seenAgo(device.lastSeenAt) }) : t('Allowed · not open right now');
    return `${lead}${device.notifications ? ' · ' + t('notifications on') : ''} · ${durationText}`;
  }
  function updateEntry(state) {
    if (!entry) return;
    if (state.remote?.devices.some(item => item.state === 'pending')) connection = 'remote';
    const devices = [...state.devices, ...(state.remote?.devices || [])];
    const pending = devices.filter(item => item.state === 'pending').length, active = devices.filter(item => item.state === 'active').length;
    const activeNow = devices.filter(item => item.state === 'active' && item.activeNow).length;
    document.getElementById('connect-phone-label').textContent = state.enabled || state.remote?.enabled ? t('Remote access on') : t('Remote access');
    const count = document.getElementById('connect-phone-count'); count.hidden = !pending; count.textContent = String(pending);
    entry.dataset.connected = String(active > 0);
    entry.title = pending ? tn(pending, '1 pairing request waiting for approval', '{count} pairing requests waiting for approval') : activeNow ? tn(activeNow, '1 paired browser active now', '{count} paired browsers active now') : active ? tn(active, '1 paired browser allowed', '{count} paired browsers allowed') : t('Remote access from your phone or tablet, on the same Wi-Fi or away from home');
  }
  function revealPhone() { if (focusPhone) { focusPhone = false; requestAnimationFrame(() => target?.isConnected && target.scrollIntoView({ block: 'start' })); } }
  function revealQR(qr, requested) {
    if (!requested) return;
    requestAnimationFrame(() => {
      if (qr.isConnected && visible()) {
        qr.scrollIntoView({ block: 'center', inline: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      }
    });
  }
  async function load(force = false) {
    if (checking || mutating || (document.hidden && !force && document.documentElement.dataset.smokeTest !== 'true')) return;
    checking = true;
    const request = revision;
    try { const state = await window.relayUI.api('/api/phone'); if (request !== revision) return; updateEntry(state); const next = JSON.stringify(state); if (visible() && (force || next !== signature)) { signature = next; draw(state); } }
    catch (error) { if (!signature && target?.isConnected) { target.replaceChildren(); kit.note(target, error.message || t('Remote access could not be loaded.')); } }
    finally { checking = false; }
  }
  async function action(input) {
    revision++; mutating = true;
    try { const state = await window.relayUI.post('/api/phone', input); signature = JSON.stringify(state); updateEntry(state); draw(state, input.action === 'start' || input.action === 'invite'); }
    finally { mutating = false; }
  }
  function draw(state, revealInvite = false) {
    if (!target?.isConnected) return;
    if (!state.interfaces.some(item => item.address === selectedAddress)) selectedAddress = state.interfaces[0]?.address || '';
    target.replaceChildren();
    const choice = kit.group(target, t('Remote access'), t('See progress, send prompts and answer approvals in your phone browser. Keep the computer awake with Codeshi open.'));
    kit.select(choice, { label: t('Connection'), options: [['local', t('Same Wi-Fi')], ['remote', t('Away from home')]], value: connection, onChange: value => { connection = value; draw(state); } });
    if (connection === 'remote') { drawRemote(state.remote, choice, revealInvite); revealPhone(); return; }
    const rows = choice;
    kit.row(rows, { label: state.enabled ? t('Same-Wi-Fi access is on') : t('Same-Wi-Fi access is off'), description: state.enabled ? t('Only paired browsers you approve can access Codeshi. Turning this off disconnects phones using this local connection.') : t('Off by default and after every restart. Use a trusted network: this connection uses unencrypted HTTP.'), keywords: 'remote access phone mobile wifi wi-fi local network pairing approval', control: kit.button(state.enabled ? t('Turn off') : t('Enable same-Wi-Fi access'), () => action(state.enabled ? { action: 'stop' } : { action: 'start', address: selectedAddress || state.interfaces[0]?.address }), state.enabled ? '' : 'primary') });
    if (!state.enabled) {
      if (state.interfaces.length) {
        kit.select(rows, { label: t('Network'), description: t('Choose the address reachable from your phone.'), options: state.interfaces.map(item => [item.address, `${item.name} · ${item.address}`]), value: selectedAddress || state.interfaces[0].address, onChange: value => { selectedAddress = value; } });
      } else kit.row(rows, { label: t('No private network found'), description: t('Connect to Wi-Fi or Ethernet, then close and reopen Settings.') });
      revealPhone(); return;
    }
    if (state.invite?.qr) {
      const qr = node('img', undefined, 'phone-pair-qr'); qr.src = state.invite.qr; qr.alt = t('Scan to open the one-use Codeshi pairing link'); qr.width = 220; qr.height = 220;
      kit.row(rows, { label: t('Scan to connect'), description: t('Point your phone camera at this QR code and open the link. Check that the number on your phone appears below, then allow it here. Valid for five minutes, one use.'), control: qr }).classList.add('phone-qr-row');
      revealQR(qr, revealInvite);
    }
    kit.row(rows, { label: t('Pair another browser'), description: t('Allow local-network access in your firewall if asked. You approve every new browser on this computer.'), control: kit.button(state.invite ? t('New QR code') : t('Show QR code'), () => action({ action: 'invite' })) });
    if (state.invite) {
      const manual = kit.details(target, t('Can’t scan? Use a code or link')), manualRows = kit.group(manual);
      kit.row(manualRows, { label: t('Open on your phone'), description: t('Enter this address in Safari or Chrome, then type the eight-digit code.'), control: node('code', state.url, 'phone-network-address') });
      kit.row(manualRows, { label: t('Pairing code'), control: node('strong', state.invite.code.replace(/(.{4})/, '$1 '), 'phone-pair-code') });
      const link = node('input', undefined, 'phone-pair-link'); link.readOnly = true; link.value = state.invite.url; link.setAttribute('aria-label', t('One-use pairing link'));
      link.addEventListener('click', () => link.select());
      kit.row(manualRows, { label: t('Copy a pairing link'), description: t('It still needs approval here.'), control: link });
    }
    for (const device of state.devices) {
      const pending = device.state === 'pending';
      kit.row(rows, { label: device.name, description: pending ? t('Check {code} on your phone. Allow gives this browser control of all saved workspaces, including prompts, Stop and approvals.', { code: device.code }) : deviceDescription(device, t('Connected for up to 12 hours, or until you turn off access or quit Codeshi.')), control: pending ? [kit.button(t('Decline'), () => action({ action: 'deny', id: device.id })), kit.button(t('Allow'), () => action({ action: 'allow', id: device.id }), 'primary')] : kit.button(t('Remove device'), () => action({ action: 'revoke', id: device.id }), 'danger') });
    }
    kit.note(target, t('Phone browsers show progress while open. Each browser on your phone keeps its own pairing; you can move an approved connection to another browser from the Workspaces sheet on the phone.'));
    revealPhone();
  }
  function drawRemote(state, rows, revealInvite) {
    if (!state?.configured) { kit.note(target, state?.error || t('Remote access is not configured in this build. Same Wi-Fi pairing is available.')); return; }
    const manage = input => action({ ...input, connection: 'remote' });
    kit.row(rows, { label: state.enabled ? t('Remote access is on') : t('Remote access is off'), description: t('Works over mobile data or another Wi-Fi network. Firebase carries encrypted messages between the paired phone and computer. Paired browsers stay allowed for up to a week and across Codeshi restarts until you turn this off or remove them.'), control: kit.button(state.enabled ? t('Turn off remote access') : t('Enable remote access'), () => manage({ action: state.enabled ? 'stop' : 'start' }), state.enabled ? '' : 'primary') });
    if (state.error) kit.note(target, state.error);
    if (!state.enabled) return;
    if (state.invite) {
      const qr = node('img', undefined, 'phone-pair-qr'); qr.src = state.invite.qr; qr.alt = t('Scan to pair a phone for remote access'); qr.width = 220; qr.height = 220;
      kit.row(rows, { label: t('Scan to connect'), description: t('Open the link on your phone. Check the number below, then allow the phone. This QR code works once and expires after five minutes.'), control: qr }).classList.add('phone-qr-row');
      revealQR(qr, revealInvite);
      const manual = kit.details(target, t('Can’t scan? Copy the link')), link = node('input', undefined, 'phone-pair-link'); link.readOnly = true; link.value = state.invite.url; link.setAttribute('aria-label', t('One-use remote pairing link')); link.addEventListener('click', () => link.select()); manual.append(link);
    }
    kit.row(rows, { label: t('Pair another browser'), description: t('Every new browser needs approval here, unless moved from an already paired browser on your phone.'), control: kit.button(state.invite ? t('New QR code') : t('Show QR code'), () => manage({ action: 'invite' })) });
    for (const device of state.devices) {
      const pending = device.state === 'pending';
      kit.row(rows, { label: device.name, description: pending ? t('Check {code} on your phone. Allow gives it control of saved workspaces, prompts, Stop and approvals.', { code: device.code }) : deviceDescription(device, t('Connected for up to a week and across restarts. Remove it here to disconnect it immediately.')), control: pending ? [kit.button(t('Decline'), () => manage({ action: 'deny', id: device.id })), kit.button(t('Allow'), () => manage({ action: 'allow', id: device.id }), 'primary')] : kit.button(t('Remove device'), () => manage({ action: 'revoke', id: device.id }), 'danger') });
    }
    kit.note(target, t('Both devices need internet. Live progress works while the phone page is open; lock-screen notifications are not included. Same Wi-Fi access has its own on/off control.'));
  }
  // settings(host, kit, isShown): draw the section into host with the Settings kit. A host other than Settings
  // passes isShown, saying whether the section can be seen, so a closed sheet gets no redraws or scrolling.
  window.relayPhone = { settings(host, settingsKit, isShown = null) {
    target = node('div', undefined, 'settings-section'); host.append(target); kit = settingsKit; shown = isShown; signature = '';
    kit.note(target, t('Loading remote access…')); Promise.resolve().then(() => load(true));
  } };
  setInterval(() => load(), 2000); Promise.resolve().then(() => load());
})();
