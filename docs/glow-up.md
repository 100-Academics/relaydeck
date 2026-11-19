# Relaydeck glow-up — complete overhaul spec

Compiled 2026-11-18 from DMs with people who run relaydeck in their fleets, collected after it failed them in production. This is the spec for the next major release: every item is either a requirement or an explicit decision point. Duplicates in the original feedback are merged.

Reading guide: **P0** = fleet blocker, **P1** = core overhaul, **P2** = stretch. Items marked *shipped* landed 2026-11-18 and only need verification (see `docs/device-prs-verification-2026-11-18.md`). The working checklist lives in [`todo.md`](../todo.md) under "Glow-up backlog".

## 0. Transport: CLI-first, MCP optional — P0

> "no mcp. all cli based."

- Current: the CLI bridge already works for every harness (`RELAYDECK_BRIDGE`, `--call`); MCP is an optional extra.
- Spec:
  - The CLI bridge is the **only required transport**. No documented flow or GUI path may depend on MCP configuration.
  - "Connect tools" (MCP) moves to an optional/advanced section of the README and GUI.
  - `skills/relaydeck-chat` stays valid for any harness with a shell tool.
- Acceptance: a fresh agent on each supported harness lists agents, sends a message, and reads its inbox using **only** the CLI bridge, with zero MCP setup.

## 1. Notification delivery into CLIs — P0

> "should be able to inject notifications into cli's by default + workarounds for those that do not support it."

- Spec: a per-harness **delivery ladder**, applied automatically:
  1. Inbox appended to bridge tool responses (existing default) — works everywhere the CLI is used.
  2. Terminal input injection for harnesses that safely queue prompts (existing opt-in).
  3. Pinned instruction file: session skill tells the agent to re-read a file before each task; the host rewrites it when something arrives.
  4. GUI "unread" badge so a human sees the backlog even if the agent never reads it.
- The agent's delivery mode must be visible and editable in the GUI (today it is a small select buried in Startup settings).
- Acceptance: a message sent to an idle agent appears in its next tool response or terminal prompt within a few seconds (add a test).

## 2. Harness visibility in the terminal — P0

> "antigravity works great always visible. Hermes is usually visible but sometimes scrolling is limited so you cant figure out if the agent is actually doing anything. Codex is usually mostly visible (some parts occasionaly are not). Opencode is the worst, usually does not laod correctly and cannot see anything most of the time."

- Spec:
  - **OpenCode rendering fix:** identify why its TUI usually does not render (PTY size, alternate screen, resize handling) and fix it; add a per-harness render smoke test that asserts visible output for a known command.
  - **Active/idle indicator:** per-terminal "agent working / idle" state derived from PTY output cadence, always visible in the terminal header — a human must be able to tell at a glance whether the agent is doing something.
  - **Hermes scrollback:** terminal buffers (currently 150k chars in memory) should be queryable over the WS API for scroll-back, not only live-streamed; fix the cases where history is lost on reconnect.
  - Codex: audit the partially-invisible regions and align the fix with the OpenCode one.
- Acceptance: `npm run test:ui` passes for every harness preset (Antigravity, OpenCode, Codex, Hermes, Custom).

## 3. Harness watchdogs / timers — P1

> "better way to make timers for harnesses like opencode so they dont frick up ***** computer."

- Spec:
  - Per-harness watchdog: a "running" agent with no PTY output for N minutes (per-harness default, configurable) gets a **stalled** badge; GUI offers kill / restart.
  - Optional hard timeout per launch (kill after M minutes of no output).
  - Where the OS allows: CPU/RAM caps for known heavy harnesses (cgroups on Linux, process limits on Windows).
- Acceptance: a hung OpenCode process is flagged within 2 minutes and restartable from the GUI.

## 4. Instruction injection reliability — P0

> "instructions being put into agent was A) worked sometimes. even on the same harnesses it would only work like hafl the time. B) would be better if it was just like an environment variable or something that agents had like auto injceted as a skill."

- Spec:
  - **One deterministic mechanism:** a session skill file + `RELAYDECK_INSTRUCTIONS` env var. Per-harness adapters are thin wrappers that only set that variable/flag — no other path.
  - No adapter may rewrite a harness's global config or project instruction files.
  - Every launch records which injection path was used and whether it succeeded (for diagnostics).
  - Smoke test: a launched agent's first turn references the relaydeck skill; assert per harness in `test:ui`.
