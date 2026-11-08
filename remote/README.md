# Remote access

This is the Firebase Spark pilot for Codeshi's **Remote access → Away from home** connection. Users do not need
a Firebase account, VPN, mobile app, certificate installation or router configuration. Their computer and phone
both make outbound connections. Agents and project files remain on the computer.

The local-network connection is independent and still works without Firebase or internet access.

## Maintainer setup

The current public client configuration is in `firebase-public.json`. It contains a Firebase web API key, project ID,
database address and hosted phone address. These are public client identifiers, not administrator credentials.
The account used for the pilot is `ahmednawaz.dev@gmail.com`, with a separate project, `codeshi-phone`, and a default
Realtime Database in `europe-west1`. Billing has not been linked by this implementation.

To use your own Firebase project, register a Web app, create its default Realtime Database and update
`firebase-public.json`. Set `phoneURL` to your Firebase Hosting origin or an HTTPS custom domain pointed at that
hosting site. The app and hosted page must use the same configuration. Keep the project on Spark if you want
its fixed no-cost limits; exceeding them can interrupt remote access rather than silently expanding capacity.

Build and verify before deploying:

```sh
npm run build:phone
node --import ./test/isolate.mjs --test test/phone-remote.test.mjs test/phone-access.test.mjs
npm run test:phone:remote
```

The emulator command needs Firebase CLI and Java 21 or newer. If another Java version is the default, select the
installed Java 21 runtime in your shell first. Tests use `demo-codeshi-phone` and refuse to run without emulator
environment variables; they never target the live database. The default test suite has no Firebase network calls.

After the owner approves the deployment under the repository workflow:

```sh
firebase deploy --only auth,database,hosting --config remote/firebase.json --project codeshi-phone --account ahmednawaz.dev@gmail.com
```

This enables anonymous authentication, installs the restrictive database rules, and publishes only `remote/dist`.
The builder copies an explicit phone-asset allowlist and rejects unexpected files in that generated directory.
It never uploads the repository, desktop interface, native credentials, project files or application data directory.
Firebase configuration is included in packaged desktop builds; a release must include the matching hosted page.

## Pairing and transport

Remote access is off by default. Turning it on authenticates the computer anonymously, cleans up old channels
belonging to that installation that it no longer holds, and creates a five-minute, one-use invite. The QR link's
fragment contains a random channel ID and a random 256-bit encryption key. The browser removes the fragment
from the address bar and remembers the session on that phone. The key is never written to Firebase.

The phone authenticates anonymously and submits an encrypted pairing request. The computer displays its name
and six-digit number. The owner must compare that number and choose **Allow**. The grant lasts up to one week and survives a
Codeshi restart: the computer keeps each active channel's ID and key next to its Firebase credentials in the
owner-only `phone-firebase-auth.json`, reconnects on launch, and sets the expiry timer from the time remaining.
**Remove device** or turning remote access off stops further control at once and deletes the channel. A new
browser requires computer approval, unless an already paired browser hands its connection over: that creates a
one-use, five-minute replacement channel and ends the old one. Scanning the link is not sufficient to start an
agent or answer an approval.

AES-GCM encrypts request and response contents, with separate authenticated directions and channel IDs. Firebase
sees coordination metadata, such as anonymous IDs, expiry and connection state, plus encrypted packets. It does
not receive the pairing key, desktop session token, prompt text, device name or agent approval details in plaintext.
The hosted client code remains part of the trusted application, as with other browser encryption designs.

Database rules deny listing channels, cross-phone reads, changing a desktop grant from a phone, and writing another
phone's requests. The desktop independently verifies the key, approved identity, grant lifetime and request lifetime.
Request IDs stay protected against replay for their entire acceptance window, even when traffic is rate limited.
Responses have a bounded cache; a reconnect does not execute the same local action again. Commands are never
automatically retried by the phone after an uncertain timeout.

