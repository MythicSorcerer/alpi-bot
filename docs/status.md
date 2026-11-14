# Status

Last updated: 2026-11-13 (local checkout). Version `0.1.0`.

## Summary

The controller, protocol, deterministic simulator, villager economy, gear
checkpoint, persistence and CLI are implemented and verified end to end in
simulation. A live LiquidBounce/Baritone adapter is **not implemented**, and no
real Minecraft client, account or server has been used. The simulator is the
honest scope of the current evidence.

```text
Implemented and verified in simulation:
  protocol + WebSocket boundary
  controller loop, budgets and safe stop
  survival reflexes
  exploration and settlement
  stick-trade emerald economy with restocking
  diamond gear purchase, librarian books, enchanting, equipping
  gear verification, SHA-256 checkpoint, ledger, metrics, report, event log
  deterministic and Qwen goal planners with fallback
  CLI: simulate, run, adapter-sim, doctor, verify, inspect, replay, schema

Not implemented or verified:
  live LiquidBounce/Baritone adapter
  real client/server/account integration
  vanilla-exact trade, pathfinding, enchanting or anti-cheat behaviour
  Nether/End/dragon phase
  video/replay footage and multi-run live reliability study
```

## Roadmap milestones

| Roadmap milestone | Status | Evidence / gap |
| --- | --- | --- |
| **M0 — Runtime and server baseline** | **Blocked** | No LiquidBounce installation, pinned versions, authorized account or server. No headless boot was attempted. |
| **M1 — Control architecture and observability** | **Done for the controller side** | Typed protocol, WebSocket client/server, controller, event log, checkpoints, mock/simulator harness, 43 tests. Live add-on side is the gap. |
| **M2 — Deterministic movement and survival primitives** | **Done in simulation** | Navigation, collect, mine, place, craft, eat, sleep, equip, drop, surface, attack, flee, stop, cancellation, timeouts, stuck-stop and survival reflexes. Live primitives depend on M0. |
| **M3 — Village discovery and settlement** | **Done in simulation** | Persisted frontier, bounded waypoints, village validation (population/beds/workstations), arrival, night sleep/spawn observation. |
| **M4 — First sustainable villager economy** | **Done in simulation (simplified)** | Fletcher stick→emerald loop, wood/plank/stick crafting, batching, restock waits, inventory cleanup, trade ledger. Breeding exists as an action but is not part of the default loop. |
| **M5 — Scalable emerald production** | **Partial** | Simulated run reaches the 240-emerald target in 265 trades. No farms, no live throughput measurement, no iron-farm decision. |
| **M6 — Villager progression, gear and enchantments** | **Done in simulation** | Base diamond items, librarian book offers/rerolls, anvil-like application, XP top-ups, equipping, exact 7-item verification, checksummed checkpoint and resume. Live item NBT not exercised. |
| **M7 — Reliability, evaluation and video evidence** | **Partial** | Metrics, event log, replay validation, regression tests and protocol e2e exist. No consecutive live runs, failure corpus from a real server, or footage. |
| **Later — Nether, End, dragon** | **Not started** | Explicitly out of MVP scope. |

## Verification performed

Commands run from the repository root:

```bash
npm run typecheck
npm test
npm run build
npm run schema
node dist/cli.js simulate --state-dir /tmp/opencode/mcbot-final
node dist/cli.js verify  --state-dir /tmp/opencode/mcbot-final
node dist/cli.js inspect --state-dir /tmp/opencode/mcbot-final
node dist/cli.js replay  --state-dir /tmp/opencode/mcbot-final
# plus adapter-sim + run over loopback WebSocket
```

| Gate | Result |
| --- | --- |
| `tsc --noEmit` | Pass. |
| Vitest | **43 tests / 8 files pass**, including in-process e2e, WebSocket e2e and CLI smoke. |
| Build | Pass; `dist/cli.js` is emitted with a shebang and executable bit. |
| JSON Schema | `schemas/protocol.schema.json` regenerated (148 KB; Action, ClientMessage, ServerMessage, Snapshot, Config, Checkpoint, RunState, EventRecord). |
| Doctor | Passes against the checked-in default config (Node, config, loopback URL, whitelist, state directory, kill switch, simulator, planner). |
| In-process simulation | **OK**: 180/180 actions, 0 failed, 0 retries, 240 emeralds earned, 207 spent, 265 trades, 15 books applied, 7/7 gear verified, ~87 ms wall clock. |
| WebSocket simulation | **OK**: 180/180 actions over real loopback sockets, 0 failed, 7/7 gear, checkpoint verified, ~0.7 s. |
| Checkpoint | SHA-256 checksum valid; gear re-verified from the saved snapshot; checklist matches config. |
| Evidence log | 240 JSONL records, 180 action results, 0 timestamp regressions on replay. |
| Resume | Controller state and checkpoint are reloadable; the in-process test resumes without losing the run id or action count. |

Representative default-run summary (`node dist/cli.js simulate`):

