import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSharingServer } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Git may check text out with CRLF on Windows; line endings don't change what the files say.
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const compose = read('sharing/deploy/compose/compose.yaml'), caddyfile = read('sharing/deploy/compose/Caddyfile');
const envExample = read('sharing/deploy/compose/env.example'), fly = read('sharing/deploy/fly/fly.toml');

// These templates are flat enough to read without a YAML or TOML parser: a service is the lines under its
// two-space key, a TOML table runs to the next header, and every value sits on its own line.
const service = name => compose.split(/^(?= {2}\S)/m).find(part => part.startsWith(`  ${name}:\n`)) || '';
const yaml = (block, key) => block.match(new RegExp(`^ +${key}: *(.*)$`, 'm'))?.[1].replace(/^"(.*)"$/, '$1');
const table = name => fly.split(/^(?= *\[)/m).find(part => part.trim().split('\n')[0] === name) || '';
const toml = (block, key) => block.match(new RegExp(`^ *${key} *= *(.*)$`, 'm'))?.[1].replace(/^"(.*)"$/, '$1');

// What the release workflow publishes and what the image itself runs with.
const owner = JSON.parse(read('package.json')).repository.url.match(/github\.com\/([^/]+)\//)[1].toLowerCase();
const imageName = read('.github/workflows/release.yml').match(/IMAGE=ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER,,\}\/([a-z0-9-]+)/)[1];
const image = `ghcr.io/${owner}/${imageName}`;
const dockerfile = read('sharing/Dockerfile');
const port = dockerfile.match(/^ENV .*\bPORT=(\d+)/m)[1];
const published = tag => tag === 'latest' || /^\d+\.\d+\.\d+$/.test(tag);

async function sharingService(t, env) {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-relay-sharing-deploy-'));
  Object.assign(process.env, env);
  // The server reads REQUIRE_HTTPS itself, so the template's exact text decides whether the check is on.
  const app = createSharingServer({ dataDir });
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return app.server.address().port;
}

test('the templates run the image each release publishes, on the port it listens on', () => {
  assert.equal(image, 'ghcr.io/ahmednavaz/codeshi-sharing', 'The image is named codeshi-sharing.');
  assert.match(dockerfile, new RegExp(`^EXPOSE ${port}$`, 'm'));
  for (const [template, reference] of [['compose.yaml', yaml(service('sharing'), 'image')], ['fly.toml', toml(table('[build]'), 'image')]]) {
    const [name, tag] = reference?.split(/:(?=[^:]*$)/) || [];
    assert.equal(name, image, template);
    assert.ok(published(tag), `${template} uses a tag the release workflow pushes: ${tag}`);
  }
  assert.equal(yaml(service('sharing'), 'PORT'), port);
  assert.equal(toml(table('[env]'), 'PORT'), port);
  assert.match(caddyfile, new RegExp(`^\\s*reverse_proxy sharing:${port}$`, 'm'), 'Caddy forwards to the service on its port.');
  assert.equal(toml(table('[http_service]'), 'internal_port'), port, 'Fly forwards to the service on its port.');
});

test('every template requires HTTPS, keeps /data on a volume and takes the creation key from outside the file', () => {
  const sharing = service('sharing');
  assert.equal(yaml(sharing, 'REQUIRE_HTTPS'), 'true');
  assert.equal(yaml(sharing, 'SHARING_DATA_DIR'), '/data');
  const volume = sharing.match(/^ +- ([a-z0-9_-]+):\/data$/m)?.[1];
  assert.ok(volume, 'The compose service mounts a volume at /data.');
  assert.match(compose, new RegExp(`^volumes:\\n(?: {2}\\S.*\\n)*? {2}${volume}:`, 'm'), 'It is a named volume, which Docker gives to the image\'s user.');
  assert.doesNotMatch(sharing, /^ {4}ports:/m, 'Only Caddy can reach the service; its port is not published.');
  assert.match(yaml(sharing, 'SHARING_CREATE_KEY'), /^\$\{SHARING_CREATE_KEY:\?[^}]+\}$/, 'Compose refuses to start without a key in .env.');
  assert.match(envExample, /^SHARING_CREATE_KEY=$/m, 'The example env file leaves the key for the operator to generate.');
  assert.match(yaml(service('caddy'), 'SHARING_DOMAIN'), /^\$\{SHARING_DOMAIN:\?[^}]+\}$/);
  assert.match(caddyfile, /^\{\$SHARING_DOMAIN\} \{$/m, 'Caddy serves, and gets a certificate for, the domain from .env.');
  assert.match(service('caddy'), /^ {6}- "443:443"$/m, 'Caddy takes HTTPS.');

  const env = table('[env]');
  assert.equal(toml(env, 'REQUIRE_HTTPS'), 'true');
  assert.equal(toml(env, 'SHARING_DATA_DIR'), '/data');
  assert.equal(toml(table('[mounts]'), 'destination'), '/data');
  assert.equal(toml(table('[http_service]'), 'force_https'), 'true');
  assert.doesNotMatch(fly, /^ *SHARING_CREATE_KEY *=/m, 'On Fly the key is a secret, never a value in fly.toml.');

  for (const [template, source] of Object.entries({ compose, caddyfile, envExample, fly })) {
    // Hex, as the README suggests, or base64 and base64url, as other generators write it.
    assert.doesNotMatch(source, /[A-Fa-f0-9]{32,}|[A-Za-z0-9+/]{40,}|[A-Za-z0-9_-]{40,}/, `${template} holds nothing that looks like a real key.`);
  }
});

