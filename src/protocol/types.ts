import { z } from "zod";

/**
 * Version of the controller <-> game-adapter wire protocol.
 * Bump the major version for any breaking shape change.
 */
export const PROTOCOL_VERSION = "1.0.0";

export const ItemIdSchema = z
  .string()
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/, "expected a namespaced item id such as minecraft:oak_log");

export const Vec3Schema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();
export type Vec3 = z.infer<typeof Vec3Schema>;

export const EnchantmentSchema = z
  .object({
    id: ItemIdSchema,
    level: z.number().int().min(1).max(255),
  })
  .strict();
export type Enchantment = z.infer<typeof EnchantmentSchema>;

export const DurabilitySchema = z
  .object({
    current: z.number().int().min(0),
    max: z.number().int().positive(),
  })
  .strict();

export const ItemStackSchema = z
  .object({
    item: ItemIdSchema,
    count: z.number().int().min(1).max(64),
    slot: z.number().int().min(0).max(45).optional(),
    enchants: z.array(EnchantmentSchema).max(32).optional(),
    customName: z.string().max(128).optional(),
    durability: DurabilitySchema.optional(),
  })
  .strict();
export type ItemStack = z.infer<typeof ItemStackSchema>;

export const EntityKindSchema = z.enum(["hostile", "passive", "player", "villager", "other"]);
export const EntitySchema = z
  .object({
    id: z.string().min(1).max(128),
    type: ItemIdSchema,
    kind: EntityKindSchema,
    position: Vec3Schema,
    health: z.number().finite().min(0).optional(),
    distance: z.number().finite().min(0).optional(),
  })
  .strict();
export type Entity = z.infer<typeof EntitySchema>;

export const BlockSchema = z
  .object({
    type: ItemIdSchema,
    position: Vec3Schema,
    hardness: z.number().min(0).optional(),
  })
  .strict();
export type Block = z.infer<typeof BlockSchema>;

export const TradeOfferSchema = z
  .object({
    index: z.number().int().min(0),
    inputs: z.array(ItemStackSchema).min(1).max(2),
    output: ItemStackSchema,
    maxUses: z.number().int().min(1),
    uses: z.number().int().min(0),
    rewardXp: z.number().int().min(0).default(0),
    /** Minimum villager level at which this offer is available. */
    minLevel: z.number().int().min(1).max(5).default(1),
  })
  .strict();
export type TradeOffer = z.infer<typeof TradeOfferSchema>;

export const VillagerSchema = z
  .object({
    id: z.string().min(1).max(128),
    profession: z.string().min(1).max(64),
    level: z.number().int().min(1).max(5),
    xp: z.number().int().min(0).optional(),
    position: Vec3Schema,
    tradesKnown: z.boolean().default(false),
    trades: z.array(TradeOfferSchema).max(32).optional(),
    sleeping: z.boolean().optional(),
    baby: z.boolean().optional(),
    workstation: Vec3Schema.nullable().optional(),
    restockAt: z.number().int().min(0).nullable().optional(),
  })
  .strict();
export type Villager = z.infer<typeof VillagerSchema>;

export const VillageSchema = z
  .object({
    id: z.string().min(1).max(128),
    center: Vec3Schema,
    radius: z.number().finite().positive(),
    population: z.number().int().min(0),
    beds: z.number().int().min(0),
    workstations: z.number().int().min(0),
    valid: z.boolean(),
    notes: z.array(z.string().max(256)).max(16).optional(),
  })
  .strict();
export type Village = z.infer<typeof VillageSchema>;

export const PathStateSchema = z
  .object({
    active: z.boolean(),
    goal: Vec3Schema.nullable().optional(),
    status: z.enum(["idle", "running", "done", "failed", "cancelled"]),
    reason: z.string().max(256).optional(),
  })
  .strict();
export type PathState = z.infer<typeof PathStateSchema>;

export const ActiveActionSchema = z
  .object({
    id: z.string().min(1).max(128),
    type: z.string().min(1).max(64),
    startedAt: z.number().int().min(0),
    deadlineAt: z.number().int().min(0),
  })
  .strict();

export const ArmorSchema = z
  .object({
    head: ItemStackSchema.nullable(),
    chest: ItemStackSchema.nullable(),
    legs: ItemStackSchema.nullable(),
    feet: ItemStackSchema.nullable(),
    offhand: ItemStackSchema.nullable(),
  })
  .strict();
export type Armor = z.infer<typeof ArmorSchema>;