- Acceptance: instruction injection succeeds 100% across 10 consecutive launches per harness (no more "half the time").

## 5. Roles & orchestration — P1

> "assigned roles. The Arbiter is the cheif orchestrator. The compiler is an optional agent role in case some machines cannot compile. The worker does not plan, only implements teh arbiters work. I should be able to assign workers/compilres to specific arbiters if needed. Another optional role is the secret agent. other agents cannot see they are there, but they watch (ideally last n tool calls of an agent. can control cli's. and can ping agents from 'An anonymous source' if they catch an error while doing this, summarize everything thats going on to the humans."

- Spec:
  - Role field on agents: `arbiter` | `worker` | `compiler` | `secret` | (default: unassigned).
  - **Arbiter:** plans, decomposes, assigns work, opens PRs, merges PRs.
  - **Worker:** implements only, does not plan. Host can link workers to a specific arbiter (worker → arbiter assignment in the GUI).
  - **Compiler:** optional; receives build/test tasks from workers when a machine cannot compile.
  - **Secret agent:** hidden from other agents' `agents` results; can watch the last N tool calls of other agents (N configurable); **controlling a CLI means messaging it as the user** — it posts into an agent's inbox such that the agent cannot tell the message came from the secret agent rather than the normal human (sender identity is the host/human); separately, it can ping agents signed **"An anonymous source"** when it catches an error; produces a full situation summary for the humans.
  - Role-specific onboarding text (the session skill gets a role section).
- Acceptance: a worker sees only its arbiter's assignments; a secret agent's pings carry the anonymous signature; other agents cannot list the secret agent.

## 6. Repository sync: branch- and PR-first — P1

> - "repository sync should be more focused around branches and merging them. All merging should branch based."
> - "branch management. agents LOVE creating branches to not conflict. but they end up leaving branches abandoned and unmerged, even when they should have been merged (and were supposed to be)."
> - "I think part of the way they do this is by actually opening pr's and the arbiter merges… cause rn they just made branches but would 'merge' instead of actually opening prs and merging the human way"
> - "I also think this makes it easier to see what is in the queue so agents dont forget what they need to look at"
> - "if this needs an access token you could easily just put it in the env of each terminal. even if they do see it its not like they could do anythign with it anyway since its not exposed to the internet"

- Spec:
  - Sync config is **branch-first**: a base branch per repo; each agent works on its own branch.
  - **Merge flow = pull requests:** agents open PRs against base via the Forgejo/Gitea API; **only the arbiter (or the host) merges**. Direct merges to base are not offered as a bridge tool.
  - Token in the per-terminal env (`FORGEJO_TOKEN` / `GITEA_TOKEN`) is acceptable — the fleet is LAN-only and agents cannot do anything with it off-network. Still: redact in logs, never echo in the GUI, store hashed where possible.
  - **Branch ledger** in the GUI: every open branch with owner agent, age, PR state, last push. Branches with no push for X days are flagged **abandoned**; the owning agent gets a ping; the arbiter can close stale branches.
  - **Queue view:** open PRs/issues with assignees, visible in the GUI and through a `sync queue` bridge tool, so agents remember what is waiting on them.
  - Keep the Forgejo integration thin; if a feature is missing, upstream it (the host maintains a Forgejo instance and can add features there).
- Acceptance: end-to-end test — agent commits on a branch → PR opens → arbiter merges → both checkouts fast-forward; an abandoned branch is flagged in the ledger.

## 7. Inbox semantics — P1

> - "make it clear that this is the AGENTS inbox. not the USERS inbox."
> - "pinned messages that persist in inbox to remind agents"
> - Deferred-call pattern: "a hook can defer a tool call and wait for additional input from the user… the run ends and the session is saved mid-call… their answer comes back as an event in the inbox… while the deferred call waits for a response, the worker can pick up other events, so the agent isn't blocked." — "I would do something a little similar. where we have a seperate like question thing in our inbox."

