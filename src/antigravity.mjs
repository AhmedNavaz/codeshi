import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiClient } from './acp-client.mjs';
import { commandEnvironment, withBinaryPath } from './resolve-binary.mjs';
import { googleRelay, relayEnvironment } from './google-relay.mjs';

export const isAntigravityACP = bin => /^(?:agy_acp_server(?:\.par|\.exe)?|antigravity-acp)$/i.test(path.basename(bin || ''));
export const antigravityReadOnly = 'Antigravity does not expose a verified read-only mode through this connection. Choose Edit with approvals, or use Codex or Claude for read-only work.';
// Older runtimes without additionalDirectories can still work as a task in one folder.
export const antigravityOneFolder = 'This Antigravity runtime does not support additional workspace folders. Reinstall the Google connection in Settings, run the message as a task in one folder, or choose Codex or Claude for the whole workspace.';
export const antigravityCapabilities = initialized => ({ additionalDirectories: Boolean(initialized.agentCapabilities?.sessionCapabilities?.additionalDirectories) });
export function antigravitySessionParams(initialized, { workspace, workspaces = [] }) {
  const cwd = path.resolve(workspace);
  const additionalDirectories = [...new Set(workspaces.map(folder => path.resolve(folder)))].filter(folder => folder !== cwd);
  if (additionalDirectories.length && !antigravityCapabilities(initialized).additionalDirectories) throw Object.assign(new Error(antigravityOneFolder), { details: { folderChoice: true } });
  return { cwd, mcpServers: [], ...(additionalDirectories.length ? { additionalDirectories } : {}) };
}
export const defaultGoogleRoot = () => path.join(os.homedir(), '.local/share/throughline/google');
export function antigravityInvocation(config) {
  if (config.mode === 'read') throw new Error(antigravityReadOnly);
  const profile = path.join(config.googleRoot || defaultGoogleRoot(), 'profile');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  // The runtime starts the agent's commands without a login shell, so they see only this PATH. An app opened from Finder
  // has a minimal one, without node, gh or anything else the person installed.
  const env = { ...withBinaryPath(config.bin, commandEnvironment()), GEMINI_HOME: profile, ANTIGRAVITY_HARNESS_PATH: path.join(path.dirname(config.bin), process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external') };
  // This connection uses personal Google OAuth. Never fall back to ambient API billing.
  for (const key of Object.keys(env)) if (/^(?:GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GENAI_USE_VERTEXAI|AGY_|ANTIGRAVITY_API)/.test(key)) delete env[key];
  return { args: process.platform === 'linux' ? ['--uid='] : [], env: relayEnvironment(env, config.relay), cleanup() {} };
}
// The runtime copies one of its own skills into the folder it runs in, where it shows as an untracked folder and a commit
// can pick it up. Returns what removes that copy after a run: only if this run added it, only that file, and a folder only
// once nothing else is left in it. A project's own skills folder is never touched.
export function removeRuntimeSkill(workspace) {
  const skills = path.join(workspace, 'skills'), folder = path.join(skills, 'system', 'run-workflow'), file = path.join(folder, 'SKILL.md');
  if (fs.existsSync(file)) return () => {};
  return () => {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (!/^name: run-workflow$/m.test(text) || !/^\s*namespace: system$/m.test(text)) return;
      fs.rmSync(file);
      for (const directory of [folder, path.dirname(folder), skills]) fs.rmdirSync(directory);
    } catch { /* Absent, or a folder that still holds something else. */ }
  };
}
// The relay is a convenience: without it the runtime connects directly, as it would on its own.
export const antigravityRelay = (options, { commands = false } = {}) => options.relay !== undefined ? Promise.resolve(options.relay) : googleRelay({ commands }).catch(() => null);
// The runtime reports a failed Google request as a bare "Internal error"; its log says what actually went wrong.
export function googleConnectionError(error, log) {
  if (!/CCPAConnectionError|Network connection failed|URLError|SSLEOFError|timed out/i.test(log || '')) return error;
  return Object.assign(new Error('Codeshi could not reach Google’s Antigravity service. Check your internet connection, then refresh the Gemini status.'), { category: 'network' });
}
export const initializeAntigravity = client => client.request('initialize', { protocolVersion: 1, clientInfo: { name: 'throughline', version: '0.11.0' }, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } }, 15000);
export function verifyAntigravity(initialized) {
  const version = initialized.agentInfo?.version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (initialized.protocolVersion !== 1 || initialized.agentInfo?.name !== 'antigravity-acp' || !version || +version[1] < 1 || +version[1] === 1 && (+version[2] < 4 || +version[2] === 4 && +version[3] < 5)) throw new Error('Antigravity ACP 1.4.5 or newer is required. Reinstall the Google connection in Settings.');
}
const leaves = options => (options || []).flatMap(option => option.options ? leaves(option.options) : [option]);
export async function configureAntigravitySession(client, session, config) {
  for (const [id, value] of [['mode', 'default'], ...(config.model ? [['model', config.model]] : []), ...(config.effort ? [['thinking_level', config.effort]] : [])]) {
    const option = session.configOptions?.find(option => option.id === id || id === 'thinking_level' && option.id === 'thought_level');
    if (!option || !leaves(option.options).some(entry => entry.value === value)) throw new Error(`Antigravity does not offer the requested ${id}. No prompt was sent.`);
    if (option.currentValue !== value) {
      const result = await client.request('session/set_config_option', { sessionId: session.sessionId, configId: option.id, value });
      session.configOptions = result.configOptions;
    }
    if (session.configOptions?.find(row => row.id === option.id)?.currentValue !== value) throw new Error(`Antigravity did not confirm ${id}. No prompt was sent.`);
  }
}
export function antigravityAccount(session) {
  const tier = session?._meta?.antigravity?.tier;
  return { authenticated: true, authMode: 'google-oauth', billingSource: tier?.id && tier?.name ? 'subscription' : 'unknown', ...(tier?.name ? { planType: String(tier.name).slice(0, 120) } : {}) };
}