export const BotStateSchema = z
  .object({
    username: z.string().min(1).max(64),
    gameMode: z.enum(["survival", "creative", "adventure", "spectator"]),
    dimension: z.string().min(1).max(64),
    position: Vec3Schema,
    velocity: Vec3Schema.optional(),
    yaw: z.number().finite(),
    pitch: z.number().finite(),
    health: z.number().finite().min(0),
    maxHealth: z.number().finite().positive(),
    food: z.number().int().min(0).max(20),
    saturation: z.number().finite().min(0),
    air: z.number().int().min(0),
    maxAir: z.number().int().positive(),
    xpLevel: z.number().int().min(0),
    xpPoints: z.number().int().min(0),
    onGround: z.boolean(),
    inWater: z.boolean(),
    isSleeping: z.boolean(),
    selectedSlot: z.number().int().min(0).max(8),
    inventory: z.array(ItemStackSchema).max(64),
    armor: ArmorSchema,
    mainhand: ItemStackSchema.nullable(),
    currentScreen: z.string().max(64).nullable(),
    effects: z.array(ItemIdSchema).max(32),
    spawnPoint: Vec3Schema.nullable().optional(),
    path: PathStateSchema,
    action: ActiveActionSchema.nullable(),
  })
  .strict();
export type BotState = z.infer<typeof BotStateSchema>;

export const WorldStateSchema = z
  .object({
    timeOfDay: z.number().int().min(0).max(24000),
    day: z.number().int().min(0),
    weather: z.enum(["clear", "rain", "thunder"]),
    difficulty: z.enum(["peaceful", "easy", "normal", "hard"]),
    nearbyEntities: z.array(EntitySchema).max(256),
    nearbyBlocks: z.array(BlockSchema).max(512),
    villagers: z.array(VillagerSchema).max(128),
    village: VillageSchema.nullable(),
  })
  .strict();
export type WorldState = z.infer<typeof WorldStateSchema>;

export const SnapshotSchema = z
  .object({
    protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    seq: z.number().int().min(0),
    timestamp: z.number().int().min(0),
    adapter: z
      .object({
        name: z.string().min(1).max(64),
        version: z.string().min(1).max(32),
      })
      .strict(),
    bot: BotStateSchema,
    world: WorldStateSchema,
  })
  .strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Stable failure codes; task logic switches on these instead of message text. */
export const ActionErrorCodeSchema = z.enum([
  "OK",
  "INVALID_ACTION",
  "NOT_CONNECTED",
  "BUSY",
  "TIMEOUT",
  "CANCELLED",
  "GUARDRAIL_BLOCKED",
  "PLAYER_DEAD",
  "OUT_OF_RANGE",
  "NO_PATH",
  "BLOCK_NOT_FOUND",
  "MISSING_ITEM",
  "INVENTORY_FULL",
  "CRAFT_FAILED",
  "RECIPE_UNKNOWN",
  "TRADE_UNAVAILABLE",
  "TRADE_EXHAUSTED",
  "NOT_ENOUGH_EMERALDS",
  "LOW_XP",
  "ENCHANT_CONFLICT",
  "BED_UNAVAILABLE",
  "NOT_NIGHT",
  "HOSTILES_NEARBY",
  "ENTITY_NOT_FOUND",
  "UNSUPPORTED",
  "INTERNAL_ERROR",
]);
export type ActionErrorCode = z.infer<typeof ActionErrorCodeSchema>;

export const InventoryDeltaSchema = z
  .object({
    added: z.array(ItemStackSchema).max(256),
    removed: z.array(ItemStackSchema).max(256),
  })
  .strict();

export const AdapterEventSchema = z
  .object({
    type: z.string().min(1).max(64),
    level: z.enum(["debug", "info", "warn", "error"]).optional(),
    message: z.string().max(1024),
    data: z.record(z.string(), z.unknown()).optional(),
    timestamp: z.number().int().min(0),
  })
  .strict();
export type AdapterEvent = z.infer<typeof AdapterEventSchema>;

export const ActionResultSchema = z
  .object({
    protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    requestId: z.string().min(1).max(128),
    actionId: z.string().min(1).max(128),
    ok: z.boolean(),
    code: ActionErrorCodeSchema,
    reason: z.string().max(512).optional(),
    startedAt: z.number().int().min(0),
    endedAt: z.number().int().min(0),
    snapshotSeq: z.number().int().min(0),
    inventoryDelta: InventoryDeltaSchema.optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    events: z.array(AdapterEventSchema).max(64).optional(),
  })
  .strict();
export type ActionResult = z.infer<typeof ActionResultSchema>;

