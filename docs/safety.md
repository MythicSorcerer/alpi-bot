# Safety

This project drives a Minecraft client automatically. Treat it like any other
automation that can affect a shared world: only run it where you have explicit
permission, and keep the guardrails on.

## Authorized use

- Run only on servers or worlds **you own** or have **explicit permission** to
  test automation on.
- Read the server rules. Some servers prohibit bots, automations, villager
  trading machines or AFK activity even when the client behaves legitimately.
- Use a dedicated test account where possible. Do not use a shared production
  account or someone else's credentials.
- The default configuration is fail-closed for remote adapters and
  non-whitelisted servers. Keep it that way unless you are intentionally
  testing a trusted host.

The project does not include a live client adapter, an account, a server or
credentials. The simulator is safe by construction; live operation is the
operator's responsibility.

## Non-negotiable behaviour

The project never intentionally uses or provides:

- flight, phase, no-clip, reach, timer, or anti-cheat bypass modules;
- duplication glitches or economy exploits;
- chat commands, whispers or social engineering;
- arbitrary code execution from model output;
- unrestricted shell access from the bot loop.

`guardrails.allowExploits` exists only to make the refusal explicit. Setting it
to `true` causes every action to be refused with a `GuardrailError`; it does
not enable cheats. `guardrails.allowChat` must stay `false`: setting it to
`true` is rejected at startup because the protocol has **no chat action** at
all.

## Enforcement points

| Layer | Enforces |
| --- | --- |
| Controller (`BotController`) | Budgets, kill switch, abort signal, goal overrides, action allow-list. |
| Guardrails (`assertActionAllowed`) | Timeout cap, action count/radius bounds, exploit refusal. |
| Guardrails (`assertAdapterAllowed`) | `ws://`/`wss://` and loopback unless explicitly allowed. |
| Guardrails (`assertServerAllowed`) | Adapter-reported server matches the whitelist. |
| `WsGameClient` | Schema validation before send, message size, request timeout, cancellation. |
| Adapter server (`GameAdapterServer`) | Loopback bind, schema validation, message size, handshake timeout, one active action, rate limit, action timeout. |
| Live adapter (to build) | Game-side reach, client-thread execution, cancellation, honest result codes. |

A live adapter must implement the same policy on the game side. The controller
cannot prevent a malicious adapter from doing something else; only connect to
an adapter you trust.

## Loopback and server whitelist

### Adapter URL

`assertAdapterAllowed` requires:

- a valid `ws://` or `wss://` URL;
- a loopback hostname (`localhost`, `127.0.0.0/8`, `::1`) unless
  `guardrails.allowRemoteAdapter` is `true`.

The adapter server (`GameAdapterServer`) refuses to bind to a non-loopback
interface at construction time. Prefer this default. If you must use a remote
adapter on a trusted private network, enable the opt-in deliberately and put
network controls around it; the protocol has no authentication.

### Server whitelist

After the handshake, the controller checks the adapter-reported server:

- `guardrails.requireServerWhitelist` defaults to `true`;
- missing `server` information is a hard failure while the whitelist is on;
- entries are matched by host and optional port;
- wildcard subdomains are supported as `*.example.test`;
- an entry without a port allows any port for that host.

Default entries:

```yaml
serverWhitelist:
  - 127.0.0.1:25565
  - localhost:25565
```

Do not add a public server to the whitelist unless you have permission and have
confirmed the exact address and port. The whitelist is a guardrail, not a grant
of permission.

## Budgets and limits

| Control | Default | Effect |
| --- | --- | --- |
| `run.maxActions` | 5,000 | Hard stop when the persisted run's action count is reached. |
| `run.maxMinutes` | 120 | Hard stop after wall-clock time in the current invocation. |
| `guardrails.maxActionTimeoutMs` | 60,000 ms | Rejects actions with a larger timeout. |
| `guardrails.maxActionsPerMinute` | 600 | Live runs throttle before sending an action. Deterministic simulation bypasses wall-clock throttling. |
| Adapter `limits.maxActionTimeoutMs` | Adapter-defined | Caps execution time on the adapter side. |
| Adapter `limits.maxMessageBytes` | 4 MiB typical | Rejects oversized wire messages. |
| Adapter `limits.maxActionsPerMinute` | 1,200 simulated | Adapter-side rate limit. |
| `economy.maxRestocks` | 80 | Bounds restock waiting. |
| `economy.keepFood` | 4 | Minimum food reserve; task loops buy food from a farmer when below it. |
| `gear.maxBookRerolls` | 80 | Bounds librarian rerolls. |
| Top-ups | 8 | Bounds emerald/XP emergency funding. |
| Task retries | 3–4 | Bounds failure loops. |