const connections = new Map();
export function closeGoogleConnections() { for (const entry of connections.values()) entry.client.close(); connections.clear(); }
export function createGoogleMetadataClient({ bin, googleRoot, relay }, clientFactory) {
  const options = antigravityInvocation({ bin, googleRoot, mode: 'edit', relay });
  const cwd = path.join(options.env.GEMINI_HOME, 'metadata'); fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const client = clientFactory({ bin, cwd, ...options });
  // Metadata and login never grant tool, workspace-trust or question requests.
  client.on('message', message => { if (message.id !== undefined) client.send({ id: message.id, error: { code: -32601, message: 'No tools are permitted during connection setup.' } }); });
  let log = ''; client.on('diagnostic', text => { log = String(text); });
  return { client, cwd, log: () => log };
}
export async function googleMetadata(options, clientFactory = options => new GeminiClient(options)) {
  const { client, cwd, log } = createGoogleMetadataClient({ ...options, relay: await antigravityRelay(options) }, clientFactory);
  try {
    const initialized = await initializeAntigravity(client);
    verifyAntigravity(initialized);
    const capabilities = antigravityCapabilities(initialized);
    try {
      const session = await client.request('session/new', { cwd, mcpServers: [] }, 15000);
      const model = session.configOptions?.find(option => option.id === 'model');
      const effort = session.configOptions?.find(option => ['thinking_level', 'thought_level'].includes(option.id));
      const models = leaves(model?.options).filter(row => typeof row.value === 'string').map(row => ({ id: row.value, model: row.value, displayName: row.name || row.value, description: row.description || '', isDefault: row.value === model.currentValue, supportedReasoningEfforts: leaves(effort?.options).map(row => ({ reasoningEffort: row.value, description: row.name || row.value })) }));
      return { installed: true, available: true, version: initialized.agentInfo.version, ...antigravityAccount(session), models, capabilities, source: 'antigravity-acp', manualSelection: false };
    } catch (error) {
      if (!/authenticat|sign.?in|login/i.test(error.message)) throw googleConnectionError(error, log());
      return { installed: true, available: true, version: initialized.agentInfo.version, authenticated: false, authMode: 'google-oauth', billingSource: 'unknown', models: [], capabilities, source: 'antigravity-acp', manualSelection: false, message: 'Sign in with Google to see the models available to your Antigravity account.' };
    }
  } catch (error) { throw googleConnectionError(error, log()); }
  finally { client.close(); }
}
export async function connectGoogle(options, clientFactory = options => new GeminiClient(options)) {
  const key = options.googleRoot || defaultGoogleRoot();
  const current = connections.get(key); if (current) return { started: true, nativeFlow: true, authUrl: current.url, message: 'Google sign-in is already open. Complete it in your browser, then refresh status.' };
  const { client } = createGoogleMetadataClient({ ...options, relay: await antigravityRelay(options) }, clientFactory);
  try {
    const initialized = await initializeAntigravity(client);
    verifyAntigravity(initialized);
    if (!initialized.authMethods?.some(method => method.id === 'oauth-personal')) throw new Error('This runtime does not offer personal Google sign-in.');
    const entry = { client, url: null }; connections.set(key, entry);
    let urlReady; const firstURL = new Promise(resolve => { urlReady = resolve; });
    client.on('diagnostic', chunk => {
      for (const value of chunk.split(/\r?\n/).slice(0, -1).join('\n').match(/https:\/\/accounts\.google\.com\/[^\s<>"']+/g) || []) { try { const url = new URL(value); if (url.protocol === 'https:' && url.hostname === 'accounts.google.com') { entry.url = url.href; urlReady(); } } catch {} }
    });
    const authentication = client.request('authenticate', { methodId: 'oauth-personal' }, 10 * 60 * 1000);
    let completed = false, failure;
    const done = authentication.then(() => { completed = true; }, error => { failure = error; }).finally(() => { connections.delete(key); client.close(); });
    let timer;
    await Promise.race([done, firstURL, new Promise(resolve => { timer = setTimeout(resolve, 8000); })]); clearTimeout(timer);
    if (failure) throw failure;
    return { started: !completed, nativeFlow: true, ...(entry.url ? { authUrl: entry.url } : {}), message: completed ? 'Google sign-in completed. Refresh status to load your models.' : 'Complete Google sign-in in your browser, then refresh status. Credentials are managed by the official Antigravity runtime.' };
  } catch (error) { client.close(); connections.delete(key); throw error; }
}
export async function disconnectGoogle(options, clientFactory = options => new GeminiClient(options)) {
  const current = connections.get(options.googleRoot || defaultGoogleRoot()); current?.client.close(); connections.delete(options.googleRoot || defaultGoogleRoot());
  const { client } = createGoogleMetadataClient({ ...options, relay: await antigravityRelay(options) }, clientFactory);
  try { const initialized = await initializeAntigravity(client); if (!initialized.agentCapabilities?.auth?.logout) throw new Error('Manage sign-out in the native Antigravity client.'); await client.request('logout'); return { disconnected: true }; }
  finally { client.close(); }
}
