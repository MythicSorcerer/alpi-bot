# Configuration

Configuration is validated by Zod (`src/config.ts`). Unknown keys are rejected
at every level, including inside nested sections. Partial files are merged with
code defaults.

The CLI does **not** load `config/default.yaml` automatically. Without
`--config`, code defaults apply. Pass the file explicitly when you want the
checked-in values:

```bash
npm run simulate -- --config config/default.yaml
```

Load order:

```text
code defaults
  -> YAML/JSON file via --config
  -> environment overrides (MCBOT_*)
  -> command-line overrides (--state-dir, --log-level, scenario flags, ...)
```

Environment variables are described in `.env.example`. The CLI does not read a
`.env` file by itself; export the variables in your shell or use your own
loader.

## `bot`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `username` | string, 1–16 | `MCBot` | Intended client username. The simulator uses a fixed name. |
| `owner` | string, ≤128 | `""` | Operator label recorded in the run report; not sent to the model. |

## `run`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `name` | string, 1–64 | `checkpoint` | Run label written to the summary and run report. |
| `seed` | integer | `42` | Simulator PRNG seed. |
| `maxActions` | integer, 1–100,000 | `5_000` | Hard action budget across the persisted run. Includes reflex actions. |
| `maxMinutes` | number, 1–1,440 | `120` | Wall-clock budget per controller invocation. A resumed session gets a fresh budget; downtime between sessions does not count. |
| `checkpointEveryActions` | integer, 1–1,000 | `10` | Periodic checkpoint interval. |

## `adapter`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `url` | URL | `ws://127.0.0.1:8765` | Must be `ws://`/`wss://`; loopback unless explicitly allowed. |
| `connectTimeoutMs` | integer, 500–60,000 | `5_000` | Connect and handshake timeout. |
| `requestTimeoutMs` | integer, 1,000–120,000 | `30_000` | Snapshot request and action deadline base. |
| `reconnectAttempts` | integer, 0–20 | `3` | Reconnect helper attempts. |
| `reconnectDelayMs` | integer, 100–60,000 | `1_000` | Base delay; multiplied by attempt number. |

## `guardrails`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `allowRemoteAdapter` | boolean | `false` | Opt-in for a non-loopback adapter host. Keep false unless intentional. |
| `requireServerWhitelist` | boolean | `true` | Refuse live control when the server is missing or not listed. |
| `serverWhitelist` | string[] | `127.0.0.1:25565`, `localhost:25565` | `host`, `host:port`, or `*.domain` entries. |
| `allowExploits` | boolean | `false` | Must stay false. `true` makes every action fail with a guardrail error. |
| `allowChat` | boolean | `false` | Must stay false. `true` is rejected because the protocol has no chat action. |
| `maxActionTimeoutMs` | integer, 1,000–120,000 | `60_000` | Rejects actions requesting a longer timeout. |
| `killSwitchFile` | string, ≤512 | `./STOP` | File existence stops the run safely. |
| `maxActionsPerMinute` | integer, 1–6,000 | `600` | Wall-clock throttle for live runs; skipped in deterministic simulation. |

## `simulation`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `scenario` | `default` \| `hostile-night` \| `scarce` | `default` | Simulator start conditions. |
| `villageDistance` | number, 64–8,000 | `480` | Village X offset in blocks. |
| `port` | integer, 0–65,535 | `0` | Default `adapter-sim` port; `0` chooses a free port. |

## `exploration`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `stepBlocks` | number, 16–512 | `128` | Frontier waypoint spacing. |
| `maxDistanceBlocks` | number, 64–16,000 | `1_024` | Maximum search radius. |
| `detectionRadius` | number, 16–256 | `96` | Simulator observation radius. |
| `maxWaypoints` | integer, 4–1,000 | `64` | Bound on the persisted frontier. |

## `settlement`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `minPopulation` | integer, 1–32 | `4` | Minimum villagers for a usable settlement. |
| `sleepAtNight` | boolean | `true` | Settlement sleeps at night to lock the spawn point when enabled. Disabling keeps spawn setup deferred; the survival reflex may still use a bed. |

## `economy`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `emeraldTarget` | integer, 1–10,000 | `240` | Target balance before gear purchasing. |
| `maxRestocks` | integer, 1–500 | `80` | Maximum restock waits in the stick loop. |
| `tradeActionBatch` | integer, 1–64 | `12` | Maximum trades per `trade` action. |
| `restockWaitMs` | integer, 1,000–300,000 | `30_000` | Wait duration when a trade is exhausted. |
| `keepFood` | integer, 1–64 | `4` | Food reserve; long economy/gear loops buy from a farmer when the stock falls below this. |
| `dropThreshold` | integer, 10–45 | `33` | Inventory slot count that triggers cleanup. |

## `gear`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `checklist` | array, 1–16 | built-in 7-item kit | Replaces the default list entirely when provided. Empty arrays are invalid. |
| `maxBookRerolls` | integer, 0–500 | `80` | Librarian reroll cap while seeking enchanted books. |

Checklist entry:

```yaml
gear:
  checklist:
    - item: minecraft:diamond_helmet
      enchants:
        - { id: minecraft:protection, level: 4 }
        - { id: minecraft:unbreaking, level: 3 }
      optional: false
    - item: minecraft:diamond_boots
      enchants:
        - { id: minecraft:protection, level: 4 }
        - { id: minecraft:unbreaking, level: 3 }
        - { id: minecraft:feather_falling, level: 4 }
      optional: false
```

`optional: true` items are reported but do not block checkpoint success.
Omitting `gear.checklist` uses `DEFAULT_GEAR_CHECKLIST` from `src/config.ts`.

## `reflex`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Disable only for controlled testing. |
| `lowHealth` | number, 1–20 | `8` | Flee/eat/regenerate threshold. |
| `lowFood` | integer, 0–20 | `6` | Eat threshold. |
| `hostileRadius` | number, 1–48 | `8` | Threat detection radius. |
| `criticalHostileRadius` | number, 1–48 | `4` | Immediate combat radius. |
| `voidY` | number, -128–0 | `-60` | Below this Y, recover toward the surface. |
| `stuckAfterFailures` | integer, 1–20 | `3` | Consecutive failures before a `stop` reflex. |

## `planner`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `mode` | `deterministic` \| `qwen` | `deterministic` | Qwen is optional; failures fall back. |
| `qwen.baseUrl` | URL | `http://127.0.0.1:11434/v1` | OpenAI-compatible endpoint. |
| `qwen.model` | string, 1–128 | `qwen2.5:14b-instruct` | Model id. |
| `qwen.apiKeyEnv` | string, 1–128 | `QWEN_API_KEY` | **Name** of the environment variable holding the key. |
| `qwen.timeoutMs` | integer, 500–120,000 | `15_000` | Per-request timeout. |
| `qwen.maxTokens` | integer, 16–4,096 | `256` | Response cap. |
| `qwen.temperature` | number, 0–2 | `0.1` | Sampling temperature. |

## `persistence`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `dir` | string, 1–512 | `./state` | All run evidence is written here. `--state-dir` overrides. |
| `saveEvents` | boolean | `true` | Disable to skip the JSONL log (not recommended for evidence runs). |
| `maxEventFileBytes` | integer, 1,024–536,870,912 | `67,108,864` (64 MiB) | One-file rotation threshold. |

## `logging`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `level` | `debug` \| `info` \| `warn` \| `error` | `info` | `--log-level` overrides. |
| `pretty` | boolean | `true` | Human-readable lines; JSON mode forces structured logging to stderr. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `MCBOT_ADAPTER_URL` | `adapter.url` |
| `MCBOT_USERNAME` | `bot.username` |
| `MCBOT_LOG_LEVEL` | `logging.level` (`debug`/`info`/`warn`/`error`) |
| `MCBOT_STATE_DIR` | `persistence.dir` |
| `MCBOT_PLANNER_MODE` | `planner.mode` (`deterministic`/`qwen`) |
| `MCBOT_QWEN_BASE_URL` | `planner.qwen.baseUrl` |
| `MCBOT_QWEN_MODEL` | `planner.qwen.model` |
| `MCBOT_QWEN_API_KEY_ENV` | Name of the env var holding the key |
| `MCBOT_ALLOW_REMOTE_ADAPTER` | `1`/`true` enables `guardrails.allowRemoteAdapter` |
| `MCBOT_SERVER_WHITELIST` | Comma-separated whitelist replacement |

The API key value itself is never read into config. `QwenPlanner` reads it at
request time from the environment variable named by `qwen.apiKeyEnv`.

## Examples

### Minimal deterministic configuration

```yaml
run:
  seed: 7
  maxActions: 4000
economy:
  emeraldTarget: 240
persistence:
  dir: ./state
```

### Local Qwen planning

```yaml
planner:
  mode: qwen
  qwen:
    baseUrl: http://127.0.0.1:11434/v1
    model: qwen2.5:14b-instruct
    apiKeyEnv: QWEN_API_KEY
    timeoutMs: 15000
```

```bash
export QWEN_API_KEY=...   # only if your endpoint requires it
npm run simulate -- --config ./config/qwen.yaml
mcbot doctor --config ./config/qwen.yaml
```

### Simulator over WebSocket

```yaml
simulation:
  port: 8765
adapter:
  url: ws://127.0.0.1:8765/adapter
guardrails:
  serverWhitelist:
    - 127.0.0.1:25565
```

```bash
mcbot adapter-sim --config ./config/ws-sim.yaml
mcbot run --config ./config/ws-sim.yaml --fresh
```

### Trusted remote adapter (not recommended)

```yaml
adapter:
  url: ws://192.0.2.10:8765/adapter
guardrails:
  allowRemoteAdapter: true
  requireServerWhitelist: true
  serverWhitelist:
    - 192.0.2.20:25565
```

Only do this on a trusted network with explicit authorization. The protocol
has no authentication; anyone who can reach the port can issue actions.

## Validation and troubleshooting

- A startup error such as `Unrecognized key` means a typo or an obsolete key;
  remove it rather than ignoring it.
- `gear.checklist` must be non-empty if supplied.
- `adapter.url` must parse as a URL and use `ws`/`wss`.
- Ports and timeouts must be integers in range; use `doctor` to catch most
  environment issues without starting a run.
- Run `npm run schema` after changing config schemas; the generated
  `Config` definition is part of `schemas/protocol.schema.json`.
