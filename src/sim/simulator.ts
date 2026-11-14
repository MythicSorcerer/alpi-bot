import {
  ActionSchema,
  PROTOCOL_VERSION,
  type Action,
  type ActionResult,
  type ActionErrorCode,
  type AdapterEvent,
  type AdapterInfo,
  type AdapterLimits,
  type Block,
  type Enchantment,
  type Entity,
  type ItemStack,
  type ServerInfo,
  type Snapshot,
  type Vec3,
  type Villager,
} from "../protocol/types.js";
import type { GameAdapter } from "../adapter/types.js";
import { addToInventory, countItem, describeItems, inventoryDelta, ns, removeFromInventory } from "../util/items.js";
import { distance, horizontalDistance } from "../util/vec.js";
import { Rng, stringSeed } from "./rng.js";
import { craftBatches, recipeFor, recipeOutputStack } from "./recipes.js";
import {
  grantVillagerXp,
  makeVillager,
  rerollVillager,
  restockVillager,
  villagerLevel,
  type SimVillager,
} from "./trades.js";

export type SimScenario = "default" | "hostile-night" | "scarce";

export interface SimulatedGameOptions {
  scenario?: SimScenario;
  seed?: number;
  villageDistance?: number;
  detectionRadius?: number;
  /** Start time in ticks; 6000 is morning. */
  startTime?: number;
  restockTicks?: number;
  logger?: { info(message: string, context?: Record<string, unknown>): void; warn(message: string, context?: Record<string, unknown>): void };
}

interface SimTree {
  position: Vec3;
  type: string;
  logs: number;
  regrowAt: number;
}

interface SimHostile {
  id: string;
  type: string;
  position: Vec3;
  health: number;
  lastAttackTick: number;
}

interface SimBot {
  username: string;
  position: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  food: number;
  saturation: number;
  air: number;
  xpPoints: number;
  onGround: boolean;
  inWater: boolean;
  isSleeping: boolean;
  selectedSlot: number;
  inventory: ItemStack[];
  armor: { head: ItemStack | null; chest: ItemStack | null; legs: ItemStack | null; feet: ItemStack | null; offhand: ItemStack | null };
  mainhand: ItemStack | null;
  spawnPoint: Vec3 | null;
}

interface Outcome {
  ok: boolean;
  code: ActionErrorCode;
  reason?: string;
  data?: Record<string, unknown>;
  delayMs?: number;
}

const INVENTORY_SLOTS = 36;
const RESTOCK_TICKS = 600;
const TICK_MS = 50;
const FOOD_VALUES: Record<string, number> = {
  "minecraft:bread": 6,
  "minecraft:cooked_beef": 8,
  "minecraft:cooked_porkchop": 8,
  "minecraft:baked_potato": 5,
  "minecraft:apple": 4,
  "minecraft:carrot": 3,
  "minecraft:golden_apple": 4,
};

const ENCHANT_CONFLICTS: string[][] = [
  [
    "minecraft:protection",
    "minecraft:fire_protection",
    "minecraft:blast_protection",
    "minecraft:projectile_protection",
  ],
  ["minecraft:sharpness", "minecraft:smite", "minecraft:bane_of_arthropods"],
];

const MAX_ENCHANT_LEVELS: Record<string, number> = {
  "minecraft:protection": 4,
  "minecraft:unbreaking": 3,
  "minecraft:mending": 1,
  "minecraft:feather_falling": 4,
  "minecraft:efficiency": 5,
  "minecraft:sharpness": 5,
  "minecraft:fortune": 3,
  "minecraft:depth_strider": 3,
};

/**
 * Deterministic, in-memory Minecraft-like world used to exercise the whole
 * controller without a graphical client. It models the player-visible
 * affordances the controller needs (movement, resources, trades, workstation
 * rerolls, enchanting, survival) rather than vanilla block physics.
 */
export class SimulatedGame implements GameAdapter {
  readonly info: AdapterInfo = {
    name: "MinecraftSimulator",
    version: "1.0.0",
    capabilities: [
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
    ],
  };
  readonly limits: AdapterLimits = {
    maxActionTimeoutMs: 60_000,
    maxMessageBytes: 4 * 1024 * 1024,
    maxActionsPerMinute: 1_200,
  };
  readonly server: ServerInfo = {
    address: "127.0.0.1:25565",
    version: "1.21.4",
    software: "simulated",
  };

  private readonly rng: Rng;
  private readonly scenario: SimScenario;
  private readonly seed: number;
  private readonly detectionRadius: number;
  private readonly restockTicks: number;
  private readonly startedAt = Date.now();
  private readonly villageCenter: Vec3;
  private readonly beds: Vec3[] = [];
  private readonly workstations: Vec3[] = [];
  private readonly trees: SimTree[] = [];
  private readonly hostiles: SimHostile[] = [];
  private readonly passiveAnimals: Entity[] = [];
  private readonly villagers: SimVillager[];
  private readonly bot: SimBot;
  private readonly startTime: number;
  private tick = 0;
  private seq = 0;
  private hungerTicks = 0;
  private starvationTicks = 0;
  private regenTicks = 0;
  private villagerCounter = 0;
  private pendingEvents: AdapterEvent[] = [];
  private stats = {
    trades: 0,
    emeraldsEarned: 0,
    emeraldsSpent: 0,
    logsCollected: 0,
    distanceMoved: 0,
    deaths: 0,
    rerolls: 0,
    booksApplied: 0,
  };

