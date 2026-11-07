import assert from 'node:assert/strict';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { googleQuota, parseGoogleQuota } from '../src/antigravity-usage.mjs';
import { providerUsage } from '../src/providers.mjs';

const report = `### Session Usage
- **Session total:** 900 tokens (prompt: 800, completion: 100)
### Quota Limits
- **Gemini Flash**
  - **5-hour Limit Remaining:** 37% remaining (resets Nov 01, 2026, 12:00 UTC)
  - **Weekly Limit Remaining:** 81% remaining
- **Gemini Argon**
  - **Weekly Limit Remaining:** 0% remaining
- **Claude and GPT models**
  - **Weekly Limit Remaining:** 92% remaining
`;
function folder(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-quota-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
class Client extends EventEmitter {
  requests = []; replies = [];
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'initialize') return { protocolVersion: 1, agentInfo: { name: 'antigravity-acp', version: this.version || '1.4.5' } };
    if (method === 'session/new') { if (this.signedOut) throw new Error('Authentication required'); return { sessionId: 'usage-only', configOptions: [{ id: 'model', currentValue: 'gemini-argon' }], _meta: { antigravity: { tier: { name: 'Native plan', id: 'native' } } } }; }
    if (method === 'session/prompt') {
      assert.deepEqual(params.prompt, [{ type: 'text', text: '/usage' }]);
      if (this.permission) this.emit('message', { id: 5, method: 'session/request_permission', params: { sessionId: 'usage-only', options: [{ kind: 'allow_once', optionId: 'once' }] } });
      for (const text of [report.slice(0, 100), report.slice(100)]) this.emit('message', { method: 'session/update', params: { sessionId: 'usage-only', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      return { stopReason: this.stopReason || 'end_turn' };
    }
    throw new Error('Unexpected request: ' + method);
  }
  send(message) { this.replies.push(message); }
  close() { this.closed = true; }
}
test('native Google quota uses reported remaining percentages and buckets instead of estimated usage', () => {
  const result = parseGoogleQuota(report);
  assert.equal(result.available, true);
  assert.deepEqual(result.windows.map(row => [row.label, row.usedPercent, row.scopes]), [
    ['5-hour · Gemini Flash', 63, ['flash']], ['Weekly · Gemini Flash', 19, ['flash']], ['Weekly · Gemini Argon', 100, ['argon']], ['Weekly · Claude and GPT models', 8, ['claude', 'gpt']],
  ]);
  assert.equal(result.windows[0].resetsAt, '2026-11-01T12:00:00.000Z'); assert.equal(result.windows[1].resetsAt, null);
});
test('Google spelling out the five-hour limit still reads as 5-hour, which leads an agent\'s row', () => {
  const { windows } = parseGoogleQuota('### Quota Limits\n- **Gemini Models**\n  - **Five Hour Limit Remaining:** 99% remaining\n  - **Weekly Limit Remaining:** 100% remaining\n');
  assert.deepEqual(windows.map(row => row.label), ['5-hour · Gemini Models', 'Weekly · Gemini Models']);
});
test('missing, malformed and token-only reports never create quota estimates', () => {
  for (const value of [null, '', '### Session Usage\n- **Session total:** 900 tokens', '### Quota Limits\n- data not available yet', '### Quota Limits\n- Unable to retrieve quota status (network)', '### Quota Limits\n- **Gemini Flash**\n  - **Weekly:** 999% remaining']) {
    const result = parseGoogleQuota(value); assert.equal(result.available, false); assert.deepEqual(result.windows, []);
  }
});
test('disabled buckets and absolute units retain their real status without invented percentages', () => {
  const result = parseGoogleQuota('### Quota Limits\n- **Gemini Models**\n  - **Weekly:** Disabled: unavailable for this tier\n  - **Daily:** 1,200 units remaining\n  - **Other:** Available');
  assert.equal(result.available, true); assert.equal(result.windows[0].disabled, true); assert.equal(result.windows[1].remainingAmount, 1200); assert.equal(result.windows[2].status, 'Available');
  assert(result.windows.every(row => row.usedPercent === undefined));
});
test('Google usage calls only the verified native usage command in an isolated metadata session', async t => {
  const root = folder(t), client = new Client(); let options;
  const result = await googleQuota({ bin: path.join(root, 'agy_acp_server.par'), googleRoot: root }, value => { options = value; return client; });
  assert.equal(result.available, true); assert.equal(result.defaultModel, 'gemini-argon'); assert.equal(result.plan, 'Native plan');
  assert.deepEqual(client.requests.map(row => row.method), ['initialize', 'session/new', 'session/prompt']); assert.deepEqual(client.requests[1].params.mcpServers, []);
  assert.equal(options.env.GEMINI_HOME, path.join(root, 'profile')); assert.equal(options.cwd, path.join(root, 'profile/metadata')); assert(client.closed);
});
test('unverified runtimes, sign-out, tool requests and incomplete usage never receive approval or show estimates', async t => {
  const root = folder(t), options = { bin: path.join(root, 'agy_acp_server.par'), googleRoot: root };
  for (const config of [{ version: '1.4.6' }, { signedOut: true }, { permission: true }, { stopReason: 'cancelled' }]) {
    const client = Object.assign(new Client(), config), result = await googleQuota(options, () => client);
    assert.equal(result.available, false); assert.deepEqual(result.windows, []); assert(client.closed);
    assert(!client.replies.some(reply => reply.result?.outcome?.outcome === 'selected'));
    if (config.version || config.signedOut) assert(!client.requests.some(row => row.method === 'session/prompt'));
  }
});
test('provider usage caches are isolated by Google profile and explicit refresh reads the native report again', { skip: scriptCLIs }, async t => {
  const root = folder(t), bin = path.join(root, 'agy_acp_server.par'), script = path.join(root, 'native-fixture.mjs'), capture = path.join(root, 'requests.jsonl');
  fs.writeFileSync(script, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
const send=m=>console.log(JSON.stringify({jsonrpc:'2.0',...m}));
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(m)+'\\n');
if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.4.5'}}});
if(m.method==='session/new')send({id:m.id,result:{sessionId:'quota',configOptions:[{id:'model',currentValue:'gemini-flash'}]}});
if(m.method==='session/prompt'){if(JSON.stringify(m.params.prompt)!==JSON.stringify([{type:'text',text:'/usage'}]))throw Error('Only native usage is allowed');const remaining=process.env.GEMINI_HOME.includes('account-a')?25:80;send({method:'session/update',params:{sessionId:'quota',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'### Quota Limits\\n- **Gemini Flash**\\n  - **Weekly Limit Remaining:** '+remaining+'% remaining'}}}});send({id:m.id,result:{stopReason:'end_turn'}});}}
`, { mode: 0o700 }); fs.symlinkSync(script, bin);
  const a = { bin, workspace: root, googleRoot: path.join(root, 'account-a') }, b = { ...a, googleRoot: path.join(root, 'account-b') };
  assert.equal((await providerUsage('gemini', a)).windows[0].usedPercent, 75); assert.equal((await providerUsage('gemini', b)).windows[0].usedPercent, 20); await providerUsage('gemini', a);
  let requests = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse); assert.equal(requests.filter(row => row.method === 'session/prompt').length, 2);
  await providerUsage('gemini', { ...a, refresh: true }); requests = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse); assert.equal(requests.filter(row => row.method === 'session/prompt').length, 3); assert(!requests.some(row => row.method === 'authenticate'));
});