const timeout = z.number().int().min(50).max(120_000).optional();

export const NavigateActionSchema = z
  .object({
    type: z.literal("navigate"),
    target: Vec3Schema,
    range: z.number().min(0).max(64).optional(),
    timeoutMs: timeout,
  })
  .strict();

export const StopActionSchema = z.object({ type: z.literal("stop") }).strict();
export const WaitActionSchema = z
  .object({ type: z.literal("wait"), durationMs: z.number().int().min(50).max(300_000), timeoutMs: timeout })
  .strict();

export const CollectActionSchema = z
  .object({
    type: z.literal("collect"),
    item: ItemIdSchema,
    count: z.number().int().min(1).max(512),
    radius: z.number().min(1).max(128).optional(),
    timeoutMs: timeout,
  })
  .strict();

export const MineActionSchema = z
  .object({
    type: z.literal("mine"),
    position: Vec3Schema,
    blockType: ItemIdSchema.optional(),
    timeoutMs: timeout,
  })
  .strict();

export const PlaceActionSchema = z
  .object({
    type: z.literal("place"),
    item: ItemIdSchema,
    position: Vec3Schema,
    timeoutMs: timeout,
  })
  .strict();

export const CraftActionSchema = z
  .object({
    type: z.literal("craft"),
    item: ItemIdSchema,
    count: z.number().int().min(1).max(1024),
    timeoutMs: timeout,
  })
  .strict();

export const EatActionSchema = z
  .object({ type: z.literal("eat"), item: ItemIdSchema.optional(), timeoutMs: timeout })
  .strict();

export const SleepActionSchema = z
  .object({ type: z.literal("sleep"), bed: Vec3Schema.optional(), timeoutMs: timeout })
  .strict();

export const InspectTradesActionSchema = z
  .object({ type: z.literal("inspect_trades"), villagerId: z.string().min(1).max(128), timeoutMs: timeout })
  .strict();

export const TradeActionSchema = z
  .object({
    type: z.literal("trade"),
    villagerId: z.string().min(1).max(128),
    offerIndex: z.number().int().min(0).max(31),
    times: z.number().int().min(1).max(64).optional(),
    timeoutMs: timeout,
  })
  .strict();

export const RerollTradesActionSchema = z
  .object({ type: z.literal("reroll_trades"), villagerId: z.string().min(1).max(128), timeoutMs: timeout })
  .strict();

export const BreedActionSchema = z
  .object({
    type: z.literal("breed"),
    villagerIds: z.array(z.string().min(1).max(128)).length(2),
    food: ItemIdSchema.optional(),
    timeoutMs: timeout,
  })
  .strict();

export const EquipSlotSchema = z.enum(["head", "chest", "legs", "feet", "offhand", "mainhand"]);

export const EquipActionSchema = z
  .object({
    type: z.literal("equip"),
    item: ItemIdSchema,
    slot: EquipSlotSchema,
    timeoutMs: timeout,
  })
  .strict();

export const AttackActionSchema = z
  .object({
    type: z.literal("attack"),
    entityId: z.string().min(1).max(128).optional(),
    timeoutMs: timeout,
  })
  .strict();

export const FleeActionSchema = z
  .object({
    type: z.literal("flee"),
    entityId: z.string().min(1).max(128).optional(),
    distance: z.number().min(8).max(128).optional(),
    timeoutMs: timeout,
  })
  .strict();

export const ApplyBookActionSchema = z
  .object({
    type: z.literal("apply_book"),
    item: ItemIdSchema,
    book: ItemStackSchema,
    timeoutMs: timeout,
  })
  .strict();

export const DropActionSchema = z
  .object({
    type: z.literal("drop"),
    item: ItemIdSchema,
    count: z.number().int().min(1).max(64),
    timeoutMs: timeout,
  })
  .strict();

export const SurfaceActionSchema = z.object({ type: z.literal("surface"), timeoutMs: timeout }).strict();

