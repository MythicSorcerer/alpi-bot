# Architecture

This document describes how the controller is put together, where the safety
boundaries sit, and how a run turns observations into actions and evidence.

## Design goals

- **Player-like, not admin-like.** The controller only uses bounded actions a
  survival player could perform: walk, collect, craft, eat, sleep, trade,
  enchant, equip, fight and flee.
- **Narrow game boundary.** All game access goes through the `GameAdapter`
  interface. A deterministic in-process simulator and a loopback WebSocket
  adapter implement the same interface.
- **Deterministic core.** Survival reflexes, task state, budgets, persistence
  and success checks are ordinary TypeScript. The optional Qwen planner can
  only choose one of six goals; it cannot emit actions, code, shell commands or
  chat.
- **Evidence first.** Every run writes resumable state, periodic checkpoints, a
  final report and an append-only JSONL event log.

## Process topology

```text
┌─────────────────────────────────────────────────────────────────────┐
│ mcbot process                                                       │
│                                                                     │
│  CLI (src/cli.ts)                                                   │
│    │                                                                │
│    ▼                                                                │
│  BotController (src/controller/controller.ts)                       │
│    ├─ ReflexLayer        urgent, model-free safety                  │
│    ├─ Planner            deterministic policy or local Qwen         │
│    ├─ Tasks              explore / settle / economy / gear          │
│    ├─ RunState           resumable controller bookkeeping           │
│    └─ Evidence           checkpoint, report, events.jsonl           │
│         │                                                           │
│         ▼                                                           │
│  GameAdapter (src/adapter/types.ts)                                 │
│    ├─ SimulatedGame      in-process, deterministic                  │
│    └─ WsGameClient       loopback WebSocket protocol                │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
             WebSocket adapter protocol (docs/protocol.md)
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
     GameAdapterServer                 future live adapter
     (simulator over WS)               (LiquidBounce + Baritone)
```

The controller always runs in one Node.js process and executes actions
sequentially. The adapter server allows at most one active action per server,
which keeps state transitions easy to reason about and to replay.

## Module map

| Path | Responsibility |
| --- | --- |
| `src/config.ts` | Zod config schema, defaults, gear checklist. |
| `src/config-file.ts` | YAML/JSON loading plus supported environment overrides. |
| `src/guardrails.ts` | Loopback policy, server whitelist, action bounds, kill switch. |
| `src/protocol/types.ts` | Versioned wire schemas, action union, snapshots, result/error codes. |
| `src/adapter/types.ts` | `GameAdapter` interface and `AdapterError`. |
| `src/adapter/ws-client.ts` | Controller-side WebSocket client: handshake, request correlation, timeouts, cancellation, reconnect. |
| `src/adapter/ws-server.ts` | Adapter-side WebSocket server: schema validation, rate/size limits, one active action, event broadcast. |
| `src/adapter/conformance.ts` | Raw-probe adapter conformance checks used by `mcbot conformance` and tests. |
| `src/controller/controller.ts` | Run loop, budgets, goal selection, checkpoints, ledger, metrics, report, safe stop. |
| `src/controller/reflex.ts` | Model-free survival rules evaluated before ordinary actions. |
| `src/controller/tasks.ts` | Explore, settle, economy and gear task state machines. |
| `src/controller/state.ts` | Metrics, trade ledger and resumable run state. |
| `src/planner/planner.ts` | Deterministic goal policy, Qwen OpenAI-compatible planner, fallback, response parser. |
| `src/gear/checklist.ts` | Gear lookup, enchantment checks, remaining needs, equip-slot mapping. |
| `src/persistence/checkpoint.ts` | Checkpoint schema, construction, SHA-256 checksum, read/verify. |
| `src/persistence/event-log.ts` | JSONL event log, one-file rotation, atomic writes. |
| `src/sim/simulator.ts` | Deterministic Minecraft-like world and action engine. |
| `src/sim/trades.ts` | Simulated villagers, offers, restock and reroll behaviour. |
| `src/sim/recipes.ts` | Minimal crafting recipes used by the economy. |
| `src/sim/rng.ts` | Seeded PRNG. |
| `src/util/*` | Redaction, inventory helpers, vectors, sleep. |
| `src/cli.ts` | `simulate`, `run`, `adapter-sim`, `doctor`, `verify`, `inspect`, `replay`, `schema`. |
| `src/index.ts` | Public library exports. |

## Control loop

`BotController.run()` performs the following:

1. Connect the adapter and validate the reported server against the whitelist.
2. Refresh a snapshot.
3. Loop:
   - check the action/time budgets and the kill-switch file;
   - refresh the snapshot;
   - verify the declared gear;
   - stop successfully only when gear is verified **and** the village is valid
     **and** settlement was recorded;
   - ask the planner for a goal;
   - override unsafe or contradictory planner choices;
   - run the task for that goal;
   - classify the result as `done`, `retry` or `failed`, with bounded retries
     and a bounded number of emerald/XP top-ups;
   - on success, mark settlement/economy completion and clear task state.
4. On any fatal error, abort the current action and perform a safe stop
   (`stop` action + checkpoint).
5. Always write final controller state, a final checkpoint when a snapshot
   exists, and `report.json`; close the adapter and return a summary.

Because the success condition requires both the gear and the settlement state,
a run cannot report success from a stale checkpoint after its world was reset.

### Goal selection

The deterministic policy is:

```text
no village observed            -> explore_village
village found, not settled     -> settle
gear verified                  -> verify_checkpoint
not enough emeralds budget     -> earn_emeralds
otherwise                      -> acquire_gear
```

The Qwen planner receives a compact JSON summary and may return only
`{"goal": "<one allowed goal>", "reason": "..."}`. The controller then applies
guard overrides:

- `verify_checkpoint` is refused while gear is incomplete.
- `done` is refused while gear is incomplete.
- `explore_village` is refused once a village is visible.

Invalid JSON, unknown goals, HTTP errors, timeouts and three consecutive
failures fall back to the deterministic policy. A planner outage therefore
cannot stall survival.

## Actions and reflexes

`TaskContext.act()` routes through `BotController.act()`:

1. Check budgets, abort signal and kill switch.
2. If reflexes are enabled, evaluate the current snapshot.
3. If a reflex decision exists, execute it first and count it as a reflex
   action.
4. Execute the requested action through the adapter.
5. Update failure streaks, metrics and the ledger.
6. Persist run state after every action and write a checkpoint every
   `run.checkpointEveryActions` executed actions.

Reflex priority is fixed:

| Condition | Response |
| --- | --- |
| Dead (`health <= 0`) | Wait one second for adapter respawn. |
| Drowning (`inWater` and `air < 40`) | `surface`. |
| Below `reflex.voidY` | Navigate back to `y=64`. |
| Hostile within `hostileRadius`, low health or no mainhand | `flee`. |
| Hostile within attack range and combat is safe | `attack`. |
| Food at or below `lowFood` with food in inventory | Eat the best available food. |
| Low health with high food and no threat | Wait for natural regeneration. |
| Night, reachable bed, no threat, not sleeping | Sleep. |
| `stuckAfterFailures` consecutive failures | `stop`. |

Reflexes do not require the planner or network access beyond the adapter.

## Tasks

### `ExploreTask`

Builds a persisted frontier of up to `exploration.maxWaypoints` waypoints in
eight directions, spaced by `exploration.stepBlocks`, capped at
`exploration.maxDistanceBlocks`. Each waypoint is a bounded `navigate` action.
Three navigation failures fail the task; a visible valid village short-circuits
to arrival.

### `SettleTask`

Validates the village population, navigates to its centre, and sleeps in a
nearby bed at night when no spawn point is set. Settlement is recorded only
after this task completes.

### `EconomyTask`

Uses the MVP legal loop: a fletcher's stick-to-emerald trade.

- Finds a visible fletcher, approaches and inspects trades.
- Gathers logs, crafts planks and sticks as needed.
- Trades in batches bounded by `economy.tradeActionBatch`, remaining uses and
  the emerald target.
- Waits for restock when the offer is exhausted, bounded by
  `economy.maxRestocks`.
- Drops low-value junk or excess materials when the inventory is full.
- Returns a `need_emeralds`/`need_xp` signal instead of silently overspending.

### `GearTask`

1. Buys each missing base item from any visible villager that offers it.
2. Buys plain books and needed enchanted books from librarians, rerolling
   within `gear.maxBookRerolls`.
3. Applies books with `apply_book`, returning an XP top-up request when the
   adapter reports `LOW_XP`.
4. Equips armour and tools, then verifies the exact checklist.

The controller funds shortfalls by temporarily raising the emerald goal, with
at most eight top-ups per run.

## Simulator

`SimulatedGame` is a deterministic, in-memory world:

- seeded PRNG (`run.seed`), virtual ticks of 50 ms;
- a village placed at `simulation.villageDistance` on the X axis;
- generated villagers, workstations, beds, trees and optional hostiles;
- simplified movement, collection, crafting, eating, combat, sleeping,
  enchanting and villager trade mechanics;
- `default`, `hostile-night` and `scarce` scenarios;
- a simulated server label of `127.0.0.1:25565`, Minecraft `1.21.4`,
  software `simulated`.

It models the player-visible affordances the controller needs, not vanilla
block physics or exact trade NBT. Simulator results are controller evidence,
not proof that a live server behaves identically.

## Persistence and evidence

All paths are relative to `persistence.dir` unless configured otherwise:

| File | Contents |
| --- | --- |
| `controller-state.json` | Schema-versioned run state: phase, task state, metrics, ledger, notes, settlement, budgets used. |
| `checkpoint-<runId>.json` | Snapshot, gear verification, checklist, ledger, resume hints and evidence paths plus SHA-256 checksum. |
| `report.json` | Final summary: result, timings, metrics, ledger totals, gear, village, planner decision, budget, environment. |
| `events.jsonl` | Append-only structured evidence (`run.created`, task transitions, plan decisions, reflex actions, every action result, notes). |
| `events.jsonl.1` | One rotated log when `persistence.maxEventFileBytes` is exceeded. |

Writes use a temporary file plus rename so a crash does not leave a partially
written JSON document. Event data is redacted before it reaches disk.

## Failure handling

- Adapter errors are typed (`AdapterError`) and may be retryable.
- Action failures use stable codes, not message matching.
- A retryable snapshot failure triggers one reconnect attempt.
- A retryable action error triggers a reconnect and snapshot refresh, then the
  action result is reported as `NOT_CONNECTED`.
- Task failures are bounded (three failed attempts, four non-converging
  retries); emerald/XP top-ups are bounded to eight.
- Budget exhaustion, kill switch and operator abort all take the safe-stop path.
- A checkpoint failure is logged but does not discard the run.

## Extension points

- Implement `GameAdapter` to drive a different game backend.
- Implement `Planner` to use another local model while keeping the goal-only
  contract.
- Provide another `AdapterBackend` to `GameAdapterServer` for protocol tests.
- Add checklist entries or optional items in configuration; the gear task and
  verifier use the configured list.

See [protocol.md](protocol.md) for the wire contract, [runbook.md](runbook.md)
for operations and [live-adapter.md](live-adapter.md) for the missing live
LiquidBounce/Baritone side.