  constructor(options: SimulatedGameOptions = {}) {
    this.scenario = options.scenario ?? "default";
    this.seed = options.seed ?? 42;
    this.rng = new Rng(this.seed);
    this.detectionRadius = options.detectionRadius ?? 96;
    this.restockTicks = options.restockTicks ?? RESTOCK_TICKS;
    const villageDistance = options.villageDistance ?? 480;
    this.startTime = options.startTime ?? (this.scenario === "hostile-night" ? 14_000 : 6_000);
    this.villageCenter = { x: villageDistance, y: 64, z: 0 };

    this.generateVillage();
    this.generateTrees();
    this.villagers = this.generateVillagers();
    this.passiveAnimals.push(
      { id: "cow-1", type: "minecraft:cow", kind: "passive", position: { x: 12, y: 64, z: 10 } },
      { id: "sheep-1", type: "minecraft:sheep", kind: "passive", position: { x: -14, y: 64, z: 8 } },
    );
    if (this.scenario === "hostile-night") {
      this.hostiles.push(
        { id: "zombie-1", type: "minecraft:zombie", position: { x: 4, y: 64, z: 4 }, health: 20, lastAttackTick: 0 },
        { id: "zombie-2", type: "minecraft:zombie", position: { x: 12, y: 64, z: 6 }, health: 20, lastAttackTick: 0 },
      );
    }

    this.bot = {
      username: "MCBot",
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0,
      health: this.scenario === "hostile-night" ? 7 : 20,
      food: this.scenario === "hostile-night" ? 5 : 20,
      saturation: 5,
      air: 300,
      xpPoints: 0,
      onGround: true,
      inWater: false,
      isSleeping: false,
      selectedSlot: 0,
      inventory: this.startingInventory(),
      armor: { head: null, chest: null, legs: null, feet: null, offhand: null },
      mainhand: { item: "minecraft:stone_sword", count: 1, slot: 0 },
      spawnPoint: null,
    };
    this.normalizeInventory();
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async cancel(_actionId: string): Promise<void> {}

  getStats(): typeof this.stats & { deaths: number; ticks: number } {
    return { ...this.stats, ticks: this.tick };
  }

  getVillageCenter(): Vec3 {
    return { ...this.villageCenter };
  }

  snapshot(): Snapshot {
    const timeOfDay = (this.startTime + this.tick) % 24_000;
    const day = Math.floor((this.startTime + this.tick) / 24_000);
    const nearbyVillagers: Villager[] = this.villagers
      .filter((villager) => horizontalDistance(this.bot.position, villager.position) <= 64)
      .map((villager) => this.snapshotVillager(villager));
    const entities: Entity[] = [
      ...this.hostiles
        .filter((hostile) => distance(this.bot.position, hostile.position) <= 64)
        .map((hostile) => ({
          id: hostile.id,
          type: hostile.type,
          kind: "hostile" as const,
          position: hostile.position,
          health: hostile.health,
          distance: distance(this.bot.position, hostile.position),
        })),
      ...this.passiveAnimals
        .filter((animal) => distance(this.bot.position, animal.position) <= 64)
        .map((animal) => ({ ...animal, distance: distance(this.bot.position, animal.position) })),
    ];
    const blocks: Block[] = [];
    for (const tree of this.trees) {
      if (blocks.length >= 500) break;
      if (horizontalDistance(this.bot.position, tree.position) <= 32 && tree.logs > 0) {
        blocks.push({ type: tree.type, position: tree.position, hardness: 2 });
      }
    }
    for (const bed of this.beds) {
      if (horizontalDistance(this.bot.position, bed) <= 32) blocks.push({ type: "minecraft:red_bed", position: bed });
    }
    for (const station of this.workstations) {
      if (horizontalDistance(this.bot.position, station) <= 32) {
        blocks.push({ type: "minecraft:lectern", position: station });
      }
    }
    const villageVisible = horizontalDistance(this.bot.position, this.villageCenter) <= this.detectionRadius;
    const adults = this.villagers.filter((villager) => !villager.baby).length;
    return {
      protocolVersion: PROTOCOL_VERSION,
      seq: this.seq,
      timestamp: this.startedAt + this.tick * TICK_MS,
      adapter: { name: this.info.name, version: this.info.version },
      bot: {
        username: this.bot.username,
        gameMode: "survival",
        dimension: "minecraft:overworld",
        position: { ...this.bot.position },
        yaw: this.bot.yaw,
        pitch: this.bot.pitch,
        health: this.bot.health,
        maxHealth: 20,
        food: this.bot.food,
        saturation: this.bot.saturation,
        air: this.bot.air,
        maxAir: 300,
        xpLevel: Math.floor(this.bot.xpPoints / 10),
        xpPoints: this.bot.xpPoints,
        onGround: this.bot.onGround,
        inWater: this.bot.inWater,
        isSleeping: this.bot.isSleeping,
        selectedSlot: this.bot.selectedSlot,
        inventory: this.bot.inventory.map((stack, index) => ({ ...stack, slot: index })),
        armor: {
          head: this.bot.armor.head ? { ...this.bot.armor.head } : null,
          chest: this.bot.armor.chest ? { ...this.bot.armor.chest } : null,
          legs: this.bot.armor.legs ? { ...this.bot.armor.legs } : null,
          feet: this.bot.armor.feet ? { ...this.bot.armor.feet } : null,
          offhand: this.bot.armor.offhand ? { ...this.bot.armor.offhand } : null,
        },
        mainhand: this.bot.mainhand ? { ...this.bot.mainhand } : null,
        currentScreen: null,
        effects: [],
        spawnPoint: this.bot.spawnPoint ? { ...this.bot.spawnPoint } : null,
        path: { active: false, status: "idle" },
        action: null,
      },
      world: {
        timeOfDay,
        day,
        weather: "clear",
        difficulty: "normal",
        nearbyEntities: entities,
        nearbyBlocks: blocks,
        villagers: nearbyVillagers,
        village: villageVisible
          ? {
              id: "village-1",
              center: { ...this.villageCenter },
              radius: 40,
              population: adults,
              beds: this.beds.length,
              workstations: this.workstations.length,
              valid: adults >= 4 && this.beds.length >= adults && this.workstations.length >= 1,
            }
          : null,
      },
    };
  }

  async execute(action: Action, actionId: string, signal?: AbortSignal): Promise<ActionResult> {
    const startedAt = Date.now();
    const before = this.bot.inventory.map((stack) => ({ ...stack }));
    const seqBefore = this.seq;
    if (signal?.aborted) {
      return this.result(actionId, false, "CANCELLED", "action aborted", startedAt, before, undefined, seqBefore);
    }
    const parsed = ActionSchema.safeParse(action);
    if (!parsed.success) {
      return this.result(actionId, false, "INVALID_ACTION", parsed.error.issues[0]?.message ?? "invalid action", startedAt, before);
    }
    if (this.bot.health <= 0) {
      this.respawn();
      return this.result(actionId, false, "PLAYER_DEAD", "bot was dead and has respawned", startedAt, before);
    }
    let outcome: Outcome;
    try {
      outcome = this.perform(parsed.data);
    } catch (error) {
      outcome = { ok: false, code: "INTERNAL_ERROR", reason: (error as Error).message };
    }
    if (outcome.ok && outcome.delayMs) this.advance(outcome.delayMs);
    if (outcome.ok && parsed.data.type === "sleep") this.bot.isSleeping = false;
    if (outcome.code === "OK") this.seq += 1;
    const events = [...this.pendingEvents];
    this.pendingEvents = [];
    return this.result(
      actionId,
      outcome.ok,
      outcome.code,
      outcome.reason,
      startedAt,
      before,
      outcome.data,
      this.seq,
      undefined,
      events,
    );
  }

  private result(
    actionId: string,
    ok: boolean,
    code: ActionErrorCode,
    reason: string | undefined,
    startedAt: number,
    before: ItemStack[],
    data?: Record<string, unknown>,
    snapshotSeq = this.seq,
    overrideDelta?: { added: ItemStack[]; removed: ItemStack[] },
    events?: AdapterEvent[],
  ): ActionResult {
    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId: `sim-${actionId}`,
      actionId,
      ok,
      code,
      ...(reason ? { reason } : {}),
      startedAt,
      endedAt: Date.now(),
      snapshotSeq,
      inventoryDelta: overrideDelta ?? inventoryDelta(before, this.bot.inventory),
      ...(data ? { data } : {}),
      ...(events && events.length > 0 ? { events } : {}),
    };
  }

