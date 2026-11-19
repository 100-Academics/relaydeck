## What this slice does (glow-up spec §10 — devices & fleet clarity)

When you run agents on several machines, the workspace used to blur them together: you could not tell which computer a message or tool call came from, and the room roster was frozen at creation. This slice makes the fleet legible and host-editable.

**Fleet clarity**
- Every message and activity row now shows a **device chip** (monitor icon + computer name) naming the machine that produced it — `web/main.js` `actorDevice()`/`deviceChip()`, styled in `web/style.css` + `web/dark.css`.
- Agents are mapped to their host device (`agent.deviceId`), so a notice from an agent running on "Studio" chips "Studio", not just the agent name.

**Host control of the fleet** (new endpoints, human keys only)
- `POST /api/devices/:id/rename` — admin renames any device; a device can rename itself (self-service). Existing keys keep working; activity is logged.
- `POST /api/groups/:id` — admin renames a group room and adds/removes agent members. The Team room's membership is locked ("The Team room includes every agent; membership cannot be edited.").
- `store.renameDevice()` / `store.updateGroup()` enforce the roles; `store.tools` gains `room_update`, also callable from the bridge.

**GUI**
- "Edit room" button appears in the conversation picker when you are the host and looking at a group room — rename the room and manage membership in one dialog.
- "Rename" button on each device card (host: any device; a device: itself) — the pairing key and all existing sign-ins survive the rename (asserted in the UI smoke).

## Tests
- `test/fleet.test.js` (new): rename + key survival, Team-room lock, membership add/remove, agent-role rejection — **1/1 pass**.
- `scripts/ui-smoke.mjs`: agent-sent notice renders a device chip naming the device; room rename through the Edit room dialog; device rename through the GUI with the key still authenticating — **UI smoke green**.
- Full suite: **29 tests / 29 pass / 0 fail** (one onboarding PTY test flaked once under parallel load; passes standalone and in the final full run).

## Notes for review
- `editGroupSlot()` re-renders the picker button live when the conversation changes (launching an agent switches the channel, which previously hid the button until a full re-render).
- The channel-picker select is confined (`max-width: calc(100% - 110px)`) so the Edit room button stays clickable — Playwright's hit-testing caught the original overlap.
- Branches off `main` (MCP still present here; `room_update` rides on the existing bridge definition list). PR #13 removes MCP separately — the two touch `src/bridge.js` in different spots and should merge cleanly.
