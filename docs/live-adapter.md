# Live adapter boundary (LiquidBounce + Baritone)

## Status

**The live Java adapter is not included in this repository and has not been
built or validated against a real Minecraft client or server.**

The controller, the WebSocket protocol, the adapter server wrapper and the
authorization/safety checks are implemented. The deterministic simulator
implements the same `GameAdapter` contract and is the only backend exercised
end to end so far.

This document specifies what a live adapter must do, so the missing piece can
be implemented without changing the controller. It is a design and integration
contract, not a claim that live operation works today.

## Why it is missing

- No LiquidBounce installation or pinned version was available to build
  against.
- No authorized Minecraft server, account or client environment was available
  for integration testing.
- LiquidBounce and Baritone APIs change between Minecraft versions; a live
  adapter must be pinned to an exact toolchain rather than guessed.

The correct next step is to pin the environment (Milestone 0 in the roadmap),
then implement and test the adapter against that pin. Do not treat the
simulator's `1.21.4` label as a validated live target.

## What already exists

| Piece | Location | Status |
| --- | --- | --- |
| Versioned wire protocol | `src/protocol/types.ts` | Implemented, schema-validated. |
| Controller WebSocket client | `src/adapter/ws-client.ts` | Implemented and tested over loopback. |
| Adapter-side WebSocket server | `src/adapter/ws-server.ts` | Implemented; wraps any `AdapterBackend`. |
| In-process simulator | `src/sim/simulator.ts` | Deterministic reference implementation. |
| Protocol tests | `tests/protocol.test.ts`, `tests/controller.e2e.test.ts` | Handshake, snapshot, execute, cancel, validation, reconnect. |
| Guardrails | `src/guardrails.ts` | Loopback, server whitelist, action bounds, kill switch. |

A live adapter only needs to implement the wire contract and forward actions to
the game. It must not change snapshots or actions to fit the controller's
current tasks; the controller adapts to game state.

## Target topology

```text
Minecraft client (LiquidBounce Fabric mod)
  └─ live adapter add-on
       ├─ WebSocket server on 127.0.0.1:<port>/adapter
       ├─ snapshot builder (client thread)
       ├─ action executor
       │    ├─ Baritone pathing / mining
       │    └─ player interactions, inventory, trades, anvil
       └─ cancellation / deadlines / result mapping
                    ▲
                    │ JSON protocol 1.0.0
                    │
          mcbot run (controller process)
```

Bind to loopback only. Do not expose the adapter on a LAN interface. The
protocol has no authentication layer; loopback plus host firewalling is the
security boundary.

## Pinned environment manifest (to be filled in)

Record this before writing code:

| Component | Required value |
| --- | --- |
| Minecraft | exact version, e.g. `1.21.4` |
| Server software | Paper/Fabric/vanilla plus exact build |
| Server config | online-mode, whitelist, difficulty, villager rules, anti-cheat |
| Java | exact major/minor |
| LiquidBounce | exact release/commit |
| Fabric loader / API | exact versions |
| Baritone | exact fork/version compatible with the client |
| Client launch | headless/Xvfb/EGL or desktop, memory limits |
| Account | authorized test account, never a shared production account |
| Adapter port | loopback port, e.g. `8765` |

If any component is unpinned, a passing run is not reproducible.

## Adapter responsibilities

### 1. Handshake

Accept a WebSocket connection and read `hello`.

- Compare the major version with the adapter's `PROTOCOL_VERSION`; on mismatch
  send `error` with `PROTOCOL_MISMATCH` and close with `1008`.
- Reply with `hello_ack` containing the adapter name/version, supported
  capabilities and limits.
- **Report the real server** in `server.address`, `server.version` and
  `server.software`. The controller refuses to run when the default whitelist
  is enabled and no address is reported.
- A handshake must complete within 5 seconds.

Do not advertise a capability that is not implemented. The controller logs
missing capabilities and task behaviour will surface `UNSUPPORTED`.

### 2. Snapshots

Build a `Snapshot` from the client thread, then validate it against the schema
before sending. Minimum mapping:

| Snapshot field | Live source |
| --- | --- |
| `bot.username` | `ClientPlayerEntity.getGameProfile().getName()` |
| `bot.gameMode`, `dimension` | client world/player interaction manager |
| `bot.position`, `yaw`, `pitch` | player entity, every tick or on request |
| `bot.health`, `food`, `saturation`, `air` | player stats |
| `bot.xpLevel`, `xpPoints` | player experience |
| `bot.onGround`, `inWater`, `isSleeping` | player state |
| `bot.selectedSlot`, `inventory` | player inventory, 36 main slots plus hotbar mapping |
| `bot.armor`, `mainhand`, `offhand` | equipment slots and held stack |
| `bot.currentScreen` | current screen class name, bounded length |
| `bot.effects` | status effect ids |
| `bot.spawnPoint` | player spawn point if available |
| `bot.path` | Baritone pathing state and current goal |
| `bot.action` | adapter's active action id/type/deadline |
| `world.timeOfDay`, `day`, `weather`, `difficulty` | client world |
| `world.nearbyEntities` | entities within a bounded radius, with `kind`, `distance` |
| `world.nearbyBlocks` | beds, workstations and relevant POIs within radius |
| `world.villagers` | visible villagers, profession, level, position, cached trades |
| `world.village` | validated village summary (population/beds/workstations/valid) |

Implementation notes:

- Cap arrays to the schema limits (256 entities, 512 blocks, 128 villagers).
- Cache merchant offers after interacting; do not fabricate trades. If offers
  are unknown, report `tradesKnown: false` and let the controller call
  `inspect_trades`.
- Report `distance` for hostiles; reflexes depend on it.
- `village.valid` must reflect an actual local check, not merely “a villager is
  nearby”.
- Timestamps are Unix milliseconds; `seq` must increase per snapshot.
- Snapshots are read-only and must not mutate game state.

### 3. Actions

Execute only the schema-defined actions. Reject unsupported or out-of-range
requests with a stable code. Suggested mapping:

| Action | Game-side approach |
| --- | --- |
| `navigate` | Baritone custom goal (`GoalNear`/`GoalBlock`); `range` maps to a near-goal radius. Poll completion, failure and cancellation. |
| `stop` | Cancel Baritone pathing and any active interaction; stand still. |
| `wait` | Sleep in bounded slices, observing cancellation. |
| `collect` | Baritone mine process for the item's block(s), or a bounded gather loop; respect count/radius. |
| `mine` | Target the observed block position/type; verify reachability. |
| `place` | Select the item and place against the target face; verify the block changed. |
| `craft` | Use the recipe book or a bounded crafting-table interaction; verify output. |
| `eat` | Select food, hold use until consumption, verify hunger. |
| `sleep` | Approach and use a bed at night; report spawn point. |
| `inspect_trades` | Open the merchant screen and cache offers; close it safely. |
| `trade` | Verify offer index and inputs, execute the batch, stop at `maxUses`; report spent/received. |
| `reroll_trades` | Only a legal workstation reroll; verify the villager's offers changed. Never duplicate emeralds or offers. |
| `breed` | Feed two adults and verify a child/population change. |
| `equip` | Move the item into the correct armour/mainhand/offhand slot. |
| `attack` | Attack the requested/nearest hostile within reach; report damage/kill. |
| `flee` | Path away to the requested distance; do not use flight/phase. |
| `apply_book` | Anvil-like combination; verify enchantments and XP cost; return `LOW_XP`/`ENCHANT_CONFLICT`. |
| `drop` | Drop the requested count, never more. |
| `surface` | Swim upward/escape water; verify air. |

Rules:

- Never use flight, phase, anti-cheat bypasses, duplication, or unrestricted
  chat. Chat is not part of the protocol.
- Enforce the action deadline; abort pathing and interactions on timeout.
- On cancel, stop the work and return a result promptly. The controller may
  have already timed out.
- Execute game mutations on the client thread. Do not block the render thread
  for socket I/O.
- Return the actual outcome. Do not optimistically report `OK` before the state
  changed; the controller refreshes a snapshot after every action and will
  catch divergence.

### 4. Results

Every `execute` gets exactly one `result` with the same `requestId` and
`actionId`:

```json
{
  "protocolVersion": "1.0.0",
  "requestId": "req-12-abc",
  "actionId": "earn_emeralds-41-9f2c11",
  "ok": false,
  "code": "NO_PATH",
  "reason": "no path within 5000 ticks",
  "startedAt": 1760000000000,
  "endedAt": 1760000005000,
  "snapshotSeq": 43
}
```