  private perform(action: Action): Outcome {
    switch (action.type) {
      case "navigate":
        return this.navigate(action);
      case "stop":
        return { ok: true, code: "OK", data: { stopped: true } };
      case "wait":
        return { ok: true, code: "OK", delayMs: action.durationMs, data: { waitedMs: action.durationMs } };
      case "collect":
        return this.collect(action);
      case "mine":
        return this.mine(action);
      case "place":
        return this.place(action);
      case "craft":
        return this.craft(action);
      case "eat":
        return this.eat(action);
      case "sleep":
        return this.sleep(action);
      case "inspect_trades":
        return this.inspectTrades(action.villagerId);
      case "trade":
        return this.trade(action);
      case "reroll_trades":
        return this.rerollTrades(action.villagerId);
      case "breed":
        return this.breed(action);
      case "equip":
        return this.equip(action);
      case "attack":
        return this.attack(action);
      case "flee":
        return this.flee(action);
      case "apply_book":
        return this.applyBook(action);
      case "drop":
        return this.drop(action);
      case "surface":
        return this.surface();
    }
  }

  private navigate(action: Extract<Action, { type: "navigate" }>): Outcome {
    const target = action.target;
    const travelled = distance(this.bot.position, target);
    if (travelled > 2_000) return { ok: false, code: "NO_PATH", reason: "target is outside the simulated world bounds" };
    const range = action.range ?? 2;
    const destination = travelled <= range ? { ...this.bot.position } : { ...target };
    const moved = distance(this.bot.position, destination);
    const yaw = (Math.atan2(destination.z - this.bot.position.z, destination.x - this.bot.position.x) * 180) / Math.PI;
    this.bot.position = destination;
    this.bot.yaw = yaw;
    this.bot.onGround = true;
    this.stats.distanceMoved += moved;
    return {
      ok: true,
      code: "OK",
      delayMs: Math.max(TICK_MS, Math.round((moved / 4.3) * 1_000)),
      data: { moved: round(moved), position: destination, arrived: moved <= range },
    };
  }

