# Adapter protocol

The controller and the game side communicate over a versioned JSON protocol on
a loopback WebSocket. The same protocol is exercised by the in-process
simulator, the WebSocket adapter server and the WebSocket controller client.

- **Protocol version:** `1.0.0`
- **Transport:** WebSocket text frames, UTF-8 JSON
- **Default endpoint:** `ws://127.0.0.1:8765/adapter` (the adapter server
  actually accepts any path)
- **One action at a time:** the adapter server rejects a second concurrent
  `execute` with `BUSY`
- **Request correlation:** every request carries a `requestId`; results and
  snapshots echo it

Schemas live in [`src/protocol/types.ts`](../src/protocol/types.ts). Generated
JSON Schema is written by `npm run schema` to
[`schemas/protocol.schema.json`](../schemas/protocol.schema.json).

## Versioning

- `PROTOCOL_VERSION` is a semantic version. The handshake compares **major**
  versions; a mismatch closes the connection with code `1008`.
- Any breaking shape change must bump the major version.
- Unknown action error codes should be treated as failures, not retried
  blindly.

## Message flow

```text
controller                              adapter
    │                                      │
    │──── hello {protocolVersion, client} ─▶│
    │◀─── hello_ack {adapter, limits, ...} ─│
    │                                      │
    │──── snapshot_request {requestId} ───▶│
    │◀─── snapshot {requestId, snapshot} ───│
    │                                      │
    │──── execute {requestId, actionId, ──▶│
    │            action}                    │
    │◀─── result {requestId, result} ───────│
    │                                      │
    │──── cancel {requestId, targetActionId} ▶ (best effort)
    │◀─── result {cancelled: true} ─────────│
    │                                      │
    │◀─── event {event} ────────────────────│ (unsolicited)
    │──── ping {nonce} ────────────────────▶│
    │◀─── pong {nonce} ─────────────────────│
```

The adapter may also send `error` messages:

```json
{
  "type": "error",
  "requestId": "req-7-abc",
  "code": "BUSY",
  "message": "action act-6 is still running",
  "retryable": true
}
```

`requestId` is omitted for connection-level errors.

## Handshake

### `hello` (controller → adapter)

```json
{
  "type": "hello",
  "protocolVersion": "1.0.0",
  "client": { "name": "all-purpose-mc-bot", "version": "0.1.0" }
}
```

### `hello_ack` (adapter → controller)

```json
{
  "type": "hello_ack",
  "protocolVersion": "1.0.0",
  "adapter": {
    "name": "MinecraftSimulator",
    "version": "1.0.0",
    "capabilities": ["navigate", "collect", "mine", "place", "craft", "eat", "sleep",
      "inspect_trades", "trade", "reroll_trades", "breed", "equip", "attack",
      "flee", "apply_book", "drop", "surface", "wait", "stop"]
  },
  "limits": {
    "maxActionTimeoutMs": 60000,
    "maxMessageBytes": 4194304,
    "maxActionsPerMinute": 1200
  },
  "server": {
    "address": "127.0.0.1:25565",
    "version": "1.21.4",
    "software": "simulated"
  },
  "tickRate": 20
}
```

`server` is required by the controller's default guardrail policy: if it is
missing, `assertServerAllowed` refuses to continue. The address is checked
against `guardrails.serverWhitelist`; `software` is optional informational
data. `tickRate` is informational.

`limits.maxMessageBytes` is adopted by the controller after the handshake and
bounds both outgoing and incoming messages. `limits.maxActionTimeoutMs` caps
the adapter-side execution timeout. `limits.maxActionsPerMinute`, when present,
is enforced by the adapter server.

## Actions

Actions are a discriminated union on `type`. All optional `timeoutMs` fields
are integers from 50 to 120,000 ms. The controller also enforces
`guardrails.maxActionTimeoutMs` (default 60,000 ms) and the adapter applies its
own cap.

| `type` | Fields | Meaning |
| --- | --- | --- |
| `navigate` | `target` (vec3), `range?` (0–64), `timeoutMs?` | Path to within `range` of a position. |
| `stop` | — | Cancel pathing/current work and stand still. |
| `wait` | `durationMs` (50–300,000), `timeoutMs?` | Wait a bounded virtual/real duration. |
| `collect` | `item` (namespaced id), `count` (1–512), `radius?` (1–128), `timeoutMs?` | Gather a block/resource type. |
| `mine` | `position` (vec3), `blockType?`, `timeoutMs?` | Break one observed block. |
| `place` | `item`, `position`, `timeoutMs?` | Place a held block. |
| `craft` | `item`, `count` (1–1024), `timeoutMs?` | Craft a known recipe. |
| `eat` | `item?`, `timeoutMs?` | Eat food, optionally a specific item. |
| `sleep` | `bed?` (vec3), `timeoutMs?` | Use a bed and set spawn. |
| `inspect_trades` | `villagerId`, `timeoutMs?` | Read a villager's offers. |
| `trade` | `villagerId`, `offerIndex` (0–31), `times?` (1–64), `timeoutMs?` | Execute a trade batch. |
| `reroll_trades` | `villagerId`, `timeoutMs?` | Reroll a librarian's offers via workstation. |
| `breed` | `villagerIds` (exactly 2), `food?`, `timeoutMs?` | Breed a villager pair. |
| `equip` | `item`, `slot` (`head\|chest\|legs\|feet\|offhand\|mainhand`), `timeoutMs?` | Equip an item. |
| `attack` | `entityId?`, `timeoutMs?` | Attack a hostile, or the nearest in reach. |
| `flee` | `entityId?`, `distance?` (8–128), `timeoutMs?` | Move away from a threat. |
| `apply_book` | `item`, `book` (item stack), `timeoutMs?` | Apply an enchanted book to an item. |
| `drop` | `item`, `count` (1–64), `timeoutMs?` | Drop items. |
| `surface` | `timeoutMs?` | Escape water/drowning. |

