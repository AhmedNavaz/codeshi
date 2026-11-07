import { GeminiClient } from './acp-client.mjs';
import { createGoogleMetadataClient, initializeAntigravity, verifyAntigravity, antigravityAccount, antigravityRelay } from './antigravity.mjs';
import { antigravityVersion } from './antigravity-install.mjs';

const unavailable = reason => ({ available: false, source: 'antigravity-acp', windows: [], reason });
function scopesFor(group) {
  const scopes = ['flash', 'argon', 'claude', 'gpt'].filter(model => new RegExp(`\\b${model}\\b`, 'i').test(group));
  if (scopes.length) return scopes;
  if (/\bgemini\b/i.test(group)) return ['gemini'];
  return /^(?:all models|shared(?: quota)?|account)$/i.test(group) ? null : [];
}
export function parseGoogleQuota(report) {
  if (typeof report !== 'string' || report.length > 65536) return unavailable('Google returned an unreadable usage report.');
  const heading = /^### Quota Limits\s*$/m.exec(report);
  if (!heading) return unavailable('Google did not report account quota. Session token counts are separate from plan usage.');
  const windows = []; let group;
  for (const line of report.slice(heading.index + heading[0].length).split('\n')) {
    if (/^###\s/.test(line)) break;
    const groupLine = /^-\s+\*\*([^*]+)\*\*\s*$/.exec(line);
    if (groupLine) { group = groupLine[1].trim(); continue; }
    const bucket = /^\s{2,}-\s+\*\*([^*]+):\*\*\s+(.+)$/.exec(line);
    if (!group || !bucket || windows.length >= 100) continue;
    const title = bucket[1].trim(), value = bucket[2].trim();
    const row = { id: 'google-' + windows.length, label: `${title.replace(/\s+(?:Limit\s+)?Remaining$/i, '').replace(/^Five Hour$/i, '5-hour')} · ${group}`, group, scopes: scopesFor(group), resetsAt: null };
    const percent = /^(\d+(?:\.\d+)?)% remaining(?: \(resets ([^)]+)\))?$/.exec(value);
    const amount = /^([\d,]+) units remaining(?: \(resets ([^)]+)\))?$/.exec(value);
    if (percent && Number(percent[1]) >= 0 && Number(percent[1]) <= 100) row.usedPercent = 100 - Number(percent[1]);
    else if (amount && Number.isSafeInteger(Number(amount[1].replaceAll(',', ''))) && Number(amount[1].replaceAll(',', '')) >= 0) row.remainingAmount = Number(amount[1].replaceAll(',', ''));
    else if (/^Disabled(?:$|:)/.test(value)) { row.disabled = true; row.statusDescription = value.replace(/^Disabled:?\s*/, '').slice(0, 500); }
    else if (value === 'Available') row.status = 'Available';
    else continue;
    const reset = percent?.[2] || amount?.[2];
    if (reset) { const parsed = Date.parse(reset); if (Number.isFinite(parsed)) row.resetsAt = new Date(parsed).toISOString(); }
    windows.push(row);
  }
  return windows.length ? { available: true, source: 'antigravity-acp', windows } : unavailable('Google has not reported quota for this account. Check Models & Quota in Antigravity.');
}

export async function googleQuota(options, clientFactory = options => new GeminiClient(options)) {
  const { client, cwd } = createGoogleMetadataClient({ ...options, relay: await antigravityRelay(options) }, clientFactory);
  let sessionId, report = '', unsupported = false;
  client.on('message', message => {
    const p = message.params || {};
    if (message.id !== undefined) { unsupported = true; return; }
    if (message.method !== 'session/update' || p.sessionId !== sessionId) return;
    const update = p.update || {};
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      report += update.content.text;
      if (report.length > 65536) client.fail(new Error('Google usage report exceeded its size limit.'));
    }
    if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) unsupported = true;
  });
  try {
    const initialized = await initializeAntigravity(client); verifyAntigravity(initialized);
    // The pinned runtime intercepts this exact built-in command before the LLM
    // and hooks. Never fall back to asking a model to estimate account usage.
    if (initialized.agentInfo.version !== antigravityVersion) return unavailable('Usage is not verified for this Antigravity runtime version. Check Models & Quota in Antigravity.');
    const session = await client.request('session/new', { cwd, mcpServers: [] }, 15000); sessionId = session.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) return unavailable('Google did not open a usage session.');
    const result = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/usage' }] }, 15000);
    if (result.stopReason !== 'end_turn' || unsupported) return unavailable('Google could not complete its usage report.');
    return { ...parseGoogleQuota(report), plan: antigravityAccount(session).planType || null, defaultModel: session.configOptions?.find(option => option.id === 'model')?.currentValue || null };
  } catch (error) {
    return unavailable(/authenticat|sign.?in|login/i.test(error.message) ? 'Sign in with Google through this connection to read its quota.' : 'Google usage could not be read. Refresh or check Models & Quota in Antigravity.');
  } finally { client.close(); }
}
