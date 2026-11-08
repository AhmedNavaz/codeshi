# Private friend sharing

This is a separate Node HTTP service. It only stores approved portable handoff JSON and returned solution JSON. It has no provider imports, model calls, credentials integration, shell execution, or arbitrary repository access. The friend can use a normal browser and their own tools; installing Codeshi is unnecessary.

## Local development

From the Codeshi project root, run `node sharing/server.mjs`, then configure the local application's sharing URL as `http://127.0.0.1:4319`. The service binds to loopback by default. Links created with that URL work only on the same computer. A localhost round trip is not a deployment or a remotely reachable link.

Run its automated tests with `node --test sharing/test/*.test.mjs`. Tests use temporary storage and make no provider requests.

## Deployment

Use a separate host with HTTPS and a persistent private volume. Do not expose the main Codeshi execution server, create a tunnel to it, or mount either person's project or home directory into this service.

Each release publishes a prebuilt image for `linux/amd64` and `linux/arm64`: `docker pull ghcr.io/ahmednavaz/codeshi-sharing:latest`. To build it yourself, run this from the **project root**: `docker build -f sharing/Dockerfile -t codeshi-sharing .`. Run one replica behind a TLS reverse proxy. Mount a volume writable by the container's `node` user at `/data`. Forward requests to port 4319 on a private network, set `X-Forwarded-Proto: https`, and keep the upstream port inaccessible to public clients. The built-in server is HTTP; the reverse proxy owns TLS. Set the approved application's service URL to the verified public `https://` origin. The local client rejects plaintext external URLs and redirects.

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Set explicitly to `0.0.0.0` for hosting. |
| `PORT` | `4319` | Service port. |
| `SHARING_DATA_DIR` | `sharing/.data` | Private persistent data directory. |
| `REQUIRE_HTTPS` | `false` | Set `true` behind the HTTPS reverse proxy (Docker default). Trust forwarded headers only from that proxy. |
| `SHARING_CREATE_KEY` | unset | Optional deployment key required in `X-Sharing-Create-Key` for uploads. Codeshi sends the key it reads from `AI_RELAY_SHARING_CREATE_KEY` (see [Point Codeshi at the service](#point-codeshi-at-the-service)). This is a service deployment key, never an AI account credential. |

Without a creation key, uploads are open subject to limits. Use a creation key on a personal public deployment to prevent strangers consuming its storage. One service process/replica per data directory is required. This simple file store is not a distributed database. Back up the private volume using restricted access; do not log request bodies, Authorization headers, or capability URL fragments. Verify HTTPS, persistence after restart, expiry, revocation, and a full round trip before calling a hosted deployment ready. No hosted deployment is created by this repository.

`GET /health` answers `{"ok":true}`. With `REQUIRE_HTTPS=true` it is refused like any other plain request, so a health check that reaches the service directly must send `X-Forwarded-Proto: https`.

## Deployment templates

`sharing/deploy` holds ready-made setups for the published image. Each runs one copy of the service, keeps `/data` on a persistent volume, sets `REQUIRE_HTTPS=true` and requires a creation key, which stays out of the template files.

Make the key first, on any computer with OpenSSL:

```sh
openssl rand -hex 32
```

That is 256 random bits as 64 characters, safe to paste into env files and commands. Keep it in your password manager: the service checks it whenever a link is created, and Codeshi needs the same key.

### Docker Compose with Caddy

For any server with Docker Compose v2, ports 80 and 443 open to the internet and a hostname whose DNS record points at it. Caddy gets the HTTPS certificate for that hostname and renews it by itself.

1. Copy the three files in `sharing/deploy/compose` to the server.
2. In that folder run `cp env.example .env` and `chmod 600 .env`, then set `SHARING_DOMAIN` to the hostname and `SHARING_CREATE_KEY` to the key.
3. `docker compose config --quiet` checks the files and stops if either value is missing. Then run `docker compose up -d`.
4. `curl https://share.example.com/health`, with your hostname, should answer `{"ok":true}`.

Only Caddy publishes ports; the service is reachable only on the project's own Docker network. Requests are kept in the `codeshi-sharing_sharing-data` volume and certificates in `codeshi-sharing_caddy-data`. To keep requests in a folder on the server instead, make the folder owned by user ID 1000, the image's `node` user, before mounting it at `/data`.

### Fly.io

Fly matches what the service needs: one machine with its own volume, HTTPS from Fly's proxy, which sets `X-Forwarded-Proto`, a volume Fly makes writable for the image's own user, health checks that can send the header `REQUIRE_HTTPS` needs, and secrets for the key. The rest of the setup is in `fly.toml`.

With [flyctl](https://fly.io/docs/flyctl/install/) installed and signed in (`fly auth login`), in `sharing/deploy/fly`:

1. Set `app` in `fly.toml` to a name of your own, and `primary_region` to a region near you.
2. Run `fly apps create <name>`.
3. Run `fly secrets set SHARING_CREATE_KEY=<key>`.
4. Run `fly deploy --ha=false`. The first deploy creates the 1 GB `sharing_data` volume and one machine. Keep it at one: a second machine would get a separate, empty volume.
5. `curl https://<name>.fly.dev/health` should answer `{"ok":true}`. For a hostname of your own, run `fly certs add share.example.com` and add the DNS records it lists.

The machine stops when idle and starts again on the next request. It has 512 MB of memory, because a service filled to its 100 MiB storage limit needs more than Fly's default 256 MB. Fly snapshots volumes daily; that doesn't replace your own backups.

### Other hosts

Another host fits if it provides all of these:

- One running copy of the service, since copies can't share a data folder.
- A persistent volume at `/data` that user ID 1000 can write to. The image doesn't run as root, so a volume the host mounts owned by root needs its owner changed first.
- HTTPS in front that sets `X-Forwarded-Proto: https`, replacing anything a client sends in that header, with no other way to reach the service's port.
- Health checks, if any, on `GET /health` with `X-Forwarded-Proto: https`.
- `SHARING_CREATE_KEY` set from the host's secret settings.

### Point Codeshi at the service

In Codeshi, open **Ask a friend**, then **Returned solutions › Sharing service settings**. Enter the service's address on its own, such as `https://share.example.com` with no path, and choose **Save service URL**. Setting `AI_RELAY_SHARING_URL` before Codeshi starts does the same; while it is set, it takes the place of the saved address at every start.

Codeshi reads the creation key from the `AI_RELAY_SHARING_CREATE_KEY` environment variable when it starts. Quit Codeshi, then start it with the key:

- **macOS:** `AI_RELAY_SHARING_CREATE_KEY=<key> open -a Codeshi` in Terminal. The key lasts until Codeshi quits.
- **Windows:** `setx AI_RELAY_SHARING_CREATE_KEY <key>` in a terminal, then open Codeshi from the Start menu. Windows keeps the key for later starts too.
- **From source:** `AI_RELAY_SHARING_CREATE_KEY=<key> npm start`, or `npm run web`.

**Create private link** then gives your friend a link on your service.

### Update the image

Each release publishes `ghcr.io/ahmednavaz/codeshi-sharing:<version>`, such as `0.28.0` (no `v`), and moves `latest` to it. The templates use `latest`.

- **Compose:** run `docker compose pull` and then `docker compose up -d` in the template folder.
- **Fly:** run `fly deploy` again in `sharing/deploy/fly`; it fetches the image again.

The volume keeps every request through the update; links are unavailable while the service restarts. To decide when updates happen, put a release version in place of `latest` and change it when you want to update.

## Access and limits

The owner client generates independent 256-bit random view, submit, and owner capabilities before uploading. The service stores only SHA-256 hashes of those capabilities. View and submit capabilities go in the friend URL's fragment (`#view=…&submit=…`), which is not sent in the page request. Browser JS uses Bearer headers, clears the fragment, and keeps capabilities only in that tab's session storage for reloads. The owner capability stays in the owner's local private delivery store. There is no account login on the friend page: possession of the respective capability grants its stated access. Anyone receiving the full friend link can view and submit until expiry or revocation.

Requests default to 7-day expiry, with 60 seconds through 30 days supported. Revocation and expiry erase shared content and returned solutions from the active store; small authorization tombstones remain to return HTTP 410. Backup retention is the operator's responsibility. Owner retrieval after expiry/revocation also returns 410, so retrieve solutions before expiry. Revocation itself is idempotent. Wrong capabilities get 403, unknown IDs 404. Downloads contain only approved package files, located by exact keys in JSON, never by filesystem paths.

JSON uploads and responses are bounded at 2 MiB. The store defaults to 100 MiB total JSON, 500 active requests and 20 solutions per request. Combined returned solutions must fit the response bound. Upload creation is limited to 30 attempts per minute per socket address. Behind a proxy this is a shared limit. Storage/request quotas are intentionally simple and may require retention administration; keep a private export before removing service data. Upload IDs and solution IDs make retries idempotent; reusing either with changed contents is rejected. All incoming packages and solutions use the shared schema, safe-path, and integrity validators.

The local client saves the exact approved package and capabilities before networking. An interrupted upload remains `pending` and can be retried with the same upload ID. Existing export/import remains available offline. Owner polling validates returned solutions again and stores them locally; importing, reviewing, and applying remains the local app's responsibility. Nothing submitted by a friend executes on this service.
