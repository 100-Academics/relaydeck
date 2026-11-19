# Agent Communication Tool

This should be a shell for agent harnesses: users run Hermes, OpenCode, or other existing harnesses/CLIs inside this application rather than launching each one separately. Multiple agents across multiple devices should be able to communicate with each other, regardless of which harness each agent uses.

- [x] Agents can announce their current task.
- [x] Agents can DM other agents using the MCP or CLI bridge.
- [x] Two message types: notice and message.
- [x] Append new messages to bridge tool responses, with an unanswered tag until the recipient replies with a message or notice. Optional terminal input delivery is available for compatible harnesses.
- [x] Notices do not require an answer.
- [x] Group rooms broadcast notices to all members.
- [x] A persistent host coordinates agents across device runners.
- [x] Forgejo/Gitea repository sync with status, fast-forward pull, and non-force push.
- [x] Humans can view terminals, reported tool activity, and message boards.
- [x] Humans can send messages and notices.
- [x] Council tool requests other agents' implementation recommendations.
- [x] All coordination tools can be enabled or disabled on the host.
- [x] Run installed harnesses/CLIs inside embedded terminals.
- [x] Shared communication across harnesses and devices.
- [x] Host and clients each support GUI and headless operation.

- [x] Bundled agent chat skill with automatic startup guidance for supported harnesses.
- [x] Edit startup commands and instructions for existing agents from host and client GUIs.
- [x] Agents discover rooms and read recent conversation through bridge tools.

## Glow-up backlog (2026-11-18 — fleet feedback)

Full spec and rationale: `docs/glow-up.md`. Do P0 first.

- [ ] CLI-first transport: no flow requires MCP; MCP moves to optional (§0)
- [ ] Notification delivery ladder into CLIs + per-agent delivery visible in GUI (§1)
- [ ] Fix OpenCode terminal rendering + per-harness render smoke test (§2)
- [ ] Active/idle indicator per terminal; Hermes scrollback queryable (§2)
- [ ] Harness watchdogs: stalled badge, kill/restart, resource caps (§3)
- [ ] Deterministic instruction injection (env + skill only); record path per launch (§4)
- [ ] Roles: arbiter / worker / compiler / secret (send-as-user) + worker→arbiter assignment (§5)
- [ ] Branch-first sync; PR-based merges by arbiter; token in terminal env (§6)
- [ ] Branch ledger: abandoned-branch detection + owner ping (§6)
- [ ] PR/issue queue view in GUI + `sync queue` bridge tool (§6)
- [ ] "The Agents inbox" labeling (positive phrasing, no negatives) + agent "yo, you have mail" relay (§7)
- [ ] Pinned messages: tools + GUI + always in inbox context (§7)
- [ ] Questions channel: pending cards, resume session on answer, non-blocking (§7)
- [ ] Browser notifications for questions / mentions / completions (§7)
- [ ] Project memory store + `remember` tools + GUI editor (§8)
- [ ] Artifact ledger + one-click "remove all agent artifacts" (§8)
- [ ] Human role line in onboarding: here to help + playtest (§8)
- [ ] Per-agent env editor in Startup settings (§9)
- [ ] Credential proxy: injects credentials outside the agent's env (§9)
- [ ] Device chip on messages/activity; edit existing group chats (add agents) + devices (§10)
- [ ] A2A protocol spike (§11)
- [ ] Native `pi` (0.85.1) + `omp`/oh-my-pi (18.18.3) presets; `--append-system-prompt` injection (§12)
- [ ] Docker image for the host (§13)
- [ ] Container-per-agent option ("fake directories") (§13)
- [ ] PWA install (Web Install API) first; Tauri/Electron only if it falls short (§13)
- [ ] Bandwidth/frames slider for the terminal stream (§13)
- [ ] Forgejo depth: PR/issue/review read + arbiter merge action (§14)
- [ ] Follow modern-web-guidance for all UI work (toast / dialog / install / LNA guides) (§15)
- [ ] Verify shipped: device key regen + device removal (`docs/device-prs-verification-2026-11-18.md`) (§10)

Supported harnesses receive instructions to use the authenticated CLI bridge; MCP configuration is optional. Custom harnesses can use the provided skill manually. Arbitrary terminal programs do not provide a universal context-injection API. See README.md for setup, delivery behavior, and deployment verification limits.