- Spec:
  - **Labeling (positive phrasing):** the inbox is labeled **"The Agents inbox"** — not "not the users inbox". Negatives read as dismissive; state what it *is*. The human is a participant who gets pulled in, not the owner of the mailbox. Rename the "Host inbox" channel (`web/main.js`) to **"Human (host)"**.
  - **"You have mail" relay:** when an agent receives something that needs the human (a question, a mention, a stuck task), the agent relays it to the human in its own voice — "yo, you have mail — <one-line summary>" — defined in the session skill. The host surfaces the same event as a notification (next bullet), so the human is covered whether or not they're watching the agent.
  - **Pinned messages:** `pin` / `unpin` bridge tools + GUI pin action. Pinned items are always included in every `inbox` response and in the session skill — persistent reminders (project conventions, "do not touch X").
  - **Questions channel:** a first-class `question` kind, separate from messages:
    - An agent posts a question → the run can end (or the agent keeps working); the question appears in the GUI as a pending card.
    - The answer arrives as an inbox event; a new run resumes the saved session with the answer.
    - While a question is pending, the agent continues to process other inbox events — it is never blocked.
  - **Browser notifications:** Web Notifications API for the human when: a question is pending, an agent mentions the human, an agent finishes a task or errors. **HTTP stays fully functional** — notifications and PWA install are the *only* features that need a secure context: `http://127.0.0.1` / `localhost` qualifies, a LAN `http://HOST:4317` does not, and the fix is the optional HTTPS reverse proxy (a self-signed cert via step-ca/ACME is fine — this is LAN-only, no domain required). Over plain HTTP the UI detects the missing secure context and hides the notification affordances instead of failing.
- Acceptance: a pending question survives a host restart; answering it resumes the session; the human gets a browser notification without the tab focused.

## 8. Memory & artifacts — P1

> - "project memory is definitly needed"
> - "keep track of what the agents make so its easy to delete it all later"
> - "should be clear that human is there to help + playtest"

- Spec:
  - **Project memory:** a durable per-project notes store in the relaydeck host; injected into every session skill; `remember` / `memory` bridge tools; viewable and editable in the GUI.
  - **Artifact ledger:** agents declare what they create (files, directories, services, ports) via an `artifact` bridge tool; the GUI lists artifacts per project; host-only one-click "remove all agent artifacts" with a preview of the deletion list.
  - **Human role line** in onboarding: "The human is here to help and to playtest — welcome their input, test with them, and report what you built."
- Acceptance: a session that `remember`s a fact sees it in the next session's skill; removing all artifacts deletes exactly the declared set and nothing else (tested).

## 9. Environment & secrets — P1

> - "being able to set env variables"
> - Credential proxy: "The recommended pattern is a proxy outside the agent's environment that adds credentials to outgoing requests. The agent sends requests without credentials, and the proxy injects the real credentials before forwarding."

- Spec:
  - **Env editor:** per-agent `KEY=VALUE` list in Startup settings (stored in the host, injected at launch, masked in the GUI). Today env can only be inherited from the runner process.
  - **Credential proxy:** a local proxy outside the agent's environment injects credentials into outgoing requests; the agent sends credential-less requests. v1 target: a per-agent forward proxy with credential injection for named services (Forgejo, LLM endpoints), selected in the GUI. The proxy authenticates the agent by its existing agent identity.
  - Invariant to keep: host and device keys are never passed to harnesses.
- Acceptance: an agent authenticates to Forgejo through the proxy with no token visible in its shell env.

## 10. Devices & fleet clarity — P1

> - "Should be clear what computer they are on + other agents are on."
> - "be able to edit existing gc and devices."
> - "host should be able to regenerate device keys for other devices in case they lost it or something."

- *Shipped (verify):* host regenerates device keys and removes devices — merged 2026-11-18 (`issue-1-remove-connected-devices`, `issue-2-regenerate-device-tokens`); see `docs/device-prs-verification-2026-11-18.md`.
- Spec:
  - **Device visibility:** a device chip on every message, activity entry, and agent row; terminal headers already show the device — extend to the conversation and activity panes so a human always knows *which computer* produced what.
  - **Editing existing group chats (confirmed: "gc" = group chat):** add or remove agents from an existing room after creation, host-only, from the GUI and via bridge tools.
  - **Editing existing devices:** rename and reassign after creation (key regeneration is shipped; renaming is new).
- Acceptance: every pane that shows agent output also shows its device; a renamed device keeps working without re-pairing.

## 11. A2A (agent-to-agent protocol) — P1 (researched 2026-11-19)

> "look into a2a (agent to agent protocal)" — host follow-up: "look up the A2A protocal since I think it could be helpful in communication."

