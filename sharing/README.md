# Private friend sharing

This is a separate Node HTTP service. It only stores approved portable handoff JSON and returned solution JSON. It has no provider imports, model calls, credentials integration, shell execution, or arbitrary repository access. The friend can use a normal browser and their own tools; installing Codeshi is unnecessary.

## Local development

From the Codeshi project root, run `node sharing/server.mjs`, then configure the local application's sharing URL as `http://127.0.0.1:4319`. The service binds to loopback by default. Links created with that URL work only on the same computer. A localhost round trip is not a deployment or a remotely reachable link.

Run its automated tests with `node --test sharing/test/*.test.mjs`. Tests use temporary storage and make no provider requests.

## Deployment

Use a separate host with HTTPS and a persistent private volume. Do not expose the main Codeshi execution server, create a tunnel to it, or mount either person's project or home directory into this service.

Each release publishes a prebuilt image for `linux/amd64` and `linux/arm64`: `docker pull ghcr.io/ahmednavaz/throughline-sharing:latest`. The image keeps the name it had before Codeshi was renamed, so existing deployments keep updating. To build it yourself, run this from the **project root**: `docker build -f sharing/Dockerfile -t throughline-sharing .`. Run one replica behind a TLS reverse proxy. Mount a volume writable by the container's `node` user at `/data`. Forward requests to port 4319 on a private network, set `X-Forwarded-Proto: https`, and keep the upstream port inaccessible to public clients. The built-in server is HTTP; the reverse proxy owns TLS. Set the approved application's service URL to the verified public `https://` origin. The local client rejects plaintext external URLs and redirects.

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Set explicitly to `0.0.0.0` for hosting. |
| `PORT` | `4319` | Service port. |
| `SHARING_DATA_DIR` | `sharing/.data` | Private persistent data directory. |
| `REQUIRE_HTTPS` | `false` | Set `true` behind the HTTPS reverse proxy (Docker default). Trust forwarded headers only from that proxy. |
| `SHARING_CREATE_KEY` | unset | Optional deployment key required in `X-Sharing-Create-Key` for uploads. Supply the same key to the local `SharingClient` constructor as `createKey`. This is a service deployment key, never an AI account credential. |

Without a creation key, uploads are open subject to limits. Use a creation key on a personal public deployment to prevent strangers consuming its storage. One service process/replica per data directory is required. This simple file store is not a distributed database. Back up the private volume using restricted access; do not log request bodies, Authorization headers, or capability URL fragments. Verify HTTPS, persistence after restart, expiry, revocation, and a full round trip before calling a hosted deployment ready. No hosted deployment is created by this repository.

## Access and limits

The owner client generates independent 256-bit random view, submit, and owner capabilities before uploading. The service stores only SHA-256 hashes of those capabilities. View and submit capabilities go in the friend URL's fragment (`#view=…&submit=…`), which is not sent in the page request. Browser JS uses Bearer headers, clears the fragment, and keeps capabilities only in that tab's session storage for reloads. The owner capability stays in the owner's local private delivery store. There is no account login on the friend page: possession of the respective capability grants its stated access. Anyone receiving the full friend link can view and submit until expiry or revocation.

Requests default to 7-day expiry, with 60 seconds through 30 days supported. Revocation and expiry erase shared content and returned solutions from the active store; small authorization tombstones remain to return HTTP 410. Backup retention is the operator's responsibility. Owner retrieval after expiry/revocation also returns 410, so retrieve solutions before expiry. Revocation itself is idempotent. Wrong capabilities get 403, unknown IDs 404. Downloads contain only approved package files, located by exact keys in JSON, never by filesystem paths.

JSON uploads and responses are bounded at 2 MiB. The store defaults to 100 MiB total JSON, 500 active requests and 20 solutions per request. Combined returned solutions must fit the response bound. Upload creation is limited to 30 attempts per minute per socket address. Behind a proxy this is a shared limit. Storage/request quotas are intentionally simple and may require retention administration; keep a private export before removing service data. Upload IDs and solution IDs make retries idempotent; reusing either with changed contents is rejected. All incoming packages and solutions use the shared schema, safe-path, and integrity validators.

The local client saves the exact approved package and capabilities before networking. An interrupted upload remains `pending` and can be retried with the same upload ID. Existing export/import remains available offline. Owner polling validates returned solutions again and stores them locally; importing, reviewing, and applying remains the local app's responsibility. Nothing submitted by a friend executes on this service.