Include `inventoryDelta` when items moved, `data` for action-specific evidence,
and `events` for notable state changes (level-up, respawn, etc.). Keep
`reason` short and user-readable; task logic uses `code`.

### 5. Events and health

- Send `event` for adapter-side state changes worth preserving (path failure,
  respawn, villager level-up, safety abort).
- Respond to `ping` with `pong` using the same nonce.
- Do not send a `pong` or `event` in place of a `result`.
- Close cleanly on adapter shutdown; the controller treats disconnect as
  retryable and reconnects per configuration.

## Suggested implementation sequence

1. **Pin and record** the environment manifest above; launch the client
   headless (Xvfb/EGL) and connect with an authorized account.
2. **Add-on skeleton.** Create a LiquidBounce/Fabric add-on module with a
   loopback WebSocket server (for example Java-WebSocket) and a JSON codec.
   Keep the socket and game-thread work separated by a queue.
3. **Handshake and snapshots.** Implement `hello`/`hello_ack`, server info,
   and a read-only snapshot. Validate against the generated JSON Schema.
4. **Read-only loop.** Run `mcbot run` against the adapter with a tiny action
   budget and confirm snapshots parse, guardrails pass and only `wait`/`stop`
   are used.
5. **Safe actions first.** `stop`, `wait`, `navigate`, `eat`, `sleep`,
   `equip`, `drop`, `surface`.
6. **Resource and economy actions.** `collect`, `mine`, `place`, `craft`,
   `inspect_trades`, `trade`, `reroll_trades`, `breed`.
7. **Combat and enchanting.** `attack`, `flee`, `apply_book`; verify XP and
   conflict handling.
8. **Cancellation and timeout tests.** Kill paths mid-run, disconnect the
   controller, restart, and confirm the adapter never leaves a stuck action.
9. **Conformance pass.** Reuse the controller's protocol tests conceptually:
   invalid JSON, invalid schema, major mismatch, second concurrent action,
   cancel, oversized message, rate limit.
10. **Authorized integration run.** Small budget on a disposable local server,
    then a full checkpoint run. Record versions, logs and server-side errors.

## Validation checklist for a live run

- [ ] Client launches and connects with the pinned versions.
- [ ] Adapter binds to `127.0.0.1` only.
- [ ] `hello_ack` reports the real server address and version.
- [ ] `mcbot doctor` passes with the live URL and whitelist.
- [ ] `mcbot run --max-actions 50` performs only safe actions.
- [ ] Snapshots match the game: position, inventory, health, villagers, trades.
- [ ] Cancellation stops Baritone and interactions within a bounded time.
- [ ] No chat, exploit, flight, phase or anti-cheat bypass is used.
- [ ] Trade ledger matches observed inventory changes.
- [ ] Gear is verified from actual item NBT and equipment slots.
- [ ] Checkpoint checksum verifies after a controller restart.
- [ ] Server logs show no unexpected kicks, errors or anti-cheat actions.
- [ ] Run is repeated enough times to measure success rate and failures.

## Known live risks

- **Version drift.** Minecraft, LiquidBounce, Baritone and Fabric APIs are
  tightly coupled. Pin all of them and re-run the conformance suite on every
  upgrade.
- **Trade mechanics.** Vanilla trade NBT, demand, restock and villager
  schedules differ from the simulator. The adapter must report real offers;
  the controller must not assume the simulated fletcher/ librarian layout.
- **Pathfinding.** Baritone settings, chunk loading and server lag affect path
  success. Report `NO_PATH`/`TIMEOUT` honestly; the controller has bounded
  retries.
- **Server rules.** Some servers restrict automation, villagers or anvils.
  Obtain explicit permission and follow the rules. The whitelist is a
  guardrail, not a permission system.
- **Anti-cheat.** Observe flags as diagnostics. Never tune the bot to evade.
- **World restoration.** Resume restores controller state, not the world. The
  live adapter must report current world state, and the operator must decide
  whether resuming is safe.
- **Headless client.** Rendering, input focus and graphics drivers can fail
  even when the mod loads. Milestone 0 exists to prove this before task work.

## Non-goals

- A Java add-on is not generated by this repository.
- No real account, server or client is used by the test suite.
- No claim that simulator throughput predicts live throughput.
- No exploit or duplication path, even as an opt-in.

When the live adapter exists, the controller and protocol should remain
unchanged except for additive capabilities or a deliberate version bump.
