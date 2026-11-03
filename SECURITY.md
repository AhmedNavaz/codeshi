# Security policy

Codeshi runs coding agents against your local files, so security reports are taken seriously.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue. Include what is affected, how to reproduce it and the impact you expect. You should receive a reply within a few days.

## How Codeshi is meant to be safe

- The local server listens on `127.0.0.1` only and rejects other hosts and cross-origin requests. The desktop app also requires a per-launch access token.
- Agents run through the official Claude Code and Codex CLIs with their own sign-in. Codeshi ships no API keys and never copies provider credentials.
- Tool approvals support two explicit policies: **Ask for permission** (the default) and **Full auto-approval**. Policies are scoped strictly to the workspace and cannot be imported from shared conversations. Read-only mode retains its native access restrictions and forbids full auto-approval. When auto-approval is enabled in edit mode, tool actions are executed without manual prompts while remaining visible in conversation activity and run status.
- Git reads disable hooks, filesystem monitors, external diff programs, text converters and filter drivers.
- Shared files (exports, friend requests) are reviewed before they leave your machine. Secret scanning helps, but it cannot guarantee that nothing sensitive is included.

Reports that bypass any of these are especially welcome.
