import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { createGoogleRelay, relayEnvironment } from '../src/google-relay.mjs';

// Opens a CONNECT tunnel through the relay and returns its status line plus a socket for the tunnelled bytes.
function tunnel(relayURL, target, { auth = true } = {}) {
  const url = new URL(relayURL), socket = net.connect(+url.port, url.hostname);
  const credentials = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: Basic ${credentials}\r\n` : ''}\r\n`);
  return new Promise((resolve, reject) => {
    let data = '';
    socket.on('data', function head(chunk) { data += chunk; if (!data.includes('\r\n\r\n')) return; socket.off('data', head); resolve({ status: data.split('\r\n')[0], socket }); });
    socket.on('error', reject);
  });
}

test('the Google relay tunnels only authorized CONNECTs to Google hosts on 443, IPv4 first with IPv6 fallback', async t => {
  const echo = net.createServer(socket => socket.pipe(socket)); await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve)); t.after(() => echo.close());
  const attempts = [], unreachable = new Set();
  const relay = createGoogleRelay({
    lookup: async () => [{ address: '2001:db8::1', family: 6 }, { address: '192.0.2.1', family: 4 }],
    connect: ({ host }) => {
      attempts.push(host);
      if (unreachable.has(host)) { const failed = new net.Socket(); setImmediate(() => failed.emit('error', new Error('unreachable'))); return failed; }
      return net.connect(echo.address().port, '127.0.0.1');
    },
  });
  t.after(() => relay.close());
  const url = await relay.ready;
  assert.match(url, /^http:\/\/throughline:[0-9a-f]{48}@127\.0\.0\.1:\d+$/);

  assert.match((await tunnel(url, 'cloudcode-pa.googleapis.com:443', { auth: false })).status, / 407 /, 'A client without the token is refused.');
  assert.match((await tunnel(url, 'example.com:443')).status, / 403 /, 'Only Google hosts are reachable.');
  assert.match((await tunnel(url, 'evilgoogleapis.com:443')).status, / 403 /);
  assert.match((await tunnel(url, 'cloudcode-pa.googleapis.com:80')).status, / 403 /, 'Only TLS on port 443 is tunnelled.');
  assert.equal(attempts.length, 0, 'Refused requests never connect upstream.');

  const open = await tunnel(url, 'cloudcode-pa.googleapis.com:443');
  assert.match(open.status, / 200 /); assert.deepEqual(attempts, ['192.0.2.1'], 'IPv4 is tried before IPv6.');
  const echoed = new Promise(resolve => open.socket.once('data', chunk => resolve(String(chunk))));
  open.socket.write('client hello'); assert.equal(await echoed, 'client hello', 'Bytes pass through the tunnel unchanged.');
  open.socket.destroy();

  attempts.length = 0; unreachable.add('192.0.2.1');
  const fallback = await tunnel(url, 'oauth2.googleapis.com:443');
  assert.match(fallback.status, / 200 /); assert.deepEqual(attempts, ['192.0.2.1', '2001:db8::1'], 'IPv6 is used when IPv4 fails.');
  fallback.socket.destroy();

  unreachable.add('2001:db8::1');
  assert.match((await tunnel(url, 'oauth2.googleapis.com:443')).status, / 502 /);
});

test('a run’s relay also carries the agent’s commands, to any host and port, for clients holding the token', async t => {
  const echo = net.createServer(socket => socket.pipe(socket)); await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve)); t.after(() => echo.close());
  const attempts = [];
  const relay = createGoogleRelay({ commands: true, lookup: async host => [{ address: host === '::1' ? '::1' : '192.0.2.1', family: host === '::1' ? 6 : 4 }], connect: ({ host, port }) => { attempts.push([host, port]); return net.connect(echo.address().port, '127.0.0.1'); } });
  t.after(() => relay.close());
  const url = await relay.ready;
  const refused = await tunnel(url, 'github.com:443', { auth: false });
  assert.match(refused.status, / 407 /, 'The token is still required.');
  assert.deepEqual(attempts, []);
  for (const [target, expected] of [['github.com:443', ['192.0.2.1', 443]], ['registry.example.com:8443', ['192.0.2.1', 8443]], ['[::1]:9443', ['::1', 9443]]]) {
    const open = await tunnel(url, target);
    assert.match(open.status, / 200 /, target); assert.deepEqual(attempts.at(-1), expected);
    open.socket.destroy();
  }
  assert.match((await tunnel(url, 'github.com:70000')).status, / 403 /, 'A port that does not exist is refused.');
  assert.match((await tunnel(url, 'not a host:443')).status, / 400 | 403 /);
});