```text
result:     OK (declared gear checkpoint verified)
actions:    180/180 succeeded, 0 failed, 0 retries
reflexes:   9
economy:    240 earned, 207 spent, 265 trades, 33 emeralds held
gear:       verified (7/7)
```

These numbers are simulator evidence. They are deterministic for the default
seed and configuration, but they do not predict live throughput or trade
availability.

## Test coverage map

| File | Covers |
| --- | --- |
| `tests/protocol.test.ts` | Schema validation, action/timeout bounds, message parsing, protocol version. |
| `tests/config.test.ts` | Defaults, strict config rejection, loopback policy, whitelist matching, redaction, kill switch. |
| `tests/sim.test.ts` | Seeded reproducibility, snapshots, collection, crafting, village arrival, trade, stable error codes. |
| `tests/reflex.test.ts` | Death, drowning/void, hostile flee/attack, eating, regeneration, sleep, stuck stop. |
| `tests/planner.test.ts` | Deterministic goal policy, Qwen JSON parsing, invalid output and outage fallback. |
| `tests/persistence.test.ts` | Checkpoint build/save/read, checksum tamper rejection, ledger, event log, run state. |
| `tests/controller.e2e.test.ts` | Full in-process checkpoint run, evidence, resume, and the same run over the WebSocket protocol. |
| `tests/cli.test.ts` | Doctor, schema generation, simulate + verify CLI flow. |

## Key decisions

- **Simulator-first.** Build and verify the controller against a deterministic
  adapter before spending a live environment. The WebSocket path uses the same
  schemas and is tested over real sockets.
- **Goal-only model.** Qwen chooses one bounded goal; it cannot emit actions,
  code, shell commands or chat. Deterministic fallback is always active.
- **No exploits.** Stick trading is the MVP economy. No duplication, flight,
  phase or anti-cheat bypass is implemented or configurable on.
- **Pinned MVP gear.** Seven diamond items with a fixed enchantment checklist;
  Mending, Fortune and other upgrades are outside the checkpoint.
- **Evidence over assertions.** Checkpoints carry a SHA-256 checksum; the event
  log records every action result; `verify`/`inspect`/`replay` operate on the
  saved artifacts.
- **Simulation version label.** The simulated server reports Minecraft
  `1.21.4` and software `simulated`. This is a label for the model, not a live
  compatibility claim.

## Known limitations

- **No live adapter.** This is the largest gap. See
  [live-adapter.md](live-adapter.md).
- **No live environment evidence.** No account, server, LiquidBounce, Baritone,
  Java client or anti-cheat interaction was tested.
- **Simplified simulator.** Trade offers, restock, movement, combat, enchanting
  and villager progression are deterministic models, not vanilla mechanics.
- **Only the MVP checkpoint.** No Nether, End, dragon, farms or large builds.
- **Resume is controller-state resume.** The world is not reconstructed; a live
  adapter must report current world state and the operator must decide whether
  resuming is safe.
- **No visual evidence.** No screenshots, video or replay footage; evidence is
  structured logs, reports and checkpoints.
- **Some configuration is reserved.** `run.name`, `bot.owner`,
  `economy.maxRerolls`, `settlement.sleepAtNight` and
  `guardrails.allowChat` are validated and documented but not consumed by the
  current MVP tasks (`simulation.enabled` is only recorded in evidence). They
  are kept for planned behaviour and explicit policy, not silently ignored.
- **No git history.** The working directory is not a git repository; nothing
  has been committed or pushed.

## Next steps

1. **Unblock M0.** Receive or establish a pinned LiquidBounce/Baritone/Java/
   Minecraft baseline; prove headless boot, authorized connection, movement,
   disconnect and restart. Record the manifest.
2. **Implement the Java adapter** against
   [live-adapter.md](live-adapter.md): loopback WebSocket server, handshake with
   real server info, snapshot builder, Baritone-backed actions, cancellation,
   timeouts, result codes.
3. **Run conformance tests** against the adapter: invalid messages, version
   mismatch, busy action, cancel, oversized message, rate limit, disconnect.
4. **Authorized small-budget live run.** Start with `wait`/`stop`/`navigate`,
   then one trade cycle, then enchanting. Compare ledger and gear against
   observed inventory.
5. **Repeat full checkpoint runs** on a disposable local server; measure
   success rate, deaths, retries, throughput and model latency. Add a failure
   corpus and only then capture footage.
6. **Decide the next phase.** Nether/End/dragon is a separate milestone, not
   part of this checkpoint.

## Assumptions needing user confirmation

- Exact Minecraft/server/LiquidBounce/Baritone/Java versions and server rules.
- Authorization for the target server and account.
- Whether the MVP gear checklist and the 240-emerald target are the desired
  checkpoint for the live attempt.
- Whether the optional Qwen endpoint and model are available on the controller
  host, and the memory budget for client + server + model.
- Whether video evidence is required for acceptance; none is produced today.
