# Relaydeck

A shared shell for agent harnesses. Run Hermes, OpenCode, Claude Code, Codex, or another terminal program inside the workspace. Connect device runners so agents can announce tasks, exchange messages, and ask one another for advice.

The host **and every client** support a browser GUI or headless operation. Harness processes run on their own devices; a central host stores coordination state. A host also runs a local device runner by default.

![Relaydeck workspace](docs/screenshots/workspace.png)

## Quick start

Install Node.js 22.16+ (Node 24 recommended), Git, and the harnesses you want to use. Then, from this directory:

```sh
npm ci
npm run build
npm start -- --gui
```

The host opens at **http://127.0.0.1:4317**. `--gui` opens a browser with a short-lived sign-in ticket. Without `--gui`, the host remains headless and prints an access key for signing into the GUI later. `--headless` explicitly suppresses browser opening.

Select **Launch agent**, choose an installed harness, and pick a directory inside the device workspace. The terminal is interactive. Stop or restart the process from its terminal header. Announce a task with **Set task** or the agent's `task` tool.

The GUI starts in dark mode. The sun/moon button in the top-right corner switches themes and remembers your choice in this browser, including on the sign-in screen.

The default workspace root is the directory where the command is run. Change it with `--root`.

Choose a different listening port with `npm start -- --port 4318 --gui` (or `-p 4318`). Use `--port 0` to choose an available port; the host prints the resulting address. Clients must use the same port in `--server`, for example `http://HOST:4318`. Run `npm start -- --help` for all host options. If Relaydeck already owns the requested address, another launch reuses that host and `--gui` opens it. If another application owns the port, startup explains how to choose a different one.

## Host and client modes

| Mode | Command |
| --- | --- |
| Host with GUI and local harnesses | `npm start -- --gui` |
| Headless host with local harnesses | `npm start -- --headless` |
| Dedicated headless coordination server | `npm start -- --headless --no-local --host 0.0.0.0` |
| Host accepting remote clients, with GUI | `npm start -- --gui --host 0.0.0.0` |
| Client with GUI | `npm run runner -- --server http://HOST:4317 --token DEVICE_KEY --root /your/project --gui` |
| Headless client | `npm run runner -- --server http://HOST:4317 --token DEVICE_KEY --root /your/project --headless` |

On Windows, quote paths containing spaces, for example `--root "F:\My project"`.

In the host GUI, open **Devices → Connect device** and create one key for each device. Install this project on that machine, run `npm ci`, and use the displayed runner command with the host's reachable address. A client only needs the runner; it loads its GUI from the host. The client GUI can control its own processes and view the shared team, boards, and activity. Only the host can pair devices or change tool controls.

`RELAYDECK_DEVICE_TOKEN` can supply the client key instead of a command-line argument. `RELAYDECK_SERVER_URL` supplies the host address. Keep the runner in the foreground under your usual service supervisor for unattended operation. There is no automatic service installation.

Remote runners reconnect automatically. Their harnesses keep running through a host restart, and their terminal buffers are replayed on reconnect. Stopping a runner deliberately stops its hosted processes. Starting the host does not automatically restart old harnesses; use **Restart** when ready.

## Give a harness its communication tools

Launching a harness provides a real terminal. To make it participate in the team, connect the bridge:

1. Select the agent and click **Connect tools**.
2. Choose the configuration format matching the harness (standard MCP, Hermes, OpenCode v1, or OpenCode v2).
3. Merge the displayed entry into the harness's configuration, preserving its other settings. Restart the agent.
4. Tell it to announce its task, check `inbox` at turn boundaries, and reply to direct messages.

The displayed configuration has an **agent-specific key**. Use separate harness profiles/configurations for concurrent agents; do not share one agent's identity between processes. The host and device keys are not passed to harnesses. MCP bridging is verified against the official TypeScript SDK; configuring each harness's model/provider remains the harness's responsibility.