  private collect(action: Extract<Action, { type: "collect" }>): Outcome {
    if (action.item !== "minecraft:oak_log" && !action.item.endsWith("_log")) {
      return { ok: false, code: "BLOCK_NOT_FOUND", reason: `no collectable ${action.item} in the simulated world` };
    }
    const radius = action.radius ?? 64;
    const candidates = this.trees
      .filter((tree) => horizontalDistance(this.bot.position, tree.position) <= radius)
      .sort((a, b) => horizontalDistance(this.bot.position, a.position) - horizontalDistance(this.bot.position, b.position));
    let remaining = Math.min(action.count, 512);
    let collected = 0;
    const treesUsed: string[] = [];
    for (const tree of candidates) {
      if (remaining <= 0) break;
      if (tree.logs <= 0) {
        if (this.tick >= tree.regrowAt) tree.logs = 16;
        else continue;
      }
      const take = Math.min(tree.logs, remaining);
      try {
        this.bot.inventory = addToInventory(
          this.bot.inventory,
          { item: action.item, count: take },
          INVENTORY_SLOTS,
        );
      } catch {
        if (collected === 0) return { ok: false, code: "INVENTORY_FULL", reason: "inventory has no room for logs" };
        break;
      }
      tree.logs -= take;
      if (tree.logs === 0) tree.regrowAt = this.tick + 12_000;
      remaining -= take;
      collected += take;
      treesUsed.push(`${round(tree.position.x)},${round(tree.position.z)}`);
    }
    if (collected === 0) return { ok: false, code: "BLOCK_NOT_FOUND", reason: "no trees within range" };
    this.stats.logsCollected += collected;
    this.normalizeInventory();
    return {
      ok: true,
      code: "OK",
      delayMs: Math.max(TICK_MS, collected * 200),
      data: { collected, requested: action.count, trees: treesUsed.slice(0, 8), partial: collected < action.count },
    };
  }

  private mine(action: Extract<Action, { type: "mine" }>): Outcome {
    const index = this.trees.findIndex(
      (tree) => Math.floor(tree.position.x) === Math.floor(action.position.x) && Math.floor(tree.position.z) === Math.floor(action.position.z),
    );
    if (index < 0) return { ok: false, code: "BLOCK_NOT_FOUND", reason: "no known block at that position" };
    const tree = this.trees[index]!;
    if (distance(this.bot.position, tree.position) > 6) return { ok: false, code: "OUT_OF_RANGE", reason: "block is out of reach" };
    try {
      this.bot.inventory = addToInventory(this.bot.inventory, { item: tree.type, count: 1 }, INVENTORY_SLOTS);
    } catch {
      return { ok: false, code: "INVENTORY_FULL", reason: "inventory full" };
    }
    tree.logs -= 1;
    if (tree.logs <= 0) tree.regrowAt = this.tick + 12_000;
    this.normalizeInventory();
    return { ok: true, code: "OK", delayMs: 400, data: { block: tree.type, position: tree.position } };
  }

  private place(action: Extract<Action, { type: "place" }>): Outcome {
    try {
      this.bot.inventory = removeFromInventory(this.bot.inventory, action.item, 1);
    } catch {
      return { ok: false, code: "MISSING_ITEM", reason: `missing ${action.item}` };
    }
    if (action.item === "minecraft:red_bed") this.beds.push({ ...action.position });
    else this.workstations.push({ ...action.position });
    this.normalizeInventory();
    return { ok: true, code: "OK", delayMs: 500, data: { placed: action.item, position: action.position } };
  }

  private craft(action: Extract<Action, { type: "craft" }>): Outcome {
    const recipe = recipeFor(action.item);
    if (!recipe) return { ok: false, code: "RECIPE_UNKNOWN", reason: `no recipe for ${action.item}` };
    const batches = craftBatches(recipe, action.count);
    const inventory = this.bot.inventory.map((stack) => ({ ...stack }));
    for (const input of recipe.inputs) {
      if (countItem(inventory, input.item) < input.count * batches) {
        return {
          ok: false,
          code: "MISSING_ITEM",
          reason: `need ${input.count * batches}x ${input.item} for ${batches} craft(s)`,
        };
      }
    }
    let next = inventory;
    try {
      for (const input of recipe.inputs) {
        next = removeFromInventory(next, input.item, input.count * batches);
      }
      next = addToInventory(next, recipeOutputStack(recipe, batches), INVENTORY_SLOTS);
    } catch (error) {
      return { ok: false, code: "INVENTORY_FULL", reason: (error as Error).message };
    }
    this.bot.inventory = next;
    this.normalizeInventory();
    return {
      ok: true,
      code: "OK",
      delayMs: Math.max(TICK_MS, batches * 400),
      data: { crafted: recipe.output.item, count: recipe.output.count * batches, batches },
    };
  }

  private eat(action: Extract<Action, { type: "eat" }>): Outcome {
    if (this.bot.food >= 20) return { ok: true, code: "OK", data: { ate: false, food: this.bot.food } };
    const candidates = action.item
      ? [action.item]
      : Object.keys(FOOD_VALUES).filter((item) => countItem(this.bot.inventory, item) > 0);
    const food = candidates.find((item) => countItem(this.bot.inventory, item) > 0 && FOOD_VALUES[item] !== undefined);
    if (!food) return { ok: false, code: "MISSING_ITEM", reason: "no edible food in inventory" };
    this.bot.inventory = removeFromInventory(this.bot.inventory, food, 1);
    const value = FOOD_VALUES[food] ?? 4;
    this.bot.food = Math.min(20, this.bot.food + value);
    this.bot.saturation = Math.min(20, this.bot.saturation + value * 0.6);
    this.normalizeInventory();
    return { ok: true, code: "OK", delayMs: 1_600, data: { ate: true, food, hunger: this.bot.food } };
  }

