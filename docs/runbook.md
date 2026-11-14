# Runbook

Operational steps for running, inspecting and recovering the controller. All
commands run from the repository root.

## Prerequisites

- Node.js **20.11 or newer** (developed on Node 24) and npm
- A Linux-like shell
- For live runs only: a loopback game adapter and an authorized Minecraft
  server. The live LiquidBounce/Baritone adapter is not included; see
  [live-adapter.md](live-adapter.md).

## 1. Install and verify the toolchain

```bash
npm ci
npm run check
```

`npm run check` runs, in order:

1. `npm run typecheck` — `tsc --noEmit`
2. `npm test` — Vitest, 8 files
3. `npm run build` — emit `dist/` and mark `dist/cli.js` executable

Use `npm install` instead of `npm ci` only when you intentionally change
dependencies.

## 2. Validate the environment

```bash
npm run doctor
# or, after a build / npm link:
node dist/cli.js doctor
```

Doctor checks:

| Check | Passes when |
| --- | --- |
| `node` | Node is at least 20.11. |
| `config` | The config parses and rejects unknown keys. |
| `adapter-url` | URL is `ws://` or `wss://` and loopback (unless explicitly allowed). |
| `server-whitelist` | `127.0.0.1:25565` is allowed by the configured whitelist. |
| `state-dir` | The state directory exists or can be created and written. |
| `kill-switch` | The STOP file is absent. |
| `simulator` | A snapshot can be produced from the configured scenario. |
| `qwen` | Only checked in Qwen mode; unreachable is a warning because fallback exists. |

Use `--json` for machine-readable output. Logs go to stderr in JSON mode, so
stdout stays parseable.

## 3. Run the deterministic simulation

```bash
npm run simulate
# or with overrides:
npm run simulate -- --state-dir ./state --scenario default --seed 42
```

Expected shape of a passing default run:

```text
run:        run-...-...
result:     OK (declared gear checkpoint verified)
actions:    180/180 succeeded, 0 failed, 0 retries
reflexes:   0
economy:    240 earned, 207 spent, 265 trades, 33 emeralds held
gear:       verified (7/7)
checkpoint: /.../state/checkpoint-....json
```

Exact numbers depend on the seed, scenario, village distance and configuration.
The run is virtual-time based and normally completes in well under a second of
wall-clock time.

Useful scenarios:

| Scenario | Purpose |
| --- | --- |
| `default` | Normal daylight start, healthy bot, stocked village. |
| `hostile-night` | Night start, low health/food, nearby zombies; exercises reflexes. |
| `scarce` | Reduced resources; exercises recovery and bounded retries. |

Budget overrides are available: `--max-actions <n>` and `--max-minutes <n>`.

## 4. Exercise the real WebSocket boundary

The in-process simulator does not use sockets. To test the wire protocol, start
the adapter server and point the controller at it in two terminals.

**Terminal A — adapter server:**

```bash
npm run build
node dist/cli.js adapter-sim --port 8765
```

It prints:

```text
adapter-sim listening on ws://127.0.0.1:8765/adapter
whitelist if needed: 127.0.0.1:25565
```

**Terminal B — controller:**

```bash
MCBOT_ADAPTER_URL=ws://127.0.0.1:8765/adapter \
  node dist/cli.js run --fresh --state-dir ./state-ws
```

`run` connects to `adapter.url` (default `ws://127.0.0.1:8765`), performs the
handshake, reads snapshots and executes actions over the real protocol. The
simulated server reports `127.0.0.1:25565`, which the default whitelist allows.

Notes:

- `adapter-sim` accepts `--scenario`, `--seed`, `--village-distance` and
  `--config`.
- `run --fresh` ignores `controller-state.json`; omit it to resume.
- Both commands stop cleanly on Ctrl+C / SIGTERM.
- `adapter-sim --port 0` picks a free port; use that URL in
  `MCBOT_ADAPTER_URL`.

Before running a live adapter, validate the wire contract without driving the
bot:

```bash
node dist/cli.js conformance --url ws://127.0.0.1:8765/adapter
```

It checks handshake, required capabilities, ping, snapshot, one short `wait`,
cancel acknowledgement, duplicate hello, pre-handshake rejection, protocol
mismatch, invalid JSON, unknown messages and oversized frames. Exit code 2
means at least one check failed. `--timeout-ms` adjusts the per-check timeout.

## 5. Inspect evidence

Default state directory is `./state`.

```bash
node dist/cli.js verify  --state-dir ./state
node dist/cli.js inspect --state-dir ./state --notes 12
node dist/cli.js replay  --state-dir ./state --limit 20
```

- `verify` reads the newest `checkpoint*.json`, validates its schema and
  checksum, and re-verifies the gear against `config.gear.checklist`. Use
  `--checkpoint-checklist` to verify against the checklist stored in the
  checkpoint instead of the current config.
- `inspect` summarizes the checkpoint, village, economy, gear, notes, event
  counts and report summary. It defaults to the event log and report paths
  recorded in the checkpoint; override with `--events` and `--report` if files
  moved.