test('each health check gets through the HTTPS requirement, which turns plain requests away', async t => {
  const sharing = service('sharing');
  const local = await sharingService(t, { REQUIRE_HTTPS: yaml(sharing, 'REQUIRE_HTTPS') });
  assert.equal((await fetch(`http://127.0.0.1:${local}/health`)).status, 403, 'A request that skipped the proxy is refused.');

  // Docker runs the compose check inside the container, so run the same command against this service.
  const [kind, command, ...args] = JSON.parse(yaml(sharing.slice(sharing.indexOf('healthcheck:')), 'test'));
  assert.deepEqual([kind, command], ['CMD', 'node']);
  const script = args.at(-1);
  assert.ok(script.includes(`http://127.0.0.1:${port}/health`), script);
  const check = async target => {
    const child = spawn(process.execPath, [...args.slice(0, -1), script.replace(`127.0.0.1:${port}`, `127.0.0.1:${target}`)], { stdio: 'ignore' });
    return (await once(child, 'exit'))[0];
  };
  assert.equal(await check(local), 0, 'The compose health check passes on a healthy service.');
  const failing = http.createServer((req, res) => { res.writeHead(503); res.end(); });
  failing.listen(0, '127.0.0.1'); await once(failing, 'listening');
  const down = failing.address().port, answeredWithError = await check(down);
  await new Promise(resolve => failing.close(resolve));
  assert.equal(answeredWithError, 1, 'It fails when the service answers with an error.');
  assert.equal(await check(down), 1, 'It fails when nothing answers.');

  const checks = table('[[http_service.checks]]'), headers = table('[http_service.checks.headers]');
  assert.equal(toml(checks, 'path'), '/health');
  const flyLocal = await sharingService(t, { REQUIRE_HTTPS: toml(table('[env]'), 'REQUIRE_HTTPS') });
  const sent = Object.fromEntries([...headers.matchAll(/^ *([A-Za-z-]+) *= *"([^"]*)"$/gm)].map(([, name, value]) => [name, value]));
  assert.equal((await fetch(`http://127.0.0.1:${flyLocal}/health`)).status, 403);
  const response = await fetch(`http://127.0.0.1:${flyLocal}${toml(checks, 'path')}`, { method: toml(checks, 'method'), headers: sent });
  assert.equal(response.status, 200, 'The Fly check passes on a healthy service.');
  assert.deepEqual(await response.json(), { ok: true });
});