  private sleep(action: Extract<Action, { type: "sleep" }>): Outcome {
    const time = (this.startTime + this.tick) % 24_000;
    const isNight = time >= 12_500 && time < 23_500;
    if (!isNight) return { ok: false, code: "NOT_NIGHT", reason: "it is not night" };
    const threat = this.hostiles.find((hostile) => distance(this.bot.position, hostile.position) <= 8);
    if (threat) return { ok: false, code: "HOSTILES_NEARBY", reason: `${threat.type} is nearby` };
    const bed = action.bed ?? this.beds.find((candidate) => horizontalDistance(this.bot.position, candidate) <= 8);
    if (!bed) return { ok: false, code: "BED_UNAVAILABLE", reason: "no reachable bed" };
    this.bot.position = { ...bed };
    this.bot.spawnPoint = { ...bed };
    this.bot.isSleeping = true;
    this.bot.health = Math.min(20, this.bot.health + 2);
    const untilMorning = ((24_000 - time) % 24_000) + 1_000;
    return {
      ok: true,
      code: "OK",
      delayMs: untilMorning * TICK_MS,
      data: { slept: true, bed, wakeTime: 1_000, spawnPoint: this.bot.spawnPoint },
    };
  }

  private inspectTrades(villagerId: string): Outcome {
    const villager = this.villagers.find((candidate) => candidate.id === villagerId);
    if (!villager) return { ok: false, code: "ENTITY_NOT_FOUND", reason: `unknown villager ${villagerId}` };
    const range = distance(this.bot.position, villager.position);
    if (range > 6) return { ok: false, code: "OUT_OF_RANGE", reason: `villager is ${round(range)} blocks away` };
    villager.tradesKnown = true;
    return {
      ok: true,
      code: "OK",
      delayMs: 200,
      data: { villagerId, profession: villager.profession, level: villager.level, trades: villager.trades },
    };
  }

  private trade(action: Extract<Action, { type: "trade" }>): Outcome {
    const villager = this.villagers.find((candidate) => candidate.id === action.villagerId);
    if (!villager) return { ok: false, code: "ENTITY_NOT_FOUND", reason: `unknown villager ${action.villagerId}` };
    if (distance(this.bot.position, villager.position) > 6) {
      return { ok: false, code: "OUT_OF_RANGE", reason: "villager is out of reach" };
    }
    const offer = villager.trades.find((candidate) => candidate.index === action.offerIndex);
    if (!offer) return { ok: false, code: "TRADE_UNAVAILABLE", reason: "unknown trade index" };
    if (villager.level < offer.minLevel) return { ok: false, code: "TRADE_UNAVAILABLE", reason: "villager level too low" };
    const times = Math.min(action.times ?? 1, offer.maxUses - offer.uses);
    if (times <= 0) return { ok: false, code: "TRADE_EXHAUSTED", reason: "trade has no uses left; wait for restock" };
    const inventory = this.bot.inventory.map((stack) => ({ ...stack }));
    for (const input of offer.inputs) {
      if (countItem(inventory, input.item) < input.count * times) {
        return {
          ok: false,
          code: "MISSING_ITEM",
          reason: `need ${input.count * times}x ${input.item} for ${times} trade(s)`,
        };
      }
    }
    let next = inventory;
    try {
      for (const input of offer.inputs) next = removeFromInventory(next, input.item, input.count * times);
      next = addToInventory(
        next,
        { ...offer.output, count: offer.output.count * times },
        INVENTORY_SLOTS,
      );
    } catch (error) {
      return { ok: false, code: "INVENTORY_FULL", reason: (error as Error).message };
    }
    this.bot.inventory = next;
    this.normalizeInventory();
    offer.uses += times;
    const xp = offer.rewardXp * times;
    const leveled = grantVillagerXp(villager, xp);
    this.bot.xpPoints += xp;
    this.stats.trades += times;
    for (const input of offer.inputs) {
      if (input.item === "minecraft:emerald") this.stats.emeraldsSpent += input.count * times;
    }
    if (offer.output.item === "minecraft:emerald") this.stats.emeraldsEarned += offer.output.count * times;
    if (leveled) {
      this.pendingEvents.push({
        type: "villager_levelup",
        level: "info",
        message: `${villager.profession} reached level ${villager.level}`,
        timestamp: this.startedAt + this.tick * TICK_MS,
      });
    }
    return {
      ok: true,
      code: "OK",
      delayMs: Math.max(TICK_MS, times * 800),
      data: {
        villagerId: villager.id,
        offerIndex: offer.index,
        times,
        usesLeft: offer.maxUses - offer.uses,
        villagerLevel: villager.level,
        spent: offer.inputs.map((input) => ({ item: input.item, count: input.count * times })),
        received: { ...offer.output, count: offer.output.count * times },
        xpGained: xp,
        botXpLevel: Math.floor(this.bot.xpPoints / 10),
      },
    };
  }

