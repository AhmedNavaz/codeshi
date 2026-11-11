import { sealSolution, validateSolution } from '/format.mjs';

(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const id = location.pathname.match(/^\/r\/([a-f0-9-]{36})$/)?.[1];
  const fragment = new URLSearchParams(location.hash.slice(1));
  let keys = { view: fragment.get('view'), submit: fragment.get('submit') };
  const storageKey = `ai-relay-friend:${id}`;
  if (keys.view) {
    try { sessionStorage.setItem(storageKey, JSON.stringify(keys)); } catch {}
    // Keep capabilities out of copied paths, server logs and later referrers.
    history.replaceState(null, '', location.pathname);
  } else {
    try { keys = JSON.parse(sessionStorage.getItem(storageKey)) || keys; } catch {}
  }
  let request;
  let imported;
  let solutionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const notice = (message, error = false) => { $('notice').textContent = message; $('notice').classList.toggle('error', error); };
  async function api(action = '', { token = keys.view, method = 'GET', value } = {}) {
    const response = await fetch(`/api/requests/${id}${action}`, { method, headers: {
      Authorization: `Bearer ${token}`, ...(value ? { 'Content-Type': 'application/json' } : {}),
    }, ...(value ? { body: JSON.stringify(value) } : {}), redirect: 'error' });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'The sharing request failed.');
    }
    return response;
  }
  function download(value, filename, type = 'application/json') {
    const blob = value instanceof Blob ? value : new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const seal = sealSolution;
  function template() {
    return { schema: 'ai-relay.solution', version: 1, id: solutionId, handoffId: request.package.id,
      createdAt, explanation: '', assumptions: [], verification: [],
      patch: { format: 'ai-relay.text.v1', files: [] } };
  }
  async function solution() {
    const base = imported || template();
    const patch = JSON.parse($('patch').value);
    if (!patch || !['ai-relay.text.v1', 'ai-relay.files.v1'].includes(patch.format) || !Array.isArray(patch.files)) throw new Error('Use the documented exact patch JSON format.');
    if (!$('explanation').value.trim()) throw new Error('Add an explanation before returning a solution.');
    const value = await seal({ ...base, handoffId: request.package.id, explanation: $('explanation').value.trim(),
      assumptions: $('assumptions').value.split('\n').map(s => s.trim()).filter(Boolean),
      verification: $('verification').value.split('\n').map(s => s.trim()).filter(Boolean), patch });
    if (new TextEncoder().encode(JSON.stringify(value)).length > 2 * 1024 * 1024) throw new Error('The solution exceeds 2 MiB.');
    return value;
  }
  function paragraph(title, content) {
    const heading = document.createElement('h3'); heading.textContent = title;
    const text = document.createElement('p'); text.textContent = content || 'None provided.';
    $('context').append(heading, text);
  }
  async function open() {
    if (!id || !keys.view) throw new Error('Open the full private request link supplied by your friend. The view capability is required.');
    request = await (await api()).json();
    const pkg = request.package;
    $('goal').textContent = pkg.goal || 'Friend help request';
    $('expiry').textContent = `Expires ${new Date(request.expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', hour12: true })}. Sharing mode: ${pkg.mode === 'source' ? 'selected source' : 'context only'}.`;
    paragraph('Problem', pkg.problem);
    paragraph('Expected outcome', pkg.expectedOutcome);
    paragraph('Decisions', pkg.decisions.join('\n'));
    paragraph('Unfinished tasks', pkg.tasks.join('\n'));
    for (const message of pkg.messages) {
      const block = document.createElement('article'); block.className = 'message';
      const label = document.createElement('strong'); label.textContent = `${message.role}${message.provider ? ` · ${message.provider}` : ''}`;
      const content = document.createElement('pre'); content.textContent = message.text;
      block.append(label, content); $('messages').append(block);
    }
    $('no-source').hidden = pkg.files.length > 0;
    for (const file of pkg.files) {
      const row = document.createElement('div'); row.className = 'source-file';
      const name = document.createElement('span'); name.textContent = file.encoding ? `${file.path} (binary)` : file.path;
      const button = document.createElement('button'); button.textContent = 'Download source';
      button.onclick = async () => { try { const response = await api(`/source?path=${encodeURIComponent(file.path)}`); download(file.encoding ? await response.blob() : await response.text(), file.path.split('/').at(-1), 'text/plain'); } catch (error) { notice(error.message, true); } };
      row.append(name, button); $('files').append(row);
    }
    $('inventory').textContent = JSON.stringify({ inventory: pkg.inventory, baseline: pkg.baseline }, null, 2);
    $('request').hidden = false;
    $('solution-section').hidden = !keys.submit;
    notice(keys.submit ? 'Private request opened. You can view context and return a solution.' : 'View-only access. A separate submit capability is required to return a solution.');
  }
  $('download-package').onclick = async () => { try { download(await (await api('/package')).json(), 'ai-relay-request.json'); } catch (error) { notice(error.message, true); } };
  $('download-template').onclick = async () => { try { download(await seal(template()), 'ai-relay-solution-template.json'); } catch (error) { notice(error.message, true); } };
  $('download-solution').onclick = async () => { try { download(await solution(), 'ai-relay-solution.json'); } catch (error) { notice(error.message, true); } };
  $('solution-file').onchange = async event => {
    try {
      const file = event.target.files[0]; if (!file) return;
      if (file.size > 2 * 1024 * 1024) throw new Error('The solution file exceeds 2 MiB.');
      const value = validateSolution(JSON.parse(await file.text()), { handoffId: request.package.id });
      if (value.schema !== 'ai-relay.solution' || value.version !== 1 || value.handoffId !== request.package.id
        || typeof value.explanation !== 'string' || !Array.isArray(value.assumptions) || !Array.isArray(value.verification)) {
        throw new Error('This solution is not for the current handoff.');
      }
      if ((await seal(value)).integrity !== value.integrity) throw new Error('Solution integrity does not match.');
      imported = value; solutionId = value.id;
      $('explanation').value = value.explanation; $('assumptions').value = value.assumptions.join('\n');
      $('verification').value = value.verification.join('\n'); $('patch').value = JSON.stringify(value.patch, null, 2);
      notice('Solution imported for review. Submit explicitly when it is ready.');
    } catch (error) { notice(error.message, true); }
  };
  $('solution-form').onsubmit = async event => {
    event.preventDefault(); $('submit').disabled = true;
    try {
      const value = await solution();
      await api('/solutions', { token: keys.submit, method: 'POST', value });
      imported = value; notice('Your solution was received. The owner can retrieve and review it in the original conversation.');
    } catch (error) { notice(error.message, true); }
    finally { $('submit').disabled = false; }
  };
  open().catch(error => notice(error.message, true));
})();