test('asked without credentials, the relay says how to send them, because git only sends them then', async t => {
  const relay = createGoogleRelay(); t.after(() => relay.close());
  const url = new URL(await relay.ready), socket = net.connect(+url.port, url.hostname);
  socket.write('CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n');
  const reply = await new Promise(resolve => { let data = ''; socket.on('data', chunk => { data += chunk; }); socket.on('close', () => resolve(data)); });
  assert.match(reply, /^HTTP\/1\.1 407 /); assert.match(reply, /\r\nProxy-Authenticate: Basic realm="Codeshi"\r\n/);
});

test('the runtime uses the relay unless the user already configured a proxy', () => {
  const env = relayEnvironment({ PATH: '/bin' }, 'http://throughline:token@127.0.0.1:1');
  assert.equal(env.HTTPS_PROXY, 'http://throughline:token@127.0.0.1:1'); assert.equal(env.https_proxy, env.HTTPS_PROXY); assert.match(env.NO_PROXY, /127\.0\.0\.1/);
  const own = { PATH: '/bin', https_proxy: 'http://corporate:8080' };
  assert.equal(relayEnvironment(own, 'http://throughline:token@127.0.0.1:1'), own);
  assert.equal(relayEnvironment({ PATH: '/bin' }, null).HTTPS_PROXY, undefined, 'Without a relay the runtime connects directly.');
});

test('opening the app checks the Google account and its models with one runtime launch, and reuses a signed-in result briefly', { skip: scriptCLIs }, async t => {
  const { default: fs } = await import('node:fs'), { default: os } = await import('node:os'), { default: path } = await import('node:path');
  const { accountStatus, listModels, closeAccountConnections } = await import('../src/providers.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-google-check-')); t.after(() => { closeAccountConnections(); fs.rmSync(root, { recursive: true, force: true }); });
  const launches = path.join(root, 'launches.log'), bin = path.join(root, 'antigravity-acp');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline');
fs.appendFileSync(${JSON.stringify(launches)}, (process.env.HTTPS_PROXY ? 'relayed' : 'direct') + '\\n');
const emit=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')emit({id:m.id,result:{protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.4.5'},authMethods:[{id:'oauth-personal'}],agentCapabilities:{sessionCapabilities:{additionalDirectories:{}}}}});
if(m.method==='session/new')setTimeout(()=>emit({id:m.id,result:{sessionId:'check',_meta:{antigravity:{tier:{id:'g1-pro-tier',name:'Google AI Pro'}}},configOptions:[{id:'model',currentValue:'gemini-fast',options:[{value:'gemini-fast',name:'Gemini Fast'},{value:'other-model'}]}]}}),150);});
`, { mode: 0o700 });
  const count = () => fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').trim().split('\n') : [];
  closeAccountConnections();
  const [account, models] = await Promise.all([accountStatus('gemini', { bin, googleRoot: root }), listModels('gemini', { bin, googleRoot: root })]);
  assert.equal(account.authenticated, true); assert.equal(account.planType, 'Google AI Pro');
  assert.equal(account.capabilities.additionalDirectories, true); assert.equal(account.capabilities.readOnly, 'unavailable');
  assert.deepEqual(models.models.map(model => model.id), ['gemini-fast'], 'Only Gemini models are offered.');
  assert.deepEqual(count(), ['relayed'], 'Status and models share one launch, and the runtime reaches Google through the relay.');
  assert.equal((await accountStatus('gemini', { bin, googleRoot: root })).authenticated, true); assert.equal(count().length, 1, 'A signed-in result is reused.');
  assert.deepEqual((await listModels('gemini', { bin, googleRoot: root })).models.map(model => model.id), ['gemini-fast'], 'A reused result is not altered by an earlier filter.');
  await accountStatus('gemini', { bin, googleRoot: root, refresh: true }); assert.equal(count().length, 2, 'Refresh asks the runtime again.');
});