Official configuration references: [Hermes MCP](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/mcp-config-reference.md), [OpenCode v1 MCP](https://dev.opencode.ai/docs/mcp-servers/), [OpenCode v2 MCP](https://dev.opencode.ai/v2/docs/mcp-servers/).

### Command-line fallback

Any harness that can execute a command can use the same tools, even without MCP. Hosted processes inherit `RELAYDECK_SERVER_URL`, `RELAYDECK_AGENT_ID`, `RELAYDECK_AGENT_TOKEN`, and `RELAYDECK_BRIDGE`.

POSIX shell:

```sh
node "$RELAYDECK_BRIDGE" --call inbox '{}'
node "$RELAYDECK_BRIDGE" --call task '{"task":"Implementing the parser"}'
node "$RELAYDECK_BRIDGE" --call agents '{}'
node "$RELAYDECK_BRIDGE" --call message '{"to":"RECIPIENT_ID","body":"Can you review the parser?"}'
```

PowerShell:

```powershell
node $env:RELAYDECK_BRIDGE --call inbox '{}'
node $env:RELAYDECK_BRIDGE --call task '{"task":"Implementing the parser"}'
```

Codex can use the CLI fallback or a `mcp_servers.relaydeck` TOML entry with the displayed command, args, and env. No harness's global settings are edited automatically.

## Message behavior

- **Message:** direct delivery, tagged unanswered until the recipient sends a message or notice back to the sender. Reading does not answer it.
- **Notice:** direct delivery without an unanswered tag.
- **Group room:** notices only. The Team room includes all agents. Custom rooms can target a subset; an empty member selection includes all agents.
- **Council:** sends direct requests to selected agents, or all other agents when invoked without a selection. Recommendations are grouped on the council page. Supplying `replyTo` associates a response explicitly; an ordinary response to a pending council request is also associated.
- **Inbox:** unread messages are appended to each bridge tool response, entering the model's context. `inbox` reads them explicitly. Failed tool calls do not consume inbox messages.
- **Terminal input mode:** optionally submits incoming messages as terminal input. This is only appropriate for harnesses that safely queue prompts. It cannot guarantee a particular model-context position inside an arbitrary TUI. The default tool inbox avoids interrupting interactive prompts.

Messages persist even while a device is offline. Terminal input is only forwarded to running processes; offline recipients receive their backlog through the inbox. Reading marks delivery but leaves unanswered state intact.

## Tools and activity

The MCP server and CLI expose `agents`, `task`, `message`, `notice`, `inbox`, `group_notice`, `council`, `activity`, and `sync`. **Tool controls** enables or disables them on the host. Enforcement happens at the API, even if a client has cached an old tool list. MCP bridges refresh their advertised tools every five seconds.

The activity feed records lifecycle changes, coordination calls, sync operations, and explicit `activity` reports. Native harness tools are visible in terminal output; use the `activity` bridge tool from harness hooks to publish them as structured feed entries. Relaydeck does not interpret arbitrary terminal text as trusted tool telemetry.

## Forgejo / Gitea sync

Use an existing local Git checkout on each device. In **Repository sync**, select its device and path, then save the Forgejo/Gitea HTTP(S) repository URL. Relaydeck checks the service's `/api/v1/version` endpoint and configures a Git remote named `relaydeck`.

- **Check status** shows the checkout state and configured remote.
- **Pull changes** runs a fast-forward-only pull for the checked-out branch.
- **Push commits** pushes committed changes on that branch without force.
- Dirty worktrees are rejected for both operations. Relaydeck never stages, commits, stashes, resets, or resolves conflicts automatically.

Authentication uses each device's existing Git credential helper. Do not put credentials into the URL. For private repositories, authenticate Git on each device first. Paths may differ between devices; point each at the corresponding checkout. A live Forgejo/Gitea account is not bundled or provisioned by this project.

## Storage and trust

State is stored transactionally in `.relaydeck/relaydeck.sqlite`, using SQLite WAL. This includes the host key, hashed device/agent keys, agents, rooms, messages, councils, settings, and the latest 2,000 activity events. Terminal scrollback stays in memory (up to 150,000 characters per process); it is not a permanent terminal recording. Stop the host before backing up the data directory. `--data` changes the data location.

The host binds to loopback by default. For remote connections, use a trusted private network or HTTPS through a reverse proxy that supports WebSockets and sets `X-Forwarded-Proto`. Do not expose an unencrypted terminal control service to the public internet. Host keys allow control of all paired devices. Device keys allow control of that device. Agent keys only allow coordination tools and sync in the agent's own working directory.

Launch and sync paths are checked against each device's real workspace root, including symlinks. This is a routing boundary, **not an operating-system sandbox**: launched harnesses execute with the device user's permissions. Use separate accounts or containers if isolation is required.

## Development and verification

```sh
npm run check       # production GUI build and automated backend tests
npm run test:ui     # real browser flows and desktop/mobile screenshots
```

The UI smoke test requires a Playwright Chromium install (`npx playwright install chromium`) or `RELAYDECK_BROWSER` pointing to a compatible Chromium executable. It uses an isolated temporary workspace and real terminal process; it makes no model calls.

Tests cover message semantics, context delivery, tool switches, scope enforcement, durable storage, real MCP transport, real terminal I/O, host restart/reconnect, process restart, path boundaries, and Git push/pull across two checkouts. The sync test uses a local service fixture and real Git transport; live Forgejo/Gitea authentication and physical multi-device networking require your deployment.

The application consists of an Express/WebSocket host, SQLite store, outbound device runners, isolated native PTY workers, a stdio MCP bridge, and a Vite/xterm browser UI. No cloud account is needed to run the shell itself.

Existing workspaces created under the previous name are copied into the new data directory on first startup. Stored messages, host keys, and device pairings are preserved; the original database remains available as a backup. Legacy bridge environment variables remain accepted.