Every remote API call runs through the existing local request handler, including agent billing checks, workspace
and task ownership, access modes, budget checks and stale-approval rejection. Only the endpoints used by the
minimal phone page are allowed. Files, terminal access, desktop settings, local microphone control and managing
phone grants are excluded from the remote API.

## Limits and operation

- Up to five remote phone channels per desktop session.
- At most 90 new requests per minute per phone, including reads and session checks.
- One encrypted request mailbox and one encrypted outgoing mailbox per channel, each bounded in size.
- Up to 1 MiB of plaintext per packet. Use smaller photos if an attachment exceeds the remote limit.
- Progress invalidations are combined over two seconds; the phone requests the compact conversation/delta form.
  New phone/desktop builds negotiate append-only text transfers against an acknowledged snapshot. A missing base,
  a lost reply, a different conversation or an older build falls back to complete message text. Base caches are bounded
  to 100 messages and approximately 2 MiB of text per phone, held only on the paired devices.
- Workspace metadata refreshes on actual workspace changes, current conversation status/approval changes, opening
  the workspace picker, reconnecting, and a one-minute fallback. Ordinary progress refreshes only the conversation.
  Prompts, Stop and approvals are not held for the progress batching timer.
- Database writes use Firebase's `print=silent` option so the sender does not download a duplicate of each packet.
- Hidden pages close the Firebase response stream and stop routine refreshes. Background push notifications and
  PWA installation are not included.
- Normal disconnect deletes the channel. After a crash or network outage, encrypted leftovers can remain until
  that desktop next enables remote access or an operator cleans them up. Spark does not provide server-side TTL
  cleanup here; monitor database storage as well as downloads and simultaneous connections.

Firebase Spark's published limits apply to the whole pilot project, not to each person. Watch the Firebase usage
dashboard before expanding access. No Cloud Functions, Cloud Storage, paid plan upgrade or AWS service is required.

## Measuring traffic

`npm run measure:phone` replays a synthetic workload locally through the real encrypted relay, without Firebase.
`npm run measure:phone -- --live` explicitly repeats it against the configured Firebase project. The live command
creates its own temporary anonymous identities/channels and removes them afterward; it does not send prompts to
agents or read real workspaces. Both runs compare the previous full-text/per-progress-workspace-refresh behavior
with the optimized path, retaining echoed-write responses in the baseline. The decoded reply must match exactly.

On November 6, 2026, the live run measured **1,271,901 → 73,612 downloaded application bytes**, a **94.21% reduction**,
and **632,975 → 69,880 uploaded bytes**. The workload was eight synthetic workspaces, a 4,160-byte initial reply,
and thirty 520-byte appends: sixty seconds of progress at two-second intervals, replayed without wall-clock delays.
Conversation refreshes were unchanged (31); workspace-list reads dropped from 31 to 2. Database HTTP/stream
requests dropped from 165 to 107, including pairing/setup; established streams stayed at two. The numbers describe
this workload, not a forecast for every user or a promise about monthly capacity.

The client keeps numeric `traffic` counters for database request bodies, response bodies and raw SSE chunks.
The desktop's current counters are included in the local `/api/phone` remote status and retained until another
enable/restart. They exclude phone-side traffic; the measurement command sums both endpoints. Counters never retain
tokens or message contents. Upload counters count submitted bodies (a failed connection may not transmit them).
Authentication, static Hosting downloads, HTTP headers, TLS and other protocol overhead are excluded, so these
figures are **not Firebase's billed downloads**. Use the Firebase usage dashboard for project-wide quota accounting.
The recorded live comparison is in `measurements/phone-traffic.json`.

## Manual acceptance check

Restart the local app, enable **Away from home**, scan, compare the number and approve the phone. Test using mobile
data with Wi-Fi disabled: saved conversations, prompt submission, live progress, Stop, a tool approval, and an agent
question. Switch away from the page and return, reload it, then remove the device on the computer. Check that
removal prevents further control and that local-network pairing still works independently. Do not treat emulator
checks as proof of actual iPhone Safari keyboard, cellular-network or OS background behaviour.
