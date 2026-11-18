# Device management PRs — verification & fixes (2026-11-18)

Two PRs were reviewed by an agent, then **independently re-verified against the
code and by executing them**, and fixed before merging.

- `issue-1-remove-connected-devices` (remove connected devices)
- `issue-2-regenerate-device-tokens` (regenerate device keys)

Both are now merged into `main` (merge commits `4704ed2`, `fdbbc99`).

## Method

Every claim was checked two ways: reading the actual diff/code on the branch,
and **running the real system** (live host on a random port, real WebSocket
runner or raw `ws` client, real PTY harness via `node-pty`, restart the host
and re-read the SQLite workspace). The check scripts were throwaway
`repro-pr1.mjs` / `repro-pr2.mjs`; the durable equivalents now live in `test/`
and fail without the fixes (verified: the strengthened `devices.test.js`
assertion fails on the pre-fix `store.js`).

## PR 2 — regenerate device tokens (verified: 3/3 claims real, fixed)

| # | Claim | Verdict | Evidence |
|---|-------|---------|----------|
| 1 | Activity entry never persisted | **Real** | Entry in memory before restart, gone after host restart (repro). `store.activity()` doesn't save; handler never called `store.save()`. |
| 2 | Agent processes orphaned | **Real** | Real PTY harness (pid file) still alive 10s after regenerate (repro). Close code 4003 path in `runner.js` returns without terminating workers; handler sent no `stop`. |
| 3 | Web sessions stay valid | **Real** | Cookie signed in with old key got `200` on `/api/state` after regenerate (repro). Sessions map is never pruned by device. |
| 4 | Stale GUI state | **Real (code)** | `regenerateDevice` branch never re-fetched `/state` (unlike remove). UI-level: covered by refresh + ui-smoke render, no dedicated click test. |

**Fixes** (commit `262cae8`): stop agents before closing the runner socket;
`store.save()` after activity; revoke `role === 'device'` sessions for that
device; GUI re-fetches state + toast; 3 new server-level tests in
`test/device-regenerate.test.js`.

## PR 1 — remove connected devices (verified: 5/5 claims real, fixed)

| # | Claim | Verdict | Evidence |
|---|-------|---------|----------|
| 1 | Crash on removing a connected device | **Real** | DELETE returned `200`, then `TypeError: Cannot set properties of undefined (setting 'online')` in the ws close handler — exact message predicted (repro). |
| 2 | Room history wiped | **Real** | Host group notice "Keep this room" deleted by the recipients-based filter (repro). |
| 3 | Test masked the bug | **Real** | Old suite green (21/21) while the notice was deleted; strengthened assertion fails on pre-fix `store.js`. |
| 4 | Overzealous council deletion | **Real** | Host council across two devices: `councils before=1 after=0` (repro). |
| 5 | Stale base branch | **Real** | `merge-base(main, issue-1) = 76f7276` ≠ `eaf46d4`; missed the Antigravity commit. |

**Fixes** (commit `a276c70`, rebased as `e1ae20d` + `a276c70`): DELETE now
collects agent ids, removes the device, revokes its sessions, settles pending
syncs, then sends `stop` per agent and drops the runner registration **before**
closing the socket (close handler can no longer bookkeep a gone device).
`store.removeDevice` keeps group room history and councils with surviving
members (prunes participants), drops only what the removed device/agents sent
or what was addressed to them. `test/devices.test.js` strengthened (fails
pre-fix); new `test/device-remove.test.js` covers crash + session + process
stop.

## Integration conflict (verified: real, resolved)

Both PRs edited the same two spots in `web/main.js` (device card button slot,
click-handler selector line). Resolved by keeping **both** buttons (Regenerate
then Remove) and both handler branches. Rebase onto `main` confirmed no other
conflicts; full suite green on the result.

## What was NOT tried / left as-is

- No Playwright click-through test for the two new buttons (ui-smoke renders
  the Devices page with both and asserts zero browser errors; buttons follow
  the existing `data-*` pattern already exercised by the smoke test).
- Admin (host-key) sessions are intentionally **not** revoked on
  remove/regenerate — only device-key sessions.
- `runner.js` 4003 close path still just logs (no auto `process.exit`); the
  server now always tells it to stop first, so workers are reaped.
- `dist/` rebuilt; screenshots re-rendered during ui-smoke show ±0.1% pixel
  variance only (not part of these changes) — reverted.

## Reproduce

```
npm test            # 28/28 on main
npm run build       # vite build
npm run test:ui     # playwright smoke (needs chromium; present on this box)
```

Key tests: `test/device-regenerate.test.js`, `test/device-remove.test.js`,
`test/devices.test.js`, `test/device-token.test.js`.