export const ActionSchema = z.discriminatedUnion("type", [
  NavigateActionSchema,
  StopActionSchema,
  WaitActionSchema,
  CollectActionSchema,
  MineActionSchema,
  PlaceActionSchema,
  CraftActionSchema,
  EatActionSchema,
  SleepActionSchema,
  InspectTradesActionSchema,
  TradeActionSchema,
  RerollTradesActionSchema,
  BreedActionSchema,
  EquipActionSchema,
  AttackActionSchema,
  FleeActionSchema,
  ApplyBookActionSchema,
  DropActionSchema,
  SurfaceActionSchema,
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action["type"];

export const CapabilitySchema = z.enum([
  "navigate",
  "collect",
  "mine",
  "place",
  "craft",
  "eat",
  "sleep",
  "inspect_trades",
  "trade",
  "reroll_trades",
  "breed",
  "equip",
  "attack",
  "flee",
  "apply_book",
  "drop",
  "surface",
  "wait",
  "stop",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const AdapterInfoSchema = z
  .object({
    name: z.string().min(1).max(64),
    version: z.string().min(1).max(32),
    capabilities: z.array(CapabilitySchema),
  })
  .strict();
export type AdapterInfo = z.infer<typeof AdapterInfoSchema>;

export const AdapterLimitsSchema = z
  .object({
    maxActionTimeoutMs: z.number().int().min(1000).max(600_000),
    maxMessageBytes: z.number().int().min(1024).max(16 * 1024 * 1024),
    maxActionsPerMinute: z.number().int().min(1).optional(),
  })
  .strict();
export type AdapterLimits = z.infer<typeof AdapterLimitsSchema>;

export const ServerInfoSchema = z
  .object({
    address: z.string().min(1).max(256),
    version: z.string().min(1).max(64),
    software: z.string().min(1).max(64).optional(),
  })
  .strict();
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

export const HelloMessageSchema = z
  .object({
    type: z.literal("hello"),
    protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    client: z
      .object({
        name: z.string().min(1).max(64),
        version: z.string().min(1).max(32),
      })
      .strict(),
  })
  .strict();

export const HelloAckMessageSchema = z
  .object({
    type: z.literal("hello_ack"),
    protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    adapter: AdapterInfoSchema,
    limits: AdapterLimitsSchema,
    server: ServerInfoSchema.optional(),
    tickRate: z.number().min(1).max(120).optional(),
  })
  .strict();

export const SnapshotRequestMessageSchema = z
  .object({
    type: z.literal("snapshot_request"),
    requestId: z.string().min(1).max(128),
  })
  .strict();

export const SnapshotMessageSchema = z
  .object({
    type: z.literal("snapshot"),
    requestId: z.string().min(1).max(128),
    snapshot: SnapshotSchema,
  })
  .strict();

export const ExecuteMessageSchema = z
  .object({
    type: z.literal("execute"),
    requestId: z.string().min(1).max(128),
    actionId: z.string().min(1).max(128),
    action: ActionSchema,
  })
  .strict();

export const ResultMessageSchema = z
  .object({
    type: z.literal("result"),
    requestId: z.string().min(1).max(128),
    result: ActionResultSchema,
  })
  .strict();

export const CancelMessageSchema = z
  .object({
    type: z.literal("cancel"),
    requestId: z.string().min(1).max(128),
    targetActionId: z.string().min(1).max(128),
  })
  .strict();

export const EventMessageSchema = z
  .object({
    type: z.literal("event"),
    event: AdapterEventSchema,
  })
  .strict();

export const ErrorMessageSchema = z
  .object({
    type: z.literal("error"),
    requestId: z.string().min(1).max(128).optional(),
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(1024),
    retryable: z.boolean(),
  })
  .strict();

export const PingMessageSchema = z
  .object({
    type: z.literal("ping"),
    nonce: z.string().min(1).max(64),
  })
  .strict();

export const PongMessageSchema = z
  .object({
    type: z.literal("pong"),
    nonce: z.string().min(1).max(64),
  })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion("type", [
  HelloMessageSchema,
  SnapshotRequestMessageSchema,
  ExecuteMessageSchema,
  CancelMessageSchema,
  PingMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  HelloAckMessageSchema,
  SnapshotMessageSchema,
  ResultMessageSchema,
  EventMessageSchema,
  ErrorMessageSchema,
  PongMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const MAX_WIRE_MESSAGE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;

/** Parse and validate an unknown wire message, returning a typed value or throwing. */
export function parseClientMessage(value: unknown): ClientMessage {
  return ClientMessageSchema.parse(value);
}

export function parseServerMessage(value: unknown): ServerMessage {
  return ServerMessageSchema.parse(value);
}

export function parseAction(value: unknown): Action {
  return ActionSchema.parse(value);
}

/** Timeout carried by an action; some actions (stop) have no timeout field. */
export function actionTimeoutMs(action: Action): number | undefined {
  return "timeoutMs" in action ? action.timeoutMs : undefined;
}

export function isNamespaceItem(item: string, path?: string): boolean {
  return ItemIdSchema.safeParse(item).success && (path === undefined || item === `minecraft:${path}`);
}