  private rerollTrades(villagerId: string): Outcome {
    const villager = this.villagers.find((candidate) => candidate.id === villagerId);
    if (!villager) return { ok: false, code: "ENTITY_NOT_FOUND", reason: `unknown villager ${villagerId}` };
    if (villager.profession !== "librarian") {
      return { ok: false, code: "UNSUPPORTED", reason: "workstation rerolling is only modelled for librarians" };
    }
    if (distance(this.bot.position, villager.position) > 6) {
      return { ok: false, code: "OUT_OF_RANGE", reason: "villager is out of reach" };
    }
    rerollVillager(villager);
    villager.tradesKnown = true;
    this.stats.rerolls += 1;
    return {
      ok: true,
      code: "OK",
      delayMs: 2_000,
      data: { villagerId, rerolls: villager.rerolls, trades: villager.trades },
    };
  }

  private breed(action: Extract<Action, { type: "breed" }>): Outcome {
    const villagers = action.villagerIds
      .map((id) => this.villagers.find((candidate) => candidate.id === id))
      .filter((villager): villager is SimVillager => Boolean(villager));
    if (villagers.length < 2) return { ok: false, code: "ENTITY_NOT_FOUND", reason: "need two villagers" };
    if (villagers.some((villager) => distance(this.bot.position, villager.position) > 8)) {
      return { ok: false, code: "OUT_OF_RANGE", reason: "villagers must be close" };
    }
    const food = action.food ?? "minecraft:bread";
    if (countItem(this.bot.inventory, food) < 6) {
      return { ok: false, code: "MISSING_ITEM", reason: `need 6x ${food} to breed` };
    }
    const adults = this.villagers.filter((villager) => !villager.baby).length;
    if (this.beds.length < adults + 1) {
      return {
        ok: false,
        code: "BED_UNAVAILABLE",
        reason: `need another bed (${this.beds.length} beds for ${adults} adults)`,
      };
    }
    try {
      this.bot.inventory = removeFromInventory(this.bot.inventory, food, 6);
    } catch {
      return { ok: false, code: "MISSING_ITEM", reason: `need 6x ${food}` };
    }
    this.villagerCounter += 1;
    const id = `baby-${this.villagerCounter}`;
    const position = { x: this.villageCenter.x + 2, y: 64, z: this.villageCenter.z + 2 };
    const baby = makeVillager(id, "unemployed", position, this.tick + this.restockTicks, 0, true);
    baby.growAt = this.tick + 2_400;
    this.villagers.push(baby);
    this.normalizeInventory();
    return {
      ok: true,
      code: "OK",
      delayMs: 60_000,
      data: { born: id, population: this.villagers.length },
    };
  }

  private equip(action: Extract<Action, { type: "equip" }>): Outcome {
    const index = this.bot.inventory.findIndex((stack) => stack.item === action.item);
    if (index < 0) return { ok: false, code: "MISSING_ITEM", reason: `missing ${action.item}` };
    const inventory = this.bot.inventory.map((stack) => ({ ...stack }));
    const [item] = inventory.splice(index, 1);
    if (!item) return { ok: false, code: "MISSING_ITEM", reason: `missing ${action.item}` };
    const candidate = this.bot.armor[action.slot as "head" | "chest" | "legs" | "feet" | "offhand"];
    let previous: ItemStack | null = null;
    if (action.slot === "mainhand") {
      previous = this.bot.mainhand;
      this.bot.mainhand = { ...item, slot: undefined };
    } else if (candidate !== undefined) {
      previous = candidate;
      this.bot.armor[action.slot as "head" | "chest" | "legs" | "feet" | "offhand"] = { ...item, slot: undefined };
    } else {
      return { ok: false, code: "INVALID_ACTION", reason: `unknown equipment slot ${action.slot}` };
    }
    try {
      if (previous) this.bot.inventory = addToInventory(inventory, previous, INVENTORY_SLOTS);
      else this.bot.inventory = inventory;
    } catch {
      if (action.slot === "mainhand") this.bot.mainhand = previous;
      else this.bot.armor[action.slot as "head" | "chest" | "legs" | "feet" | "offhand"] = previous;
      return { ok: false, code: "INVENTORY_FULL", reason: "no room for the previously equipped item" };
    }
    this.normalizeInventory();
    return { ok: true, code: "OK", delayMs: 400, data: { equipped: item, slot: action.slot } };
  }

  private attack(action: Extract<Action, { type: "attack" }>): Outcome {
    let target = action.entityId
      ? this.hostiles.find((hostile) => hostile.id === action.entityId)
      : this.hostiles
          .filter((hostile) => distance(this.bot.position, hostile.position) <= 4)
          .sort((a, b) => distance(this.bot.position, a.position) - distance(this.bot.position, b.position))[0];
    if (!target) return { ok: false, code: "ENTITY_NOT_FOUND", reason: "no hostile target in reach" };
    if (distance(this.bot.position, target.position) > 4) return { ok: false, code: "OUT_OF_RANGE", reason: "target is out of reach" };
    const damage = this.bot.mainhand?.item.includes("sword") ? 7 : 4;
    target.health -= damage;
    const killed = target.health <= 0;
    if (killed) {
      this.hostiles.splice(this.hostiles.indexOf(target), 1);
      try {
        this.bot.inventory = addToInventory(this.bot.inventory, { item: "minecraft:rotten_flesh", count: 1 }, INVENTORY_SLOTS);
        this.normalizeInventory();
      } catch {
        // drops are lost when the inventory is full
      }
    }
    return {
      ok: true,
      code: "OK",
      delayMs: 1_000,
      data: { target: target.id, damage, killed, remainingHealth: Math.max(0, target.health) },
    };
  }

