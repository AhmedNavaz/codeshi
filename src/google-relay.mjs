import { randomBytes, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';

// On some networks Google's API front ends accept IPv6 connections and then stall the TLS handshake. The
// Antigravity runtime prefers IPv6 and never falls back, so its checks hang for ten seconds and fail. It reaches
// Google through this loopback relay instead, which connects over IPv4 first and uses IPv6 only when IPv4 fails.
// The relay only opens CONNECT tunnels to Google hosts on port 443, for clients holding its token. TLS runs end to
// end inside the tunnel, so the relay never sees requests or credentials.
//
// A run needs more. The runtime passes its environment on to every command the agent runs, so git, gh, curl and npm
// come here too, and refusing them looks like a network outage. With commands on, the relay tunnels to any host for
// them. That gives them nothing new, since a command can reach the network directly anyway.
const allowedHost = host => /^(?:[a-z0-9-]+\.)*(?:googleapis|google)\.com$/.test(host);
const attemptTimeout = 5000;

export function createGoogleRelay({ lookup = (host) => dns.lookup(host, { all: true }), connect = options => net.connect(options), commands = false } = {}) {
  const token = randomBytes(24).toString('hex'), expected = Buffer.from('Basic ' + Buffer.from('throughline:' + token).toString('base64'));
  const sockets = new Set();
  const server = http.createServer((request, response) => { response.writeHead(405, { connection: 'close' }).end(); });
  const refuse = (socket, status) => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
  server.on('connect', async (request, socket, head) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => socket.destroy());
    const offered = Buffer.from(String(request.headers['proxy-authorization'] || ''));
    // Git asks without its credentials first, and sends them only when told how.
    if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) return refuse(socket, '407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Codeshi"');
    const target = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(request.url || ''), host = target?.[1].toLowerCase().replace(/^\[|\]$/g, ''), port = Number(target?.[2]);
    if (!host || !(commands ? port >= 1 && port <= 65535 : port === 443 && allowedHost(host))) return refuse(socket, '403 Forbidden');
    let addresses = [];
    try { addresses = (await lookup(host)).filter(entry => entry.family === 4 || entry.family === 6).sort((a, b) => a.family - b.family); } catch {}
    for (const { address } of addresses) {
      if (socket.destroyed) return;
      const upstream = await new Promise(resolve => {
        const attempt = connect({ host: address, port });
        const timer = setTimeout(() => { attempt.destroy(); resolve(null); }, attemptTimeout);
        attempt.once('connect', () => { clearTimeout(timer); resolve(attempt); });
        attempt.once('error', () => { clearTimeout(timer); resolve(null); });
      });
      if (!upstream) continue;
      if (socket.destroyed) { upstream.destroy(); return; }
      sockets.add(upstream); upstream.on('close', () => { sockets.delete(upstream); socket.destroy(); }); upstream.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
      return;
    }
    refuse(socket, '502 Bad Gateway');
  });
  // The relay serves the runtime while it runs; it does not keep the app or a test process alive by itself.
  const ready = new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.unref(); resolve(`http://throughline:${token}@127.0.0.1:${server.address().port}`); }); });
  return { ready, close() { for (const socket of sockets) socket.destroy(); sockets.clear(); return new Promise(resolve => server.close(() => resolve())); } };
}

const shared = new Map();
// One relay of each kind per process: the app server's for connection checks, which run no tools, and a provider
// worker's for its run, which also carries the agent's commands.
export function googleRelay({ commands = false } = {}) {
  if (!shared.has(commands)) shared.set(commands, createGoogleRelay({ commands }));
  return shared.get(commands).ready.catch(error => { shared.delete(commands); throw error; });
}
export async function closeGoogleRelay() { const current = [...shared.values()]; shared.clear(); await Promise.all(current.map(relay => relay.close())); }

// A proxy the user configured already decides how Google is reached; the relay stays out of its way.
const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
export function relayEnvironment(env, relay) {
  if (!relay || proxyKeys.some(key => env[key])) return env;
  return { ...env, HTTPS_PROXY: relay, https_proxy: relay, NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' };
}
