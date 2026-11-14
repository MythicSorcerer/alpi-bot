# all-purpose-mc-bot

A player-like Minecraft bot controller built around a narrow, typed game adapter. The controller explores, survives, settles in a village, runs a legal villager economy, buys and enchants a declared diamond kit, verifies the result, and writes a checksummed checkpoint plus replayable evidence.

The repository ships with:

- a deterministic, in-memory Minecraft-like simulator;
- a real WebSocket implementation of the controller ↔ adapter protocol;
- survival reflexes that never depend on a model;
- an optional local Qwen planner that can only choose a bounded goal;
- checkpoint/resume, event logs, JSON reports and CLI inspection tools.

> **Status.** The controller, protocol, simulator, economy and checkpoint are implemented and tested end to end in simulation. A live LiquidBounce/Baritone Java add-on is **not** included: the exact LiquidBounce and server versions were not available to build and validate against. The WebSocket boundary and adapter contract are implemented; the live side is documented in [docs/live-adapter.md](docs/live-adapter.md).

## MVP checkpoint

All seven required items must be present, equipped where applicable, and carry at least these enchantments:

| Item | Enchantments |
| --- | --- |
| Diamond helmet | Protection IV, Unbreaking III |
| Diamond chestplate | Protection IV, Unbreaking III |
| Diamond leggings | Protection IV, Unbreaking III |
| Diamond boots | Protection IV, Unbreaking III, Feather Falling IV |
| Diamond sword | Sharpness V, Unbreaking III |
| Diamond pickaxe | Efficiency V, Unbreaking III |
| Diamond axe | Efficiency V, Unbreaking III |

Mending, Fortune and other useful enchants are intentionally outside the first checkpoint. The checklist lives in `src/config.ts` and can be overridden in configuration.

## Quick start

Requirements: Node.js **20.11+** (developed on Node 24), npm, and a Linux-like shell.

```bash
npm ci
npm run check                 # typecheck + tests + build
npm run doctor                # config, guardrails, simulator, state directory
npm run simulate -- --state-dir ./state
```

The simulation completes in well under a second of wall-clock time because game ticks are deterministic and virtual. A representative default run:

```text
result:     OK (declared gear checkpoint verified)
actions:    180/180 succeeded, 0 failed, 0 retries
economy:    240 earned, 207 spent, 265 trades, 33 emeralds held
gear:       verified (7/7)
```

Inspect the evidence:

```bash
npx tsx src/cli.ts verify  --state-dir ./state
npx tsx src/cli.ts inspect --state-dir ./state --notes 8
npx tsx src/cli.ts replay  --state-dir ./state --limit 5
```

After `npm run build`, use the compiled CLI directly or install the package:

```bash
node dist/cli.js verify --state-dir ./state
npm link
mcbot doctor
```

## Commands

| Command | Purpose |
| --- | --- |
| `mcbot simulate` | Run the complete controller against the in-process deterministic simulator. |
| `mcbot run` | Run against a live loopback WebSocket adapter (`adapter.url`). |
| `mcbot adapter-sim` | Serve the simulator over the real adapter protocol; useful for protocol work. |
| `mcbot conformance` | Probe a loopback adapter's handshake, capabilities, malformed-message handling and safety without running the bot. |
| `mcbot doctor` | Validate config, URL policy, whitelist, state directory, kill switch, simulator and Qwen reachability. |
| `mcbot verify` | Validate a checkpoint's SHA-256 checksum and its declared gear. |
| `mcbot inspect` | Summarize a checkpoint, event log and report. |
| `mcbot replay` | Validate and summarize a JSONL evidence log without re-executing actions. |
| `mcbot schema` | Generate JSON Schema for the protocol, config and persistence records. |

Useful flags: `--config <yaml|json>`, `--state-dir <path>`, `--json`, `--log-level <level>`, `--scenario default|hostile-night|scarce`, `--seed <n>`, `--village-distance <blocks>`, `--max-actions <n>`, `--resume`, and for `conformance`: `--url <ws://...>`, `--timeout-ms <n>`.

## How a run works

```text
Qwen (optional, goal only) ──┐
                             ▼
                    deterministic controller
                     │        │         │
             survival reflexes │   task state machine
                     │        │         │
                     └────────┴─────────┘
                              │ typed actions / snapshots
                              ▼
                 loopback WebSocket adapter protocol
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
        deterministic simulator      live game adapter
                                     (LiquidBounce + Baritone)
```

1. **Explore.** A persisted frontier of bounded waypoints searches up to `exploration.maxDistanceBlocks`.
2. **Settle.** A village is validated by population, beds and workstations; the bot approaches it and sleeps when possible to set a spawn point.
3. **Earn.** The fletcher's stick → emerald trade is scaled in batches, with wood gathering, stick crafting, restocking and inventory management.
4. **Buy.** Armorer, toolsmith and weaponsmith offers supply the base diamond kit.
5. **Enchant.** Librarian offers are inspected and rerolled only when useful; plain books and enchanted books are bought, then applied with anvil-like XP costs.
6. **Verify.** The exact item/enchantment checklist is checked against inventory and equipment, then a checkpoint, report and JSONL event log are written.