  private flee(action: Extract<Action, { type: "flee" }>): Outcome {
    const target = action.entityId
      ? this.hostiles.find((hostile) => hostile.id === action.entityId)
      : this.hostiles
          .filter((hostile) => distance(this.bot.position, hostile.position) <= 16)
          .sort((a, b) => distance(this.bot.position, a.position) - distance(this.bot.position, b.position))[0];
    if (!target) return { ok: false, code: "ENTITY_NOT_FOUND", reason: "no hostile to flee from" };
    const away = {
      x: this.bot.position.x - target.position.x,
      y: 0,
      z: this.bot.position.z - target.position.z,
    };
    const length = Math.hypot(away.x, away.z) || 1;
    const run = action.distance ?? 24;
    this.bot.position = {
      x: this.bot.position.x + (away.x / length) * run,
      y: 64,
      z: this.bot.position.z + (away.z / length) * run,
    };
    this.stats.distanceMoved += run;
    return { ok: true, code: "OK", delayMs: Math.round((run / 5.6) * 1_000), data: { ran: run, from: target.id } };
  }

  private applyBook(action: Extract<Action, { type: "apply_book" }>): Outcome {
    const bookIndex = this.bot.inventory.findIndex(
      (stack) =>
        stack.item === "minecraft:enchanted_book" &&
        stack.enchants &&
        stack.enchants.length > 0 &&
        (action.book.enchants ?? []).every((wanted) =>
          stack.enchants!.some((held) => held.id === wanted.id && held.level >= wanted.level),
        ),
    );
    if (bookIndex < 0) return { ok: false, code: "MISSING_ITEM", reason: "requested enchanted book is not in inventory" };
    const targetIndex = this.bot.inventory.findIndex((stack) => stack.item === action.item);
    if (targetIndex < 0) return { ok: false, code: "MISSING_ITEM", reason: `missing ${action.item}` };
    const inventory = this.bot.inventory.map((stack) => ({ ...stack, enchants: stack.enchants?.map((e) => ({ ...e })) }));
    const book = inventory[bookIndex]!;
    const target = inventory[targetIndex]!;
    const merged = mergeEnchantments(target.enchants ?? [], book.enchants ?? []);
    if (!merged.ok) return { ok: false, code: "ENCHANT_CONFLICT", reason: merged.reason };
    const costLevels = 2;
    const costPoints = costLevels * 10;
    if (this.bot.xpPoints < costPoints) {
      return {
        ok: false,
        code: "LOW_XP",
        reason: `need ${costLevels} levels (${costPoints} xp points), have ${this.bot.xpPoints}`,
      };
    }
    inventory.splice(bookIndex, 1);
    const targetAfter = inventory[targetIndex > bookIndex ? targetIndex - 1 : targetIndex]!;
    targetAfter.enchants = merged.enchants;
    this.bot.inventory = inventory;
    this.bot.xpPoints -= costPoints;
    this.normalizeInventory();
    this.stats.booksApplied += 1;
    return {
      ok: true,
      code: "OK",
      delayMs: 5_000,
      data: { item: action.item, applied: book.enchants, costLevels, enchantments: merged.enchants },
    };
  }

  private drop(action: Extract<Action, { type: "drop" }>): Outcome {
    try {
      this.bot.inventory = removeFromInventory(this.bot.inventory, action.item, action.count);
    } catch {
      return { ok: false, code: "MISSING_ITEM", reason: `missing ${action.count}x ${action.item}` };
    }
    this.normalizeInventory();
    return { ok: true, code: "OK", delayMs: 300, data: { dropped: action.item, count: action.count } };
  }

  private surface(): Outcome {
    if (!this.bot.inWater) return { ok: true, code: "OK", data: { surfaced: false } };
    this.bot.position = { ...this.bot.position, y: Math.max(64, this.bot.position.y + 3) };
    this.bot.inWater = false;
    this.bot.air = 300;
    return { ok: true, code: "OK", delayMs: 1_000, data: { surfaced: true, position: this.bot.position } };
  }

  private snapshotVillager(villager: SimVillager): Villager {
    const grown = villager.baby && villager.growAt !== undefined && this.tick >= villager.growAt;
    return {
      id: villager.id,
      profession: villager.profession,
      level: villager.level,
      xp: villager.xp,
      position: { ...villager.position },
      tradesKnown: villager.tradesKnown,
      ...(villager.tradesKnown ? { trades: villager.trades.map((trade) => ({ ...trade })) } : {}),
      sleeping: villager.sleeping,
      baby: Boolean(villager.baby && !grown),
      workstation: villager.workstation ?? null,
      restockAt: villager.restockAt,
    };
  }

  private advance(ms: number): void {
    const ticks = Math.max(0, Math.round(ms / TICK_MS));
    if (ticks <= 0) return;
    this.tick += ticks;
    this.hungerTicks += ticks;
    while (this.hungerTicks >= 1_600) {
      this.hungerTicks -= 1_600;
      if (this.bot.saturation > 0) this.bot.saturation = Math.max(0, this.bot.saturation - 1);
      else this.bot.food = Math.max(0, this.bot.food - 1);
    }
    if (this.bot.food <= 0) {
      this.starvationTicks += ticks;
      while (this.starvationTicks >= 800) {
        this.starvationTicks -= 800;
        this.bot.health = Math.max(0, this.bot.health - 1);
      }
    } else {
      this.starvationTicks = 0;
    }
    if (this.bot.food >= 18 && this.bot.health < 20) {
      this.regenTicks += ticks;
      while (this.regenTicks >= 600) {
        this.regenTicks -= 600;
        this.bot.health = Math.min(20, this.bot.health + 1);
      }
    }
    for (const villager of this.villagers) {
      if (villager.baby && villager.growAt !== undefined && this.tick >= villager.growAt) {
        villager.baby = false;
        this.pendingEvents.push({
          type: "villager_grown",
          level: "info",
          message: `${villager.id} grew up`,
          timestamp: this.startedAt + this.tick * TICK_MS,
        });
      }
      if (this.tick >= villager.restockAt) {
        restockVillager(villager, this.tick + this.restockTicks);
      }
    }
    for (const hostile of this.hostiles) {
      if (distance(this.bot.position, hostile.position) <= 3 && this.tick - hostile.lastAttackTick >= 40) {
        hostile.lastAttackTick = this.tick;
        this.bot.health = Math.max(0, this.bot.health - 2);
      }
    }
    if (this.bot.health <= 0) this.respawn();
  }