Item ids must be namespaced, for example `minecraft:oak_log`. An item stack is:

```json
{
  "item": "minecraft:diamond_sword",
  "count": 1,
  "slot": 4,
  "enchants": [
    { "id": "minecraft:sharpness", "level": 5 },
    { "id": "minecraft:unbreaking", "level": 3 }
  ],
  "durability": { "current": 1561, "max": 1561 }
}
```

`count` is 1–64 per stack. Inventory deltas are chunked into stacks of at most
64.

### Execute

```json
{
  "type": "execute",
  "requestId": "req-12-abc",
  "actionId": "earn_emeralds-41-9f2c11",
  "action": {
    "type": "trade",
    "villagerId": "fletcher-2",
    "offerIndex": 0,
    "times": 8,
    "timeoutMs": 30000
  }
}
```

`actionId` is the controller's stable id for the action; `requestId` correlates
the response. The adapter echoes both.

### Cancel

```json
{
  "type": "cancel",
  "requestId": "req-13-def",
  "targetActionId": "earn_emeralds-41-9f2c11"
}
```

The adapter aborts a matching active action and replies with a `result` whose
`data.cancelled` is `true`. Cancellation is best effort; the original
`execute` may still resolve. The controller sends a cancel when its action
timeout expires or its abort signal fires.

## Snapshots

A snapshot is the controller's whole observation of the game.

```json
{
  "protocolVersion": "1.0.0",
  "seq": 42,
  "timestamp": 1760000000000,
  "adapter": { "name": "MinecraftSimulator", "version": "1.0.0" },
  "bot": {
    "username": "MCBot",
    "gameMode": "survival",
    "dimension": "minecraft:overworld",
    "position": { "x": 0, "y": 64, "z": 0 },
    "velocity": { "x": 0, "y": 0, "z": 0 },
    "yaw": 0,
    "pitch": 0,
    "health": 20,
    "maxHealth": 20,
    "food": 20,
    "saturation": 5,
    "air": 300,
    "maxAir": 300,
    "xpLevel": 0,
    "xpPoints": 0,
    "onGround": true,
    "inWater": false,
    "isSleeping": false,
    "selectedSlot": 0,
    "inventory": [],
    "armor": { "head": null, "chest": null, "legs": null, "feet": null, "offhand": null },
    "mainhand": null,
    "currentScreen": null,
    "effects": [],
    "spawnPoint": null,
    "path": { "active": false, "status": "idle" },
    "action": null
  },
  "world": {
    "timeOfDay": 6000,
    "day": 0,
    "weather": "clear",
    "difficulty": "normal",
    "nearbyEntities": [],
    "nearbyBlocks": [],
    "villagers": [],
    "village": null
  }
}
```

Notes:

- `bot.inventory` is at most 64 stacks; `armor` and `mainhand` are separate.
- `world.nearbyEntities` is capped at 256 and `world.nearbyBlocks` at 512.
- Entities carry `kind` (`hostile`, `passive`, `player`, `villager`, `other`)
  and an optional `distance` that reflexes use.
- A village has `population`, `beds`, `workstations` and `valid`. The controller
  never assumes a village is usable from position alone.
- Villagers can carry cached trades (`tradesKnown`, `trades`) with `index`,
  `inputs`, `output`, `maxUses`, `uses`, `rewardXp` and `minLevel`.
- `bot.spawnPoint` is how settlement is observed. It may be `null`.
- `bot.action` and `bot.path` describe in-flight adapter work.

## Results

```json
{
  "type": "result",
  "requestId": "req-12-abc",
  "result": {
    "protocolVersion": "1.0.0",
    "requestId": "req-12-abc",
    "actionId": "earn_emeralds-41-9f2c11",
    "ok": true,
    "code": "OK",
    "startedAt": 1760000000000,
    "endedAt": 1760000001450,
    "snapshotSeq": 43,
    "inventoryDelta": {
      "added": [{ "item": "minecraft:emerald", "count": 8 }],
      "removed": [{ "item": "minecraft:stick", "count": 32 }]
    },
    "data": {
      "villagerId": "fletcher-2",
      "offerIndex": 0,
      "times": 8,
      "usesLeft": 4,
      "villagerLevel": 2,
      "spent": [{ "item": "minecraft:stick", "count": 32 }],
      "received": { "item": "minecraft:emerald", "count": 8 },
      "xpGained": 16,
      "botXpLevel": 3
    },
    "events": []
  }
}
```