The simulation runs virtual time as fast as possible, so it deliberately skips
the wall-clock per-minute throttle. All other budgets still apply.

## Kill switch and abort

- `guardrails.killSwitchFile` defaults to `./STOP`.
- Before every action and at the top of each controller loop, the file's
  existence is checked. If present, the controller stops with
  `KillSwitchActivated`.
- The safe-stop path sends `stop`, writes a checkpoint when a snapshot exists,
  persists run state, writes the final report and closes the adapter.
- `run` also handles SIGINT/SIGTERM by aborting the active action and taking the
  same safe-stop path.
- The file is never deleted automatically. Doctor warns while it exists.

## Timeouts and cancellation

- Every action carries a bounded timeout.
- The WebSocket client adds a local deadline (action timeout plus 2 seconds,
  bounded by request timeout plus 5 seconds) and sends `cancel` on expiry.
- The adapter server enforces its own timeout and aborts the backend.
- Cancellation is best effort: an action may still complete, so the controller
  refreshes a snapshot after every action and trusts observed state, not the
  acknowledgement alone.
- Network failures are retried with bounds; a disconnected adapter cannot
  silently continue executing.

## Persistence and secrets

- Event payloads pass through `redact()` before being written.
- Keys matching `token`, `secret`, `password`, `authorization`, `api_key`,
  `apikey` or `cookie` are replaced with `[REDACTED]`.
- Bearer tokens and `sk-...` API keys are redacted inside strings.
- The Qwen API key is read from the environment variable named by
  `planner.qwen.apiKeyEnv` at request time. It is never written to the config,
  checkpoint, event log or report.
- State files are written with mode `0600` and atomically via temporary file
  plus rename.
- Checkpoints carry a SHA-256 checksum. `verify` rejects modified or corrupted
  files.
- Do not put account credentials, session tokens or API keys in YAML/JSON
  configuration. Do not attach a debugger that prints them.

Redaction is defense in depth, not a license to log secrets. Avoid putting
secrets into action data or notes.

## Model boundary

The optional Qwen planner:

- receives a compact state summary (position, health, food, XP, emeralds,
  village summary, missing gear, hostiles, recent notes);
- returns only `{"goal": "...", "reason": "..."}`;
- cannot emit an action, code, shell command or chat message;
- is overridden when its goal contradicts observed safety or gear state;
- falls back to the deterministic policy on invalid output, timeout, HTTP
  error or three consecutive failures.

The model is a strategy hint, not a control path. Survival reflexes never wait
for it.

## Human oversight

Before a live run:

1. Confirm authorization, server rules and the whitelist entry.
2. Run `mcbot doctor`.
3. Start with a small action budget and inspect the event log.
4. Watch the first full trade and enchant cycle; confirm inventory and server
   logs match.
5. Keep the kill switch within reach (`touch STOP`).
6. Stop on unexpected kicks, anti-cheat messages or world changes.

Do not leave an unattended bot on a server where automation is not explicitly
allowed.

## Reporting a safety problem

If the controller performs an unsafe or unauthorized action, preserve:

- `events.jsonl` (and `.1` if present);
- `report.json`;
- `checkpoint-<runId>.json`;
- the exact config, adapter version and server address;
- server-side logs and timestamps.

Do not publish credentials or player data. Redact before sharing.

## Known safety gaps

- The live adapter is not implemented; game-side policy cannot be audited yet.
- The protocol has no authentication; loopback is the boundary.
- Redaction is pattern-based and cannot catch every possible secret format.
- The whitelist trusts the adapter's reported server address. A compromised
  adapter could lie.
- The simulator's safety behaviour is not evidence about a live anti-cheat or
  server plugin.
- Resume trusts `controller-state.json` to describe the current world. The
  operator must confirm the world was not reset or changed in a way that makes
  resuming unsafe.
