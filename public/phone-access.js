(() => {
  'use strict';
  const node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  let target, kit, signature = '', selectedAddress = '', connection = 'local', checking = false, mutating = false, revision = 0, focusPhone = false;
  const entry = document.getElementById('connect-phone');
  if (entry) {
    entry.addEventListener('click', async () => { focusPhone = true; await window.relaySettings?.open('general'); load(true); });
  }
  function updateEntry(state) {
    if (!entry) return;
    if (state.remote?.devices.some(item => item.state === 'pending')) connection = 'remote';
    const devices = [...state.devices, ...(state.remote?.devices || [])];
    const pending = devices.filter(item => item.state === 'pending').length, active = devices.filter(item => item.state === 'active').length;
    document.getElementById('connect-phone-label').textContent = active ? 'Phone connected' : state.enabled || state.remote?.enabled ? 'Phone access on' : 'Connect phone';
    const count = document.getElementById('connect-phone-count'); count.hidden = !pending; count.textContent = String(pending);
    entry.dataset.connected = String(active > 0);
    entry.title = pending ? `${pending} phone request${pending === 1 ? '' : 's'} waiting for approval` : 'Connect a phone nearby or away from home';
  }
  function revealPhone() { if (focusPhone) { focusPhone = false; requestAnimationFrame(() => target?.isConnected && target.scrollIntoView({ block: 'start' })); } }
  function revealQR(qr, requested) {
    if (!requested) return;
    requestAnimationFrame(() => {
      if (qr.isConnected && document.getElementById('settings')?.open) {
        qr.scrollIntoView({ block: 'center', inline: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      }
    });
  }
  async function load(force = false) {
    if (checking || mutating || document.hidden) return;
    checking = true;
    const request = revision;
    try { const state = await window.relayUI.api('/api/phone'); if (request !== revision) return; updateEntry(state); const next = JSON.stringify(state); if (target?.isConnected && document.getElementById('settings')?.open && (force || next !== signature)) { signature = next; draw(state); } }
    catch (error) { if (!signature && target?.isConnected) { target.replaceChildren(); kit.note(target, error.message || 'Phone access could not be loaded.'); } }
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
    const choice = kit.group(target, 'Phone access', 'See progress, send prompts and answer approvals in your phone browser. Keep the computer awake with Codeshi open.');
    kit.select(choice, { label: 'Connection', options: [['local', 'Same Wi-Fi'], ['remote', 'Away from home']], value: connection, onChange: value => { connection = value; draw(state); } });
    if (connection === 'remote') { drawRemote(state.remote, choice, revealInvite); revealPhone(); return; }
    const rows = choice;
    kit.row(rows, { label: state.enabled ? 'Same-Wi-Fi access is on' : 'Same-Wi-Fi access is off', description: state.enabled ? 'Only paired browsers you approve can access Codeshi. Turning this off disconnects phones using this local connection.' : 'Off by default and after every restart. Use a trusted network: this connection uses unencrypted HTTP.', keywords: 'phone mobile wifi wi-fi local network pairing approval', control: kit.button(state.enabled ? 'Turn off' : 'Enable phone access', () => action(state.enabled ? { action: 'stop' } : { action: 'start', address: selectedAddress || state.interfaces[0]?.address }), state.enabled ? '' : 'primary') });
    if (!state.enabled) {
      if (state.interfaces.length) {
        kit.select(rows, { label: 'Network', description: 'Choose the address reachable from your phone.', options: state.interfaces.map(item => [item.address, `${item.name} · ${item.address}`]), value: selectedAddress || state.interfaces[0].address, onChange: value => { selectedAddress = value; } });
      } else kit.row(rows, { label: 'No private network found', description: 'Connect to Wi-Fi or Ethernet, then close and reopen Settings.' });
      revealPhone(); return;
    }
    if (state.invite?.qr) {
      const qr = node('img', undefined, 'phone-pair-qr'); qr.src = state.invite.qr; qr.alt = 'Scan to open the one-use Codeshi pairing link'; qr.width = 220; qr.height = 220;
      kit.row(rows, { label: 'Scan to connect', description: 'Point your phone camera at this QR code and open the link. Check that the number on your phone appears below, then allow it here. Valid for five minutes, one use.', control: qr }).classList.add('phone-qr-row');
      revealQR(qr, revealInvite);
    }
    kit.row(rows, { label: 'Pair another browser', description: 'Allow local-network access in your firewall if asked. You approve every new browser on this computer.', control: kit.button(state.invite ? 'New QR code' : 'Show QR code', () => action({ action: 'invite' })) });
    if (state.invite) {
      const manual = kit.details(target, 'Can’t scan? Use a code or link'), manualRows = kit.group(manual);
      kit.row(manualRows, { label: 'Open on your phone', description: 'Enter this address in Safari or Chrome, then type the eight-digit code.', control: node('code', state.url, 'phone-network-address') });
      kit.row(manualRows, { label: 'Pairing code', control: node('strong', state.invite.code.replace(/(.{4})/, '$1 '), 'phone-pair-code') });
      const link = node('input', undefined, 'phone-pair-link'); link.readOnly = true; link.value = state.invite.url; link.setAttribute('aria-label', 'One-use pairing link');
      link.addEventListener('click', () => link.select());
      kit.row(manualRows, { label: 'Copy a pairing link', description: 'It still needs approval here.', control: link });
    }
    for (const device of state.devices) {
      const pending = device.state === 'pending';
      kit.row(rows, { label: device.name, description: pending ? `Check ${device.code} on your phone. Allow gives this browser control of all saved workspaces, including prompts, Stop and approvals.` : 'Connected for up to 12 hours, or until you turn off access or quit Codeshi.', control: pending ? [kit.button('Decline', () => action({ action: 'deny', id: device.id })), kit.button('Allow', () => action({ action: 'allow', id: device.id }), 'primary')] : kit.button('Remove device', () => action({ action: 'revoke', id: device.id }), 'danger') });
    }
    kit.note(target, 'Phone browsers show progress while open. Lock-screen notifications and iPhone Live Activities are not included. Some guest Wi-Fi networks block devices from connecting to each other.');
    revealPhone();
  }
  function drawRemote(state, rows, revealInvite) {
    if (!state?.configured) { kit.note(target, state?.error || 'Remote access is not configured in this build. Same Wi-Fi pairing is available.'); return; }
    const manage = input => action({ ...input, connection: 'remote' });
    kit.row(rows, { label: state.enabled ? 'Remote access is on' : 'Remote access is off', description: 'Works over mobile data or another Wi-Fi network. Firebase carries encrypted messages between the paired phone and computer. Access is off after restarting Codeshi.', control: kit.button(state.enabled ? 'Turn off remote access' : 'Enable remote access', () => manage({ action: state.enabled ? 'stop' : 'start' }), state.enabled ? '' : 'primary') });
    if (state.error) kit.note(target, state.error);
    if (!state.enabled) return;
    if (state.invite) {
      const qr = node('img', undefined, 'phone-pair-qr'); qr.src = state.invite.qr; qr.alt = 'Scan to pair a phone for remote access'; qr.width = 220; qr.height = 220;
      kit.row(rows, { label: 'Scan to connect', description: 'Open the link on your phone. Check the number below, then allow the phone. This QR code works once and expires after five minutes.', control: qr }).classList.add('phone-qr-row');
      revealQR(qr, revealInvite);
      const manual = kit.details(target, 'Can’t scan? Copy the link'), link = node('input', undefined, 'phone-pair-link'); link.readOnly = true; link.value = state.invite.url; link.setAttribute('aria-label', 'One-use remote pairing link'); link.addEventListener('click', () => link.select()); manual.append(link);
    }
    kit.row(rows, { label: 'Pair another browser', description: 'Every new browser needs approval here.', control: kit.button(state.invite ? 'New QR code' : 'Show QR code', () => manage({ action: 'invite' })) });
    for (const device of state.devices) {
      const pending = device.state === 'pending';
      kit.row(rows, { label: device.name, description: pending ? `Check ${device.code} on your phone. Allow gives it control of saved workspaces, prompts, Stop and approvals.` : 'Connected for up to 12 hours. Remove it here to disconnect it immediately.', control: pending ? [kit.button('Decline', () => manage({ action: 'deny', id: device.id })), kit.button('Allow', () => manage({ action: 'allow', id: device.id }), 'primary')] : kit.button('Remove device', () => manage({ action: 'revoke', id: device.id }), 'danger') });
    }
    kit.note(target, 'Both devices need internet. Live progress works while the phone page is open; lock-screen notifications are not included. Same Wi-Fi access has its own on/off control.');
  }
  window.relayPhone = { settings(host, settingsKit) {
    target = node('div', undefined, 'settings-section'); host.append(target); kit = settingsKit; signature = '';
    kit.note(target, 'Loading phone access…'); Promise.resolve().then(() => load(true));
  } };
  setInterval(() => load(), 2000); Promise.resolve().then(() => load());
})();