- `replay` validates the JSONL event log and prints event counts and recent
  action results without re-executing anything. Timestamp regressions exit with
  code 2.

All three accept `--json`.

## 6. Resume

Controller state is written after every action.

- `run` resumes by default when `controller-state.json` exists.
- `run --fresh` starts a new run id and ignores the file.
- `simulate` starts fresh unless you pass `--resume`.

Resume restores the controller's phase, task state, metrics, ledger, notes and
settlement flag. It does **not** recreate the world. A live adapter must report
the same world state; a fresh simulator starts clean, so resuming a simulator
run after completion will typically execute the checkpoint again from the new
world.

If a run was stopped deliberately, inspect the report and notes before
resuming. If the state is corrupt, move it aside rather than editing it:

```bash
mkdir -p state-backup
mv state/controller-state.json state-backup/
```

## 7. Stop safely

There are three independent stop paths:

1. **Kill-switch file** — create the configured file (default `./STOP`). The
   controller checks it before every action and at the top of each loop, then
   runs the safe-stop path: `stop` action, checkpoint, state, report, close.
2. **Signals** — Ctrl+C or SIGTERM on `run` calls `controller.stop()`, which
   aborts the active action and takes the same safe-stop path.
3. **Budgets** — `run.maxActions` or `run.maxMinutes` exhaustion triggers safe
   stop. `run.maxActions` is cumulative for the persisted run; `run.maxMinutes`
   is per controller invocation, so a stopped run resumes with a fresh time
   budget.

```bash
touch STOP      # request stop
rm STOP         # allow the next run to start
```

Doctor warns while the file exists.

## 8. Regenerate schemas

```bash
npm run schema
```

This rewrites `schemas/protocol.schema.json` with `Action`, `ClientMessage`,
`ServerMessage`, `Snapshot`, `Config`, `Checkpoint`, `RunState` and
`EventRecord` definitions. Commit the regenerated file with protocol changes.

## 9. Optional Qwen planner

The default is deterministic and requires no model. To enable the local planner:

```bash
MCBOT_PLANNER_MODE=qwen \
MCBOT_QWEN_BASE_URL=http://127.0.0.1:11434/v1 \
MCBOT_QWEN_MODEL=qwen2.5:14b-instruct \
npm run simulate
```

If the endpoint uses an API key, put the key in the environment variable named
by `planner.qwen.apiKeyEnv` (default `QWEN_API_KEY`). Do not put secrets in
config files, checkpoints or logs.

The model only chooses a goal. Timeouts, invalid output and three consecutive
failures fall back to the deterministic policy. `doctor` checks `/models` in
Qwen mode.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command succeeded (run reached a verified checkpoint, doctor passed, evidence valid). |
| `1` | Configuration, protocol, filesystem or command error. |
| `2` | Run completed but the checkpoint is incomplete, verification failed, or replay found timestamp regressions. |

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `adapter connect timed out` / `ECONNREFUSED` | No adapter listening, wrong URL/port. | Start `adapter-sim` or the live adapter; check `MCBOT_ADAPTER_URL`. |
| `adapter ... is not loopback` | Remote URL without opt-in. | Use loopback, or explicitly set `guardrails.allowRemoteAdapter` only for a trusted host. |
| `adapter did not report a server address` | Live adapter omitted `server` in `hello_ack`. | Fix the adapter; do not disable the whitelist casually. |
| `server ... is not in guardrails.serverWhitelist` | Address/port not allowed. | Add the exact host:port to the whitelist after confirming authorization. |
| `kill switch file exists` | `STOP` exists. | Remove it when it is safe to continue. |
| `action budget ... exhausted` | `run.maxActions` reached. | Inspect state/report; raise the budget only intentionally. |
| `time budget ... exhausted` | `run.maxMinutes` reached. | Same. |
| `no viable village found ...` | Exploration cap too small or bad scenario. | Increase `exploration.maxDistanceBlocks`/`maxWaypoints` or adjust seed. |
| `book reroll cap ... reached` | Librarian offers never covered the checklist. | Raise `gear.maxBookRerolls`, inspect trades, or retry. |
| `checkpoint not found` | No run in that state directory. | Pass `--state-dir`/`--checkpoint`, or run a simulation. |
| `checkpoint checksum mismatch` | File edited or corrupted. | Do not trust it; rerun or use an earlier checkpoint. |
| `event log line N is invalid` | Truncated/edited JSONL. | Inspect the line; preserve the rest before regenerating evidence. |
| `model planner failed; using deterministic policy` | Qwen unavailable or returned invalid JSON. | Expected fallback; fix the endpoint if model planning is required. |
| JSON output polluted by logs | `--json` not used. | Add `--json`; logs then go to stderr. |

## Clean state

Only do this when you intentionally want to discard evidence:

```bash
rm -rf state state-ws
rm -f STOP
```

The controller never deletes state on its own. Checkpoints are additive and
named by run id.