  private respawn(): void {
    this.stats.deaths += 1;
    this.bot.health = 20;
    this.bot.food = 20;
    this.bot.saturation = 5;
    this.bot.isSleeping = false;
    this.bot.position = this.bot.spawnPoint ? { ...this.bot.spawnPoint } : { x: 0, y: 64, z: 0 };
    this.pendingEvents.push({
      type: "respawn",
      level: "warn",
      message: "bot died and respawned",
      timestamp: this.startedAt + this.tick * TICK_MS,
    });
  }

  private startingInventory(): ItemStack[] {
    const items: ItemStack[] = [
      { item: "minecraft:bread", count: 16 },
      { item: "minecraft:stone_pickaxe", count: 1 },
      { item: "minecraft:stone_axe", count: 1 },
      { item: "minecraft:oak_log", count: this.scenario === "scarce" ? 8 : 32 },
    ];
    return items;
  }

  private normalizeInventory(): void {
    this.bot.inventory = this.bot.inventory.map((stack, index) => ({ ...stack, slot: index }));
  }

  private generateVillage(): void {
    const { x, y, z } = this.villageCenter;
    for (let i = 0; i < 10; i += 1) {
      const angle = (i / 10) * Math.PI * 2;
      this.beds.push({
        x: Math.round(x + Math.cos(angle) * 5),
        y,
        z: Math.round(z + Math.sin(angle) * 5),
      });
    }
    const stationOffsets: Array<[number, number]> = [
      [-8, 4],
      [8, 4],
      [-6, -6],
      [6, -6],
      [0, 12],
    ];
    for (const [dx, dz] of stationOffsets) {
      this.workstations.push({ x: x + dx, y, z: z + dz });
    }
  }

  private generateTrees(): void {
    const count = this.scenario === "scarce" ? 30 : 500;
    const spawnCount = this.scenario === "scarce" ? 10 : 80;
    const place = (center: Vec3, radius: number, amount: number) => {
      for (let i = 0; i < amount; i += 1) {
        const angle = this.rng.next() * Math.PI * 2;
        const r = 14 + this.rng.next() * (radius - 14);
        this.trees.push({
          position: {
            x: Math.round(center.x + Math.cos(angle) * r),
            y: 64,
            z: Math.round(center.z + Math.sin(angle) * r),
          },
          type: "minecraft:oak_log",
          logs: 16,
          regrowAt: 0,
        });
      }
    };
    place(this.villageCenter, 140, count);
    place({ x: 0, y: 64, z: 0 }, 80, spawnCount);
  }

  private generateVillagers(): SimVillager[] {
    const { x, y, z } = this.villageCenter;
    const definitions: Array<[string, string, number, number]> = [
      ["villager-farmer", "farmer", -8, 4],
      ["villager-fletcher", "fletcher", 8, 4],
      ["villager-armorer", "armorer", -6, -6],
      ["villager-toolsmith", "toolsmith", 6, -6],
      ["villager-weaponsmith", "weaponsmith", 0, -10],
      ["villager-librarian-1", "librarian", -12, 0],
      ["villager-librarian-2", "librarian", 12, 0],
      ["villager-librarian-3", "librarian", 0, 14],
    ];
    return definitions.map(([id, profession, dx, dz]) =>
      makeVillager(id, profession, { x: x + dx, y, z: z + dz }, this.restockTicks, 0),
    );
  }
}

function mergeEnchantments(
  current: Enchantment[],
  incoming: Enchantment[],
): { ok: true; enchants: Enchantment[] } | { ok: false; reason: string } {
  const next = current.map((enchant) => ({ ...enchant }));
  for (const enchant of incoming) {
    const max = MAX_ENCHANT_LEVELS[enchant.id];
    if (max !== undefined && enchant.level > max) {
      return { ok: false, reason: `${enchant.id} level ${enchant.level} exceeds ${max}` };
    }
    for (const group of ENCHANT_CONFLICTS) {
      if (!group.includes(enchant.id)) continue;
      const existing = next.find((candidate) => group.includes(candidate.id) && candidate.id !== enchant.id);
      if (existing) return { ok: false, reason: `${enchant.id} conflicts with ${existing.id}` };
    }
    const existing = next.find((candidate) => candidate.id === enchant.id);
    if (existing) existing.level = Math.max(existing.level, enchant.level);
    else next.push({ ...enchant });
  }
  return { ok: true, enchants: next };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Keep imports used by tests and future scenario tooling from being tree-shaken ambiguously. */
export { describeItems, ns, villagerLevel, stringSeed };