Survival reflexes run before ordinary actions: respawn wait, surface/void recovery, hostile flee/fight, eating, regeneration, safe nighttime sleep, and stuck-stop. They work with the planner disabled or unreachable.

## Safety baseline

- Adapters must bind and be reached over loopback unless `guardrails.allowRemoteAdapter` is explicitly enabled.
- The live server address must match `guardrails.serverWhitelist` (host and port, wildcard subdomains supported).
- Exploit/cheat mode is always refused; the project never uses flight, phase, anti-cheat bypasses or duplication.
- Chat is outside the control path; the model cannot emit actions, shell commands or chat.
- Actions are schema-validated, timeout-bounded, budget-bounded, and rate-bounded for live runs.
- A `STOP` file (configurable) aborts before the next action and triggers a safe stop.
- Logs and checkpoints redact tokens, API keys, passwords and authorization values.

Read [docs/safety.md](docs/safety.md) before pointing this at any server. Only use worlds and servers you own or have explicit permission to test.

## Simulation vs live

| Area | Simulator | Live adapter |
| --- | --- | --- |
| Minecraft version | pinned label `1.21.4`, modelled affordances only | must be pinned by the operator |
| Physics/pathfinding | deterministic distance/tick model | Baritone and the real server |
| Villagers/trades | simplified deterministic offers, restock after virtual ticks | real trade NBT and restock rules |
| Anti-cheat | none | Grim is a diagnostic, never a target to evade |
| Purpose | controller/regression testing | authorized integration testing |

The simulator is not evidence that a live server accepts the same trades or paths. Treat simulator results as controller evidence, then repeat against a pinned local server with an authorized account.

## Configuration

Start from [config/default.yaml](config/default.yaml). Unknown keys are rejected at every level. Environment variables cover the common overrides; see `.env.example` and [docs/configuration.md](docs/configuration.md).

Most important settings:

```yaml
adapter:
  url: ws://127.0.0.1:8765
guardrails:
  serverWhitelist: [127.0.0.1:25565, localhost:25565]
  killSwitchFile: ./STOP
economy:
  emeraldTarget: 240
planner:
  mode: deterministic   # or qwen
persistence:
  dir: ./state
```

### Optional local Qwen planner

```bash
MCBOT_PLANNER_MODE=qwen \
MCBOT_QWEN_BASE_URL=http://127.0.0.1:11434/v1 \
MCBOT_QWEN_MODEL=qwen2.5:14b-instruct \
npm run simulate
```

The model receives a compact state summary and may return only:

```json
{"goal":"earn_emeralds","reason":"the trade budget is not funded yet"}
```

Allowed goals: `explore_village`, `settle`, `earn_emeralds`, `acquire_gear`, `verify_checkpoint`, `done`. Invalid output, timeouts, HTTP errors and three consecutive failures fall back to the deterministic policy. The model never sees or emits an action.

## Evidence and persistence

```text
state/
├── controller-state.json              # resumable controller state
├── checkpoint-<runId>.json            # SHA-256 checksummed checkpoint
├── report.json                        # run summary and metrics
├── events.jsonl                       # append-only structured evidence
└── events.jsonl.1                     # one rotated log, when size-limited
```

The checkpoint records adapter/server versions, phase, snapshot, villagers, village, inventory, armor, mainhand, position, trade ledger, gear verification, checklist, resume hints and evidence paths. `readCheckpoint` rejects corrupted or modified files by checksum.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run schema                # regenerate schemas/protocol.schema.json
npm run check                 # all three main gates
```

The Vitest suite covers protocol validation, config/guardrails, simulator mechanics, economy, reflexes, planner fallback, checkpoint integrity, resume, in-process end-to-end execution, the same run over the loopback WebSocket protocol, and CLI smoke tests.

## Current limitations

- No LiquidBounce/Baritone add-on is built or validated; no real server or account was used.
- The simulator's economy is intentionally simplified and not a reproduction of vanilla trade mechanics.
- Only the MVP gear checkpoint is automated; the Nether, End and dragon fight are out of scope.
- Resuming uses `controller-state.json` plus the checkpoint. The live adapter must also restore or report the same world state; a fresh simulated world starts clean.
- There is no GUI or fabricated video evidence. Evidence is structured logs, reports and checkpoints.

See [docs/status.md](docs/status.md) for the milestone mapping, [docs/architecture.md](docs/architecture.md) for internals, [docs/protocol.md](docs/protocol.md) for the adapter contract and [docs/runbook.md](docs/runbook.md) for operations.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Components, control loop, tasks, reflexes, simulator, persistence. |
| [docs/protocol.md](docs/protocol.md) | WebSocket contract, messages, actions, snapshots, error codes. |
| [docs/runbook.md](docs/runbook.md) | Install, doctor, simulate, WebSocket smoke test, evidence, resume, troubleshooting. |
| [docs/live-adapter.md](docs/live-adapter.md) | The missing LiquidBounce/Baritone adapter: contract, mapping and validation plan. |
| [docs/safety.md](docs/safety.md) | Authorization, guardrails, budgets, kill switch, redaction, known gaps. |
| [docs/configuration.md](docs/configuration.md) | Every setting, its default, range and environment override. |
| [docs/status.md](docs/status.md) | Milestone status, verified evidence, limitations and next steps. |

## License

MIT. See [LICENSE](LICENSE).