Research (from the [A2A spec v1.0](https://a2a-protocol.org/latest/specification/), Linux Foundation):
- A2A is the open agent↔agent protocol — MCP connects agents to tools, A2A connects agents to agents; the project's own guidance is "use both." Three bindings: **JSON-RPC 2.0 over HTTP(S) with SSE streaming** (the simplest, and relaydeck is already Express + WS), gRPC, and HTTP+JSON.
- Core objects: **AgentCard** (self-describing manifest — identity, capabilities, skills, security schemes — published at `/.well-known/agent-card.json`), **Task** (lifecycle `submitted → working → input-required / completed / canceled / failed`, with artifacts and history), **Message** (role + Parts: text/file/data).
- Methods: `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask` (SSE), plus **task push-notification configs** (the server POSTs to your webhook when task state changes).
- Official SDKs for the whole relaydeck stack: `@a2a-js/sdk` (Node), `a2a-sdk` (Python), Go/Java/C#/Rust. Plus an **A2A CLI + agent skill** (`winget install a2aproject.a2acli`) that lets any coding agent discover, message, and delegate to A2A agents — the same skill+CLI pattern relaydeck already uses.

Mapping to relaydeck (this is the design, not just a spike):

| A2A | Relaydeck |
|---|---|
| AgentCard | Per-agent card served by the host: name, role (§5), harness, device, skills = bridge tools; `securitySchemes` = the agent's bearer key |
| `SendMessage` | Inject into the agent's inbox / terminal through the existing delivery ladder (§1) |
| Task lifecycle | The agent's run; `working` while its PTY is active (§2 active/idle) |
| **`input-required`** | **The questions channel (§7)** — "task needs input" *is* the deferred-call pattern, made protocol-standard |
| Push notification config | The "yo, you have mail" relay (§7) as a webhook → host relays to the human/browser |
| `GetTask` / `ListTasks` | `task` + `activity` bridge tools, feeding the §6 queue view |

Phases:
1. **Map & expose (P1):** the host serves `/.well-known/agent-card.json` per agent and implements the JSON-RPC binding (`SendMessage`, `GetTask`, `ListTasks`, push-notification configs) over the existing Express app — via `@a2a-js/sdk` or the raw binding.
2. **Consume (P1):** external A2A agents can message relaydeck agents through the standard, no relaydeck CLI required; the A2A CLI + skill is the turnkey client for other stacks on this machine.
3. **A2A peers (P2):** relaydeck agents hold tasks *with* external A2A agents (delegation), tracked in the same queue view.

- Acceptance: an external A2A client (the A2A CLI) sends `SendMessage` to a relaydeck agent and receives its reply as the task result; posting a question flips the task to `input-required` and a configured push webhook fires.

## 12. New harnesses: `pi` and `omp` — P1

> "also like native support for pi/omp"

- **`pi`** — Mario Zechner's `pi`: "AI coding assistant with read, bash, edit, write tools" (v0.85.1 on this machine, npm global). Injection: `--append-system-prompt <text>`; one-shot: `-p`; output: `--mode text|json|rpc`; extensions: `pi install <source>`.
- **`omp`** — [oh-my-pi](https://github.com/can1357/oh-my-pi) (can1357): a coding-first fork of Pi — sessions, subagents, slash commands, extensions; all TypeScript, MIT (v18.18.3 on this machine, winget package `can1357.oh-my-pi`). Injection: `--append-system-prompt=<value>`; output: `--mode text|json|rpc|rpc-ui`; per-run overlays: `--config`.
- First-class startup presets for both, held to the same bar as Antigravity in the README harness table. Both expose `--append-system-prompt`, so the §4 deterministic injection path applies directly, and both speak `json`/`rpc` output modes for the §2 activity feed.

## 13. Deployment — P2

> - "we could set it more as server use and run it all inside like containers? like I assume you could make like fake directories somehow"
> - "for the server specifically. being able to be run in docker would be super nice"
> - "desktop (like hermes desktop) interface looking thing would be way way way nicer. idk how that would fare with steaming the stuff kind of though?"
> - "more relaydeck frames/slider (for more/not internet constrained devices)."

- Spec:
  - **Docker:** an official Dockerfile for the host (PTY workers in-container; document constraints and the `--data` volume).
  - **Container per agent:** optional mode where each agent runs in its own container with a bind-mounted workspace (the "fake directories") — the routing boundary in `README.md` (Storage and trust) becomes a real sandbox in this mode.
  - **Desktop-grade web UI (the actual ask):** the *web UI itself* should look and feel like a native desktop app, in the class of the Hermes desktop app — app chrome (sidebar rail, top bar, panels), fluid theming, no browser artifacts. That is a web-first job, not a wrapper job. PWA install (Web Install API — `<install>` / `navigator.install()`, with `beforeinstallprompt` fallback; see the `modern-web-guidance` skill) is a bonus on top, and a Tauri/Electron wrapper stays available as an option, not a prerequisite.
  - **Bandwidth slider:** a frame-rate/quality control for the terminal stream for low-bandwidth devices, with automatic degradation on high RTT.

## 14. Forgejo integration depth — P1

> "I would also like to see a little more integration with forgejo (i can also add features to forgejo if needed ig)."

- PRs, issues, and reviews: read in the GUI, read/write through bridge tools; the arbiter merges PRs (§6); `sync queue` in §6.
- Keep the client thin — upstream missing features to Forgejo rather than forking behavior.

## Decision points (all resolved)

| # | Question | Status |
|---|---|---|
| D1 | A2A: full transport or mapping spike? | **Resolved (researched):** adopt — expose the fleet as A2A servers + consume external A2A agents; the questions channel maps to `input-required`, "you have mail" to push-notification configs (§11) |
| D2 | What "control CLIs" means for the secret agent | **Resolved:** send messages into an agent's inbox *as the user* — indistinguishable from the real human (§5) |
| D3 | `pi` / `omp`: which CLIs and versions? | **Resolved:** `pi` 0.85.1 + `omp` (oh-my-pi) 18.18.3, both installed on this machine (§12) |
| D4 | Desktop approach | **Reframed:** the *web UI* goes desktop-grade (Hermes-desktop class) first; PWA install bonus; wrapper optional (§13) |
| D5 | "edit existing gc" | **Resolved:** group chats — adding agents to existing rooms (§10) |

## 15. Web UI standard (applies to every UI item in this spec)

All HTML/CSS/client-side JS work follows the **modern-web-guidance** skill (`D:\Dev2\.agents\skills\modern-web-guidance`): search the guidance corpus *before* implementing a pattern, retrieve the matching guide, and keep its fallbacks. Guides already scoped for this spec:

- `persistent-toast-notifications` — the "you have mail" toasts (§7): `popover="manual"`, a named notification region, `ariaNotify()` with an `aria-live` fallback.
- `install-web-app` — PWA install (§13): `<install>` / `navigator.install()` with the `beforeinstallprompt` fallback; manifest with a stable `id`.
- `local-network-access` — GUI on LAN/loopback: LNA permission gating applies to cross-origin requests into more-private address spaces (a same-origin LAN GUI is unaffected); the secure-context requirement is what forces HTTPS for LAN notifications/PWA.
- `dialog` / `light-dismiss-a-dialog` — question cards and confirmations (§6, §7).

## 16. Networking & security posture — P1

> Host: "security wise theres no port forwarding, the way me and the boys did it was tailscale."

- **Transport ladder, in preference order:**
  1. **Loopback** (default) — single machine, `http://127.0.0.1:4317`.
  2. **Tailscale mesh (recommended for multi-device)** — no port forwarding, no public exposure, stable per-device identity on the mesh. This is how the reference fleet runs it; document it as the recommended way to connect devices.
  3. **LAN + optional HTTPS reverse proxy** — plain `http://` on a trusted LAN is fine for all core features; only browser notifications and PWA install additionally need the secure context (self-signed via step-ca/ACME is acceptable).
- **Explicitly discouraged:** port-forwarding the relaydeck port to the internet — an unencrypted terminal control service should not be public (already in README "Storage and trust"); Tailscale removes the need entirely.
- Full threat model, key hierarchy, and token handling live in [`SECURITY.md`](../SECURITY.md) (new in this PR), referenced from the README.

## Recently shipped — verify, don't rebuild

- Host can regenerate device keys — merged 2026-11-18 (branch `issue-2-regenerate-device-tokens`).
- Host can remove connected devices — merged 2026-11-18 (branch `issue-1-remove-connected-devices`).
- Independent verification and follow-up fixes: `docs/device-prs-verification-2026-11-18.md`.