`data` is action-specific. Well-known keys used by the controller:

| Key | Used for |
| --- | --- |
| `moved`, `collected` | Distance/collection metrics. |
| `times`, `spent`, `received` | Trade ledger and metrics. |
| `events` with `type: "respawn"` | Death count. |
| `cancelled` | Cancel acknowledgement. |

## Stable failure codes

Task logic switches on codes, never on message text.

| Code | Meaning |
| --- | --- |
| `OK` | Success. |
| `INVALID_ACTION` | Schema-valid but unsupported/invalid for the world. |
| `NOT_CONNECTED` | Adapter connection lost. |
| `BUSY` | Another action is still running. |
| `TIMEOUT` | Action exceeded its timeout. |
| `CANCELLED` | Cancelled by the controller or adapter shutdown. |
| `GUARDRAIL_BLOCKED` | Local policy refused the action. |
| `PLAYER_DEAD` | Bot is dead; wait for respawn. |
| `OUT_OF_RANGE` | Target is too far away. |
| `NO_PATH` | Pathfinding failed. |
| `BLOCK_NOT_FOUND` | Requested block is absent. |
| `MISSING_ITEM` | Required item is absent. |
| `INVENTORY_FULL` | No room for the result. |
| `CRAFT_FAILED` | Crafting failed. |
| `RECIPE_UNKNOWN` | No recipe for the request. |
| `TRADE_UNAVAILABLE` | Offer is not currently available. |
| `TRADE_EXHAUSTED` | Offer has no uses left. |
| `NOT_ENOUGH_EMERALDS` | Payment cannot be met. |
| `LOW_XP` | Not enough XP to apply an enchantment. |
| `ENCHANT_CONFLICT` | Enchantment is incompatible with the target. |
| `BED_UNAVAILABLE` | No usable bed. |
| `NOT_NIGHT` | Sleep is not possible now. |
| `HOSTILES_NEARBY` | Unsafe to sleep/work. |
| `ENTITY_NOT_FOUND` | Entity id is unknown. |
| `UNSUPPORTED` | Adapter does not implement the operation. |
| `INTERNAL_ERROR` | Adapter-side failure. |

Adapter-level `error` messages add transport codes such as `PROTOCOL_MISMATCH`,
`INVALID_JSON`, `INVALID_MESSAGE`, `MESSAGE_TOO_LARGE`, `RATE_LIMITED`,
`SNAPSHOT_FAILED` and `HANDSHAKE_TIMEOUT`. The controller surfaces these as
`AdapterError` with a retryable flag.

## Limits and timing

| Limit | Default | Source |
| --- | --- | --- |
| Connect timeout | 5,000 ms | `adapter.connectTimeoutMs` |
| Handshake timeout | 5,000 ms | Adapter server handshake timer |
| Snapshot timeout | 30,000 ms | `adapter.requestTimeoutMs` |
| Action timeout | Action `timeoutMs`, capped at 60,000 ms | Guardrails + adapter limit |
| Wire message size | 4 MiB | `hello_ack.limits.maxMessageBytes` |
| Actions per minute | Adapter-defined (1,200 simulated) | `hello_ack.limits.maxActionsPerMinute` |
| Rate limit (controller) | 600/min | `guardrails.maxActionsPerMinute` |

The controller's client also enforces its own action deadline (action timeout
plus 2 seconds, bounded by request timeout plus 5 seconds) and sends `cancel`
when it fires. A reconnect attempt is made for retryable connection failures;
`adapter.reconnectAttempts` and `adapter.reconnectDelayMs` control the
reconnect helper.

## Protocol invariants

A conforming adapter must guarantee:

1. A `hello_ack` is sent only after a valid `hello` with a compatible major
   version. Any other message before `hello` is rejected with
   `HANDSHAKE_REQUIRED`, and a second `hello` on the same connection is
   rejected with `INVALID_MESSAGE`.
2. Snapshots and results echo the request id.
3. Only one `execute` is active at a time; extra requests get `BUSY`.
4. Repeated `actionId`/`requestId` values are not reused for different work.
5. Cancellation never leaves the client thread blocked; actions are bounded,
   and only the connection that owns an action may cancel it.
6. Invalid messages are rejected, not partially applied.
7. The adapter never executes an action outside the schema union.

The controller assumes these invariants and additionally revalidates every
outgoing action locally before it reaches the socket.

## Conformance testing

`src/adapter/ws-server.ts` can wrap any `AdapterBackend`. The repository's test
suite uses it with `SimulatedGame` to exercise handshake, snapshot, execute,
cancel, invalid-message handling and reconnect over real loopback sockets.

`mcbot conformance` runs the same checks against a running adapter with a raw
probe: handshake, required capabilities, ping, snapshot, one short `wait`,
cancel acknowledgement, duplicate hello, pre-handshake rejection, protocol
mismatch, invalid JSON, an unknown message and an oversized frame. It never
drives the bot or spends a meaningful action budget; rate limiting and action
timeouts are left to a live soak test. This is the same contract a live
adapter must satisfy.
