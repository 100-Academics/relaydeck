# Relaydeck security

Relaydeck is a terminal control service for agent fleets. It is designed for **trusted private networks**: loopback by default, a LAN or a Tailscale mesh when multi-device. It is not designed to be exposed to the public internet.

## Threat model

| Asset | Protect against |
|---|---|
| Terminal control (launch / kill / PTY input) | Unauthenticated or foreign-network clients |
| Host key (controls all paired devices) | Loss or leakage |
| Device key (controls one device) | Loss or leakage |
| Agent key (coordination tools only, scoped to the agent's working directory) | Leakage into harness shells — see key handling below |
| Messages, tasks, activity, project memory | Unauthorized read/write via the API |

The routing boundary (launch and sync paths checked against each device's real workspace root, including symlinks) is a **routing boundary, not an OS sandbox**: launched harnesses execute with the device user's permissions. Use separate accounts or containers when isolation matters (see `docs/glow-up.md` §13, container-per-agent).

## Key hierarchy

| Key | Scope | Stored |
|---|---|---|
| Host key | All devices, pairing, tool controls | Hashed in `.relaydeck/relaydeck.sqlite`; shown once |
| Device key | One device's runner + GUI sign-in | Hashed; shown once at pairing; regenerable by the host |
| Agent key | Coordination tools + sync in that agent's working directory | Hashed; delivered to the harness only as per-process env |

Invariants:

- Host and device keys are **never** passed to harnesses.
- Agent keys arrive as per-process environment (`RELAYDECK_AGENT_TOKEN`); each launched process receives its own identity. Do not share one agent key between concurrent processes.
- Tokens in per-terminal env for Git forges (e.g. `FORGEJO_TOKEN`, `GITEA_TOKEN`) are acceptable on a LAN-only fleet: the agent can see them but cannot use them off-network. Still: redact in logs, never echo in the GUI.
- The credential proxy (glow-up §9) is the long-term home for anything more sensitive: credentials live outside the agent's environment and are injected into outgoing requests by the proxy.

## Transport options (in preference order)

1. **Loopback** (default) — `http://127.0.0.1:4317`. Best.
2. **Tailscale mesh (recommended for multi-device)** — no port forwarding, no public exposure, stable per-device identity on the mesh. Connect the runner to the host's mesh IP. This is how the reference fleet runs it, and the recommendation for anyone connecting more than one device.
3. **LAN + optional HTTPS reverse proxy** — plain `http://` on a trusted LAN is fine for all core features. Browser notifications and PWA install additionally require a secure context: serve the GUI through a reverse proxy that supports WebSockets and sets `X-Forwarded-Proto`. A self-signed certificate (e.g. step-ca / ACME) is acceptable at this trust level — a public domain is not required.

**Discouraged:** port-forwarding the relaydeck port to the public internet. An unencrypted terminal control service should not be public, and a Tailscale mesh removes the need for forwarding entirely.

## What's out of scope (by design)

- Multi-tenant isolation between unrelated users — this is a fleet shell, not a SaaS.
- OS-level sandboxing of harnesses — use separate accounts or containers if you need it.
- End-to-end encryption of terminal streams beyond the TLS you deploy at the edge.

## Key compromise response

1. Regenerate the affected key — the host can regenerate any device key; agent keys are per-process and rotate with the next launch.
2. Review the activity feed for the window in question.
3. If the host key leaked, rotate it and re-pair devices (pairings are preserved per device key; re-pairing is per device).
