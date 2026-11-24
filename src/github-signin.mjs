import fs from 'node:fs';
import path from 'node:path';

// Sign in with GitHub for people without the gh CLI (#159). GitHub's device flow with the public client ID of Codeshi's
// GitHub App (Contents: read only). There is no client secret and no callback. The token lives in an encrypted vault
// (Electron safeStorage, backed by the system keychain) and never in Codeshi's data files. It is used only when gh isn't
// signed in to github.com, and Sign out deletes it.

// Public by design: a GitHub App's client ID is not a secret.
export const CLIENT_ID = 'Iv23lidncZnsYwMQAdLy';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const API_URL = 'https://api.github.com';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_MARGIN = 5 * 60 * 1000;
const MIN_INTERVAL = 5;

// The vault keeps one encrypted record. Without safeStorage (a headless run), sign-in is unavailable.
export function encryptedVault({ file, safeStorage }) {
  const usable = () => { try { return Boolean(safeStorage?.isEncryptionAvailable?.()); } catch { return false; } };
  return {
    available: usable,
    read() {
      if (!usable() || !fs.existsSync(file)) return null;
      try { return safeStorage.decryptString(fs.readFileSync(file)); } catch { return null; }
    },
    write(text) {
      if (!usable()) throw Object.assign(new Error('Secure storage is unavailable on this computer, so GitHub sign-in can\'t keep your sign-in.'), { status: 400 });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, safeStorage.encryptString(text), { mode: 0o600 });
      fs.renameSync(temporary, file);
    },
    clear() { try { fs.rmSync(file, { force: true }); } catch { /* Left for the person. */ } },
  };
}

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';

export function createGitHubSignIn({ vault = null, clientId = CLIENT_ID, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let pending = null; // { deviceCode, userCode, verificationUri, interval, expiresAt, nextPollAt }
  let denied = false, expired = false;

  const available = () => Boolean(vault) && (vault.available?.() ?? true);
  const readRecord = () => {
    if (!available()) return null;
    try {
      const record = JSON.parse(vault.read() || 'null');
      return record && typeof record.accessToken === 'string' && record.accessToken ? record : null;
    } catch { return null; }
  };
  const saveRecord = record => vault.write(JSON.stringify(record));
  const forget = () => { pending = null; denied = false; expired = false; vault?.clear?.(); };

  // A form POST to GitHub's sign-in endpoints. Only the client ID and the step's own fields are sent.
  async function form(url, fields) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Codeshi' },
      body: new URLSearchParams({ client_id: clientId, ...fields }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok && !data?.error) fail(`GitHub didn't answer the sign-in request (HTTP ${response.status}). Try again in a moment.`, 502);
    return data || {};
  }
  async function login(token) {
    const response = await fetchImpl(`${API_URL}/user`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'Codeshi', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const who = await response.json().catch(() => null);
    return text(who?.login, 100) || null;
  }
  // Stores a token response with its expiry. GitHub App user tokens expire after a few hours and come with a refresh token.
  function store(data, previous = {}) {
    const issued = now();
    const record = {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : previous.refreshToken || null,
      expiresAt: Number.isFinite(data.expires_in) ? issued + data.expires_in * 1000 : null,
      refreshExpiresAt: Number.isFinite(data.refresh_token_expires_in) ? issued + data.refresh_token_expires_in * 1000 : null,
      login: previous.login || null,
    };
    saveRecord(record);
    return record;
  }

  function view() {
    if (!available()) return { available: false, state: 'unavailable' };
    const record = readRecord();
    if (record) return { available: true, state: 'signed-in', login: record.login || null };
    if (pending) return { available: true, state: 'pending', userCode: pending.userCode, verificationUri: pending.verificationUri, expiresAt: new Date(pending.expiresAt).toISOString() };
    if (denied) return { available: true, state: 'denied' };
    if (expired) return { available: true, state: 'expired' };
    return { available: true, state: 'signed-out' };
  }

  // Asks GitHub for a code the person types at github.com/login/device.
  async function start() {
    if (!available()) fail('GitHub sign-in needs secure storage on this computer, which isn\'t available here.', 400);
    const data = await form(DEVICE_CODE_URL, {});
    if (!data.device_code || !data.user_code || !data.verification_uri) fail(`GitHub didn't give a sign-in code${data.error_description ? `: ${text(data.error_description, 200)}` : '.'}`, 502);
    const interval = Math.max(MIN_INTERVAL, Number(data.interval) || 5);
    pending = { deviceCode: data.device_code, userCode: text(data.user_code, 20), verificationUri: text(data.verification_uri, 200), interval, expiresAt: now() + (Number(data.expires_in) || 900) * 1000, nextPollAt: now() + interval * 1000 };
    denied = false; expired = false;
    return view();
  }

  // Checks a pending code, at most once per the interval GitHub gave, and reports where the sign-in stands.
  async function status() {
    if (!available()) return view();
    if (readRecord() || !pending) return view();
    if (now() >= pending.expiresAt) { pending = null; expired = true; return view(); }
    if (now() < pending.nextPollAt) return view();
    const data = await form(TOKEN_URL, { device_code: pending.deviceCode, grant_type: DEVICE_GRANT });
    if (data.access_token) {
      const record = store(data);
      record.login = await login(record.accessToken).catch(() => null);
      saveRecord(record);
      pending = null;
      return view();
    }
    switch (data.error) {
      case 'authorization_pending': break;
      case 'slow_down': pending.interval = Math.min(pending.interval + 5, 60); break;
      case 'expired_token': pending = null; expired = true; break;
      case 'access_denied': pending = null; denied = true; break;
      default: fail(`GitHub sign-in failed${data.error_description ? `: ${text(data.error_description, 200)}` : '.'}`, 502);
    }
    if (pending) pending.nextPollAt = now() + pending.interval * 1000;
    return view();
  }

  // A usable access token for GitHub calls, refreshed when it's close to expiry. Null when not signed in or when the
  // sign-in can't be renewed, in which case the stored sign-in is removed.
  async function token() {
    const record = readRecord();
    if (!record) return null;
    if (record.expiresAt === null || record.expiresAt - REFRESH_MARGIN > now()) return record.accessToken;
    if (!record.refreshToken || (record.refreshExpiresAt !== null && record.refreshExpiresAt <= now())) { forget(); return null; }
    const data = await form(TOKEN_URL, { grant_type: 'refresh_token', refresh_token: record.refreshToken });
    if (!data.access_token) { forget(); return null; }
    return store(data, record).accessToken;
  }
  // The signed-in login for the Sign out and status views, without contacting GitHub again.
  async function signOut() { forget(); return view(); }

  return { available, status, start, token, signOut, view, readRecord, login };
}
