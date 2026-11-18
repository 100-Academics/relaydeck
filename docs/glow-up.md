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
  - **Secret agent:** hidden from other agents' `agents` results; can watch the last N tool calls of other agents (N configurable); can control other CLIs (input injection / restart — see decision point D2); pings agents signed **"An anonymous source"** when it catches an error; produces a full situation summary for the humans.
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
  - **Labeling:** the human DM channel is currently "Host inbox" (`web/main.js` channel picker); rename it to **"Human (host)"** and make the agent-side inbox explicitly an *agents* inbox in UI copy and docs. The human is a participant and helper, not the recipient of agent traffic.
  - **Pinned messages:** `pin` / `unpin` bridge tools + GUI pin action. Pinned items are always included in every `inbox` response and in the session skill — persistent reminders (project conventions, "do not touch X").
  - **Questions channel:** a first-class `question` kind, separate from messages:
    - An agent posts a question → the run can end (or the agent keeps working); the question appears in the GUI as a pending card.
    - The answer arrives as an inbox event; a new run resumes the saved session with the answer.
    - While a question is pending, the agent continues to process other inbox events — it is never blocked.
  - **Browser notifications:** Web Notifications API for the human when: a question is pending, an agent mentions the human, an agent finishes a task or errors.
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
  - **Editing existing agents and devices:** rename, reassign device, change role/assignment after creation (agent startup editing exists; device rename is new). *"gc" in the feedback most plausibly means agents (or group chats) — confirm with the host before implementing (D5).*
- Acceptance: every pane that shows agent output also shows its device; a renamed device keeps working without re-pairing.

## 11. A2A (agent-to-agent protocol) — P2

> "look into a2a (agent to agent protocal)"

- Spike: map the relaydeck bridge tools onto the [A2A protocol](https://a2a-protocol.org) (agent cards, tasks) so external A2A agents can join the same inbox. Decision point D1: adopt A2A as an additional transport behind the existing store, or stop at mapping.

## 12. New harnesses: `pi` and `omp` — P1

> "also like native support for pi/omp"

- First-class startup presets (executable, arguments, injection path) for the `pi` and `omp` CLIs, held to the same bar as Antigravity in the harness table of the README. Decision point D3: pin the exact CLIs and versions.

## 13. Deployment — P2

> - "we could set it more as server use and run it all inside like containers? like I assume you could make like fake directories somehow"
> - "for the server specifically. being able to be run in docker would be super nice"
> - "desktop (like hermes desktop) interface looking thing would be way way way nicer. idk how that would fare with steaming the stuff kind of though?"
> - "more relaydeck frames/slider (for more/not internet constrained devices)."

- Spec:
  - **Docker:** an official Dockerfile for the host (PTY workers in-container; document constraints and the `--data` volume).
  - **Container per agent:** optional mode where each agent runs in its own container with a bind-mounted workspace (the "fake directories") — the routing boundary in `README.md` (Storage and trust) becomes a real sandbox in this mode.
  - **Desktop app:** evaluate a Tauri/Electron wrapper over the existing WS UI (decision point D4); verify the WebSocket replay/streaming holds up outside a browser.
  - **Bandwidth slider:** a frame-rate/quality control for the terminal stream for low-bandwidth devices, with automatic degradation on high RTT.

## 14. Forgejo integration depth — P1

> "I would also like to see a little more integration with forgejo (i can also add features to forgejo if needed ig)."

- PRs, issues, and reviews: read in the GUI, read/write through bridge tools; the arbiter merges PRs (§6); `sync queue` in §6.
- Keep the client thin — upstream missing features to Forgejo rather than forking behavior.

## Decision points (need the host's call)

| # | Question | Default if unanswered |
|---|---|---|
| D1 | A2A: full transport, or mapping spike only? | Mapping spike (§11) |
| D2 | Secret agent CLI control: input injection only, or kill/restart too? | Input injection only |
| D3 | `pi` / `omp`: which exact CLIs and versions? | Latest stable of each |
| D4 | Desktop: Tauri or Electron? | Tauri (smaller runtime) |
| D5 | Does "edit existing gc" mean agents, or group chats/rooms? | Both, if cheap |

## Recently shipped — verify, don't rebuild

- Host can regenerate device keys — merged 2026-11-18 (branch `issue-2-regenerate-device-tokens`).
- Host can remove connected devices — merged 2026-11-18 (branch `issue-1-remove-connected-devices`).
- Independent verification and follow-up fixes: `docs/device-prs-verification-2026-11-18.md`.
