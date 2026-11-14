/**
 * Public library surface for the Minecraft bot controller.
 *
 * The CLI is the supported entry point; these exports make the same building
 * blocks available for tests, custom adapters and embedded controllers.
 */

export {
  ConfigSchema,
  DEFAULT_GEAR_CHECKLIST,
  GearRequirementSchema,
  parseConfig,
  type Config,
  type ConfigInput,
  type GearRequirement,
} from "./config.js";
export { loadConfig } from "./config-file.js";

export * from "./protocol/types.js";

export {
  AdapterError,
  REQUIRED_CAPABILITIES,
  actionFailure,
  type GameAdapter,
} from "./adapter/types.js";
export { WsGameClient } from "./adapter/ws-client.js";
export {
  GameAdapterServer,
  type AdapterBackend,
  type GameAdapterServerOptions,
} from "./adapter/ws-server.js";
export {
  runAdapterConformance,
  summarizeConformance,
  type ConformanceCheck,
  type ConformanceOptions,
  type ConformanceResult,
  type ConformanceStatus,
} from "./adapter/conformance.js";

export { SimulatedGame, type SimScenario, type SimulatedGameOptions } from "./sim/simulator.js";
export { makeVillager, villagerLevel, type SimVillager } from "./sim/trades.js";
export { RECIPES, recipeFor, craftBatches, recipeOutputStack, type Recipe } from "./sim/recipes.js";

export {
  BotController,
  KillSwitchActivated,
  RunBudgetExceeded,
  TaskFailed,
  type ControllerOptions,
  type RunSummary,
} from "./controller/controller.js";
export { ReflexLayer, type ReflexContext, type ReflexDecision } from "./controller/reflex.js";
export {
  EconomyTask,
  ExploreTask,
  GearTask,
  SettleTask,
  buildFrontier,
  taskForGoal,
  type Task,
  type TaskContext,
  type TaskNeed,
  type TaskResult,
} from "./controller/tasks.js";
export {
  LedgerSchema,
  MetricsSchema,
  RunStateSchema,
  emptyMetrics,
  loadRunState,
  runStatePath,
  saveRunState,
  type Ledger,
  type Metrics,
  type RunState,
} from "./controller/state.js";

export {
  CHECKPOINT_SCHEMA_VERSION,
  CheckpointError,
  CheckpointSchema,
  buildCheckpoint,
  checkpointPath,
  checksumOf,
  readCheckpoint,
  saveCheckpoint,
  verifyCheckpoint,
  type Checkpoint,
  type CheckpointPayload,
} from "./persistence/checkpoint.js";
export {
  EventLog,
  EventRecordSchema,
  readEventLog,
  writeFileAtomic,
  type EventRecord,
} from "./persistence/event-log.js";

export {
  DeterministicPlanner,
  GOALS,
  QwenPlanner,
  deterministicGoal,
  goalFeasible,
  makePlanner,
  parseDecision,
  type Goal,
  type PlanDecision,
  type Planner,
  type PlannerContext,
} from "./planner/planner.js";

export {
  GuardrailError,
  assertActionAllowed,
  assertAdapterAllowed,
  assertServerAllowed,
  isLoopbackHost,
  isServerWhitelisted,
  killSwitchActive,
  parseHostPort,
} from "./guardrails.js";
export { Logger, silentLogger, type LogLevel, type LoggerOptions } from "./logging/logger.js";
export { redact, redactString } from "./util/redact.js";
export { countItem, describeItems, findItem, ns } from "./util/items.js";
export { distance, horizontalDistance, sleep } from "./util/vec.js";
export {
  enchantLevel,
  equipSlotFor,
  findItemStacks,
  gearLabel,
  remainingEnchantNeeds,
  requiredBookCounts,
  verifyGear,
  type EnchantNeed,
  type GearItemStatus,
  type GearVerification,
} from "./gear/checklist.js";
