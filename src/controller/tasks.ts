import type { Config } from "../config.js";
import type { Logger } from "../logging/logger.js";
import type { Action, ActionResult, ItemStack, Snapshot, TradeOffer, Vec3, Villager } from "../protocol/types.js";
import type { Ledger, Metrics } from "./state.js";
import {
  enchantLevel,
  equipSlotFor,
  findItemStacks,
  remainingEnchantNeeds,
  verifyGear,
} from "../gear/checklist.js";
import { countItem } from "../util/items.js";
import { distance } from "../util/vec.js";

export type TaskNeed = "emeralds" | "xp";

export interface TaskResult {
  status: "done" | "retry" | "failed";
  reason?: string;
  need?: TaskNeed;
  amount?: number;
}

export interface TaskActOptions {
  skipReflex?: boolean;
  timeoutMs?: number;
}

export interface TaskContext {
  readonly config: Config;
  readonly logger: Logger;
  readonly state: Record<string, unknown>;
  readonly snapshot: Snapshot;
  readonly ledger: Ledger;
  readonly metrics: Metrics;
  act(action: Action, options?: TaskActOptions): Promise<ActionResult>;
  refresh(): Promise<Snapshot>;
  note(text: string): void;
  log(event: string, data?: unknown, level?: "debug" | "info" | "warn" | "error"): void;
  recordTrade(result: ActionResult, villagerId: string, offerIndex: number): void;
  freeSpace(): Promise<boolean>;
}

export interface Task {
  readonly goal: string;
  run(ctx: TaskContext): Promise<TaskResult>;
}

const JUNK = ["minecraft:arrow", "minecraft:rotten_flesh", "minecraft:poisonous_potato", "minecraft:wheat_seeds"];

const FOOD_ITEMS = [
  "minecraft:cooked_beef",
  "minecraft:cooked_porkchop",
  "minecraft:bread",
  "minecraft:baked_potato",
  "minecraft:apple",
  "minecraft:carrot",
];

function foodStock(ctx: TaskContext): number {
  return FOOD_ITEMS.reduce((sum, item) => sum + countItem(ctx.snapshot.bot.inventory, item), 0);
}

/**
 * Keep a small food reserve before long task loops. The reflex layer eats from
 * the inventory; this tops that inventory up from a farmer when emeralds are
 * available, so a long economy run does not starve with an empty larder.
 */
async function ensureFood(ctx: TaskContext): Promise<boolean> {
  const { bot } = ctx.snapshot;
  const keep = ctx.config.economy.keepFood;
  const stock = foodStock(ctx);
  if (stock >= keep) return true;
  const farmer = ctx.snapshot.world.villagers.find((villager) => villager.profession === "farmer");
  if (!farmer) return false;
  const inspected = await inspectVillager(ctx, farmer.id);
  if (!inspected) return false;
  const offer = inspected.trades?.find(
    (candidate) =>
      FOOD_ITEMS.includes(candidate.output.item) &&
      candidate.minLevel <= inspected.level &&
      candidate.uses < candidate.maxUses,
  );
  if (!offer) return false;
  const price = emeraldPrice(offer);
  if (price > countItem(bot.inventory, "minecraft:emerald")) return false;
  const missing = Math.max(1, keep - stock);
  const times = Math.min(
    offer.maxUses - offer.uses,
    Math.max(1, Math.ceil(missing / offer.output.count)),
  );
  const result = await ctx.act({
    type: "trade",
    villagerId: inspected.id,
    offerIndex: offer.index,
    times,
    timeoutMs: 30_000,
  });
  if (!result.ok) {
    ctx.log("food.purchase_failed", { code: result.code, reason: result.reason }, "debug");
    return false;
  }
  ctx.recordTrade(result, inspected.id, offer.index);
  ctx.note(`bought ${times * offer.output.count}x ${offer.output.item} to keep a food reserve`);
  await ctx.refresh();
  return true;
}

export class ExploreTask implements Task {
  readonly goal = "explore_village";

  async run(ctx: TaskContext): Promise<TaskResult> {
    let waypoints = ctx.state.waypoints as Vec3[] | undefined;
    if (!waypoints) {
      waypoints = buildFrontier(ctx.snapshot.bot.position, ctx.config);
      ctx.state.waypoints = waypoints;
      ctx.state.index = 0;
      ctx.state.failures = 0;
    }
    let index = (ctx.state.index as number | undefined) ?? 0;
    let failures = (ctx.state.failures as number | undefined) ?? 0;

    if (ctx.snapshot.world.village?.valid) return arriveAtVillage(ctx);

    while (index < waypoints.length) {
      const target = waypoints[index]!;
      ctx.state.index = index;
      ctx.log("explore.waypoint", { index, target, total: waypoints.length });
      const result = await ctx.act({
        type: "navigate",
        target,
        range: 6,
        timeoutMs: 30_000,
      });
      if (!result.ok) {
        failures += 1;
        ctx.state.failures = failures;
        ctx.log("explore.navigate_failed", { target, code: result.code, reason: result.reason }, "warn");
        if (failures >= 3) {
          return { status: "failed", reason: `exploration blocked after 3 navigation failures: ${result.reason ?? result.code}` };
        }
        continue;
      }
      failures = 0;
      index += 1;
      ctx.state.index = index;
      await ctx.refresh();
      if (ctx.snapshot.world.village) {
        if (ctx.snapshot.world.village.valid) return arriveAtVillage(ctx);
        ctx.note(`found an invalid village at ${JSON.stringify(ctx.snapshot.world.village.center)}; continuing`);
      }
    }
    return {
      status: "failed",
      reason: `no viable village found within ${ctx.config.exploration.maxDistanceBlocks} blocks (${waypoints.length} waypoints searched)`,
    };
  }
}

async function arriveAtVillage(ctx: TaskContext): Promise<TaskResult> {
  const village = ctx.snapshot.world.village;
  if (!village) return { status: "retry", reason: "village disappeared from view" };
  const result = await ctx.act({ type: "navigate", target: village.center, range: 5, timeoutMs: 30_000 });
  if (!result.ok) return { status: "retry", reason: `could not walk to village center: ${result.reason ?? result.code}` };
  await ctx.refresh();
  const current = ctx.snapshot.world.village;
  if (!current?.valid) return { status: "failed", reason: "observed village failed validation (population/beds/workstations)" };
  ctx.note(`reached viable village with ${current.population} villagers at ${JSON.stringify(current.center)}`);
  return { status: "done", reason: "viable village reached" };
}

export function buildFrontier(origin: Vec3, config: Config): Vec3[] {
  const directions: Array<[number, number]> = [
    [1, 0],
    [0, 1],
    [0, -1],
    [-1, 0],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];
  const points: Vec3[] = [];
  const step = config.exploration.stepBlocks;
  for (const [dx, dz] of directions) {
    const length = Math.hypot(dx, dz);
    for (let radius = step; radius <= config.exploration.maxDistanceBlocks; radius += step) {
      points.push({
        x: origin.x + (dx / length) * radius,
        y: origin.y,
        z: origin.z + (dz / length) * radius,
      });
      if (points.length >= config.exploration.maxWaypoints) return points;
    }
  }
  return points;
}

export class SettleTask implements Task {
  readonly goal = "settle";

  async run(ctx: TaskContext): Promise<TaskResult> {
    const village = ctx.snapshot.world.village;
    if (!village) return { status: "retry", reason: "no village visible; re-running exploration" };
    if (!village.valid) {
      return { status: "failed", reason: "village does not meet the population/bed/workstation minimum" };
    }
    if (village.population < ctx.config.settlement.minPopulation) {
      return {
        status: "failed",
        reason: `village population ${village.population} is below settlement.minPopulation=${ctx.config.settlement.minPopulation}`,
      };
    }
    const approach = await ctx.act({ type: "navigate", target: village.center, range: 4, timeoutMs: 30_000 });
    if (!approach.ok) return { status: "retry", reason: `could not reach village center: ${approach.reason ?? approach.code}` };
    await ctx.refresh();

    const snapshot = ctx.snapshot;
    const isNight = snapshot.world.timeOfDay >= 12_500 && snapshot.world.timeOfDay < 23_500;
    const bed = snapshot.world.nearbyBlocks.find(
      (block) =>
        block.type.includes("bed") &&
        Math.hypot(block.position.x - snapshot.bot.position.x, block.position.z - snapshot.bot.position.z) <= 8,
    );
    if (isNight && ctx.config.settlement.sleepAtNight && bed && !snapshot.bot.spawnPoint) {
      const sleep = await ctx.act({ type: "sleep", bed: bed.position, timeoutMs: 30_000 });
      if (!sleep.ok && sleep.code !== "NOT_NIGHT") {
        ctx.log("settle.sleep_failed", { code: sleep.code, reason: sleep.reason }, "warn");
      }
      await ctx.refresh();
    }

    if (ctx.snapshot.bot.spawnPoint) {
      ctx.note(`spawn point set at ${JSON.stringify(ctx.snapshot.bot.spawnPoint)}`);
    } else if (!ctx.config.settlement.sleepAtNight) {
      ctx.note("settlement.sleepAtNight is disabled; only the survival reflex may still use a bed");
    } else {
      ctx.note("village reached during daylight; sleeping tonight will lock the spawn point");
    }
    ctx.note(`settled at village with ${ctx.snapshot.world.village?.population ?? village.population} villagers`);
    return { status: "done", reason: "village validated and settlement established" };
  }
}

export class EconomyTask implements Task {
  readonly goal = "earn_emeralds";

  constructor(private readonly targetOverride?: number) {}

  async run(ctx: TaskContext): Promise<TaskResult> {
    const target = this.targetOverride ?? ctx.config.economy.emeraldTarget;
    const state = ctx.state;
    state.target = target;
    let restocks = (state.restocks as number | undefined) ?? 0;
    let failures = 0;

    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      if (countItem(ctx.snapshot.bot.inventory, "minecraft:emerald") >= target) {
        return { status: "done", reason: `emerald target ${target} reached` };
      }
      if (ctx.snapshot.bot.inventory.length >= ctx.config.economy.dropThreshold) {
        await ctx.freeSpace();
        await ctx.refresh();
      }
      await ensureFood(ctx);

      const fletcher = await ensureVillager(ctx, "fletcher");
      if (!fletcher) return { status: "failed", reason: "no fletcher villager is visible in the village" };
      if (distance(ctx.snapshot.bot.position, fletcher.position) > 4) {
        const move = await ctx.act({ type: "navigate", target: fletcher.position, range: 3, timeoutMs: 30_000 });
        if (!move.ok) {
          failures += 1;
          if (failures >= 3) return { status: "retry", reason: `could not approach fletcher: ${move.reason ?? move.code}` };
          continue;
        }
        await ctx.refresh();
      }
      const inspected = await inspectVillager(ctx, fletcher.id);
      if (!inspected) {
        failures += 1;
        if (failures >= 3) return { status: "retry", reason: "could not inspect fletcher trades" };
        continue;
      }
      const offer = findStickEmeraldOffer(inspected);
      if (!offer) return { status: "failed", reason: "fletcher has no stick-for-emerald trade" };

      const remainingUses = offer.maxUses - offer.uses;
      if (remainingUses <= 0) {
        if (restocks >= ctx.config.economy.maxRestocks) {
          return { status: "failed", reason: `fletcher restock limit (${ctx.config.economy.maxRestocks}) reached` };
        }
        ctx.log("economy.restocking", { restocks, restockWaitMs: ctx.config.economy.restockWaitMs });
        const wait = await ctx.act({
          type: "wait",
          durationMs: ctx.config.economy.restockWaitMs,
          timeoutMs: ctx.config.economy.restockWaitMs + 10_000,
        });
        if (!wait.ok) return { status: "retry", reason: `restock wait failed: ${wait.reason ?? wait.code}` };
        restocks += 1;
        state.restocks = restocks;
        await ctx.refresh();
        continue;
      }

      const input = offer.inputs[0];
      if (!input) return { status: "failed", reason: "stick trade has no input" };
      if (input.item !== "minecraft:stick" || offer.inputs.length !== 1) {
        return {
          status: "failed",
          reason: `unsupported emerald trade input ${offer.inputs.map((entry) => entry.item).join("+")}; stick trades are the MVP path`,
        };
      }
      const emeraldsNow = countItem(ctx.snapshot.bot.inventory, "minecraft:emerald");
      const desired = Math.min(
        remainingUses,
        ctx.config.economy.tradeActionBatch,
        64,
        target - emeraldsNow,
      );
      if (desired <= 0) continue;
      const neededSticks = input.count * desired;
      if (countItem(ctx.snapshot.bot.inventory, "minecraft:stick") < neededSticks) {
        const prepared = await prepareSticks(ctx, neededSticks);
        if (!prepared) return { status: "retry", reason: "could not gather/craft enough sticks near the village" };
        await ctx.refresh();
        continue;
      }
      const times = Math.min(desired, Math.floor(countItem(ctx.snapshot.bot.inventory, "minecraft:stick") / input.count));
      if (times <= 0) continue;
      const result = await ctx.act(
        { type: "trade", villagerId: fletcher.id, offerIndex: offer.index, times, timeoutMs: 30_000 },
        { skipReflex: false },
      );
      if (result.ok) {
        ctx.recordTrade(result, fletcher.id, offer.index);
        failures = 0;
        state.restocks = restocks;
        continue;
      }
      ctx.log("economy.trade_failed", { code: result.code, reason: result.reason }, "warn");
      if (result.code === "TRADE_EXHAUSTED") continue;
      if (result.code === "INVENTORY_FULL") {
        await ctx.freeSpace();
        continue;
      }
      if (result.code === "OUT_OF_RANGE") continue;
      failures += 1;
      if (failures >= 4) return { status: "retry", reason: `trade failed repeatedly: ${result.reason ?? result.code}` };
    }
    return { status: "failed", reason: "economy loop exceeded its iteration bound" };
  }
}

async function prepareSticks(ctx: TaskContext, needed: number): Promise<boolean> {
  let loops = 0;
  while (countItem(ctx.snapshot.bot.inventory, "minecraft:stick") < needed && loops < 40) {
    loops += 1;
    const sticks = countItem(ctx.snapshot.bot.inventory, "minecraft:stick");
    const deficit = needed - sticks;
    const batches = Math.max(1, Math.ceil(deficit / 4));
    const planksNeeded = batches * 2;
    let planks = countItem(ctx.snapshot.bot.inventory, "minecraft:oak_planks");
    if (planks < planksNeeded) {
      const plankDeficit = planksNeeded - planks;
      const plankCrafts = Math.max(1, Math.ceil(plankDeficit / 4));
      let logs = countItem(ctx.snapshot.bot.inventory, "minecraft:oak_log");
      if (logs < plankCrafts) {
        const missingLogs = plankCrafts - logs;
        const collect = await ctx.act({
          type: "collect",
          item: "minecraft:oak_log",
          count: Math.min(512, Math.max(24, missingLogs * 2)),
          radius: 128,
          timeoutMs: 30_000,
        });
        if (!collect.ok) {
          ctx.log("economy.collect_failed", { code: collect.code, reason: collect.reason }, "warn");
          if (collect.code === "INVENTORY_FULL") await ctx.freeSpace();
          return false;
        }
        await ctx.refresh();
        logs = countItem(ctx.snapshot.bot.inventory, "minecraft:oak_log");
      }
      const planksAction = await ctx.act({
        type: "craft",
        item: "minecraft:oak_planks",
        count: plankDeficit,
        timeoutMs: 20_000,
      });
      if (!planksAction.ok) {
        if (planksAction.code === "INVENTORY_FULL") await ctx.freeSpace();
        ctx.log("economy.craft_planks_failed", { code: planksAction.code, reason: planksAction.reason }, "warn");
        return false;
      }
      await ctx.refresh();
      planks = countItem(ctx.snapshot.bot.inventory, "minecraft:oak_planks");
    }
    if (planks < 2) return false;
    const stickAction = await ctx.act({ type: "craft", item: "minecraft:stick", count: deficit, timeoutMs: 20_000 });
    if (!stickAction.ok) {
      if (stickAction.code === "INVENTORY_FULL") await ctx.freeSpace();
      ctx.log("economy.craft_sticks_failed", { code: stickAction.code, reason: stickAction.reason }, "warn");
      return false;
    }
    await ctx.refresh();
  }
  return countItem(ctx.snapshot.bot.inventory, "minecraft:stick") >= needed;
}

export class GearTask implements Task {
  readonly goal = "acquire_gear";

  async run(ctx: TaskContext): Promise<TaskResult> {
    const checklist = ctx.config.gear.checklist;
    const state = ctx.state;
    let rerolls = (state.rerolls as number | undefined) ?? 0;
    let failures = 0;
    await ensureFood(ctx);

    // 1. Acquire the base items, one per checklist entry.
    for (const requirement of checklist) {
      if (requirement.optional) continue;
      if (findItemStacks(ctx.snapshot.bot, requirement.item).length > 0) continue;
      const bought = await buyGearItem(ctx, requirement.item);
      if (bought === "need_emeralds") {
        return {
          status: "retry",
          need: "emeralds",
          amount: Math.max(32, estimateMissingCost(ctx)),
          reason: `need emeralds to buy ${requirement.item}`,
        };
      }
      if (bought === "failed") return { status: "failed", reason: `no villager offers ${requirement.item}` };
      if (bought === "retry") {
        failures += 1;
        if (failures >= 3) return { status: "retry", reason: `could not buy ${requirement.item}` };
        continue;
      }
      await ctx.refresh();
    }

    // 2. Acquire enchanted books until every required enchantment is covered.
    for (let iteration = 0; iteration < 400; iteration += 1) {
      await ctx.refresh();
      await ensureFood(ctx);
      const deficits = bookDeficits(ctx);
      if (deficits.size === 0) break;
      if (countItem(ctx.snapshot.bot.inventory, "minecraft:emerald") < 1) {
        return {
          status: "retry",
          need: "emeralds",
          amount: 32,
          reason: "out of emeralds while buying enchanted books",
        };
      }
      if (ctx.snapshot.bot.inventory.length >= ctx.config.economy.dropThreshold) {
        await ctx.freeSpace();
        await ctx.refresh();
      }
      const librarians = ctx.snapshot.world.villagers.filter((villager) => villager.profession === "librarian");
      if (librarians.length === 0) {
        const center = ctx.snapshot.world.village?.center;
        if (!center) return { status: "retry", reason: "no librarians visible" };
        await ctx.act({ type: "navigate", target: center, range: 5, timeoutMs: 30_000 });
        await ctx.refresh();
        continue;
      }
      const librarian = librarians[iteration % librarians.length]!;
      if (distance(ctx.snapshot.bot.position, librarian.position) > 4) {
        const move = await ctx.act({ type: "navigate", target: librarian.position, range: 3, timeoutMs: 30_000 });
        if (!move.ok) {
          failures += 1;
          if (failures >= 4) return { status: "retry", reason: "could not approach a librarian" };
          continue;
        }
        await ctx.refresh();
      }
      const inspected = await inspectVillager(ctx, librarian.id);
      if (!inspected) {
        failures += 1;
        if (failures >= 4) return { status: "retry", reason: "could not inspect librarian trades" };
        continue;
      }

      // Keep a small stock of plain books for book-based offers.
      const plainBooks = countItem(ctx.snapshot.bot.inventory, "minecraft:book");
      const deficitCount = [...deficits.values()].reduce((sum, count) => sum + count, 0);
      const bookOffer = inspected.trades?.find((offer) => offer.output.item === "minecraft:book");
      if (plainBooks < Math.min(deficitCount, 3) && bookOffer && bookOffer.uses < bookOffer.maxUses) {
        const price = emeraldPrice(bookOffer);
        if (price > countItem(ctx.snapshot.bot.inventory, "minecraft:emerald")) {
          return { status: "retry", need: "emeralds", amount: price, reason: "need emeralds for plain books" };
        }
        const times = Math.min(bookOffer.maxUses - bookOffer.uses, 3);
        const result = await ctx.act({ type: "trade", villagerId: librarian.id, offerIndex: bookOffer.index, times, timeoutMs: 30_000 });
        if (result.ok) {
          ctx.recordTrade(result, librarian.id, bookOffer.index);
          continue;
        }
        if (result.code === "TRADE_EXHAUSTED" || result.code === "OUT_OF_RANGE") continue;
        failures += 1;
        if (failures >= 4) return { status: "retry", reason: `plain book purchase failed: ${result.reason ?? result.code}` };
        continue;
      }

      const neededOffer = chooseNeededBookOffer(inspected, deficits);
      if (neededOffer) {
        const price = emeraldPrice(neededOffer);
        if (price > countItem(ctx.snapshot.bot.inventory, "minecraft:emerald")) {
          return {
            status: "retry",
            need: "emeralds",
            amount: Math.max(24, price),
            reason: "need emeralds for the next enchanted book",
          };
        }
        if (countItem(ctx.snapshot.bot.inventory, "minecraft:book") < 1) continue;
        const enchant = neededOffer.output.enchants?.[0]?.id;
        const desired = enchant ? Math.min(deficits.get(enchant) ?? 1, neededOffer.maxUses - neededOffer.uses) : 1;
        if (desired <= 0) continue;
        const result = await ctx.act({
          type: "trade",
          villagerId: librarian.id,
          offerIndex: neededOffer.index,
          times: desired,
          timeoutMs: 30_000,
        });
        if (result.ok) {
          ctx.recordTrade(result, librarian.id, neededOffer.index);
          failures = 0;
          continue;
        }
        if (result.code === "TRADE_EXHAUSTED" || result.code === "OUT_OF_RANGE") continue;
        if (result.code === "INVENTORY_FULL") {
          await ctx.freeSpace();
          continue;
        }
        failures += 1;
        if (failures >= 4) return { status: "retry", reason: `book purchase failed: ${result.reason ?? result.code}` };
        continue;
      }

      if (rerolls >= ctx.config.gear.maxBookRerolls) {
        return {
          status: "failed",
          reason: `book reroll cap (${ctx.config.gear.maxBookRerolls}) reached; missing ${[...deficits.keys()].join(", ")}`,
        };
      }
      const reroll = await ctx.act({ type: "reroll_trades", villagerId: librarian.id, timeoutMs: 20_000 });
      if (!reroll.ok) {
        failures += 1;
        if (failures >= 4) return { status: "retry", reason: `reroll failed: ${reroll.reason ?? reroll.code}` };
        continue;
      }
      rerolls += 1;
      state.rerolls = rerolls;
      ctx.log("gear.reroll", { rerolls, librarian: librarian.id });
    }

    // 3. Apply books to the target items.
    for (let iteration = 0; iteration < 100; iteration += 1) {
      await ctx.refresh();
      const needs = remainingEnchantNeeds(ctx.snapshot.bot, checklist);
      if (needs.length === 0) break;
      const need = needs[0]!;
      const book = ctx.snapshot.bot.inventory.find(
        (stack) => stack.item === "minecraft:enchanted_book" && enchantLevel(stack, need.enchant.id) >= need.enchant.level,
      );
      if (!book) {
        // The book purchasing loop is responsible for this; retry it once.
        return { status: "retry", reason: `no enchanted book for ${need.enchant.id}` };
      }
      const target = ctx.snapshot.bot.inventory.find((stack) => stack.item === need.item);
      if (!target) return { status: "retry", reason: `${need.item} is not in the inventory` };
      const result = await ctx.act({ type: "apply_book", item: need.item, book, timeoutMs: 30_000 });
      if (!result.ok) {
        if (result.code === "LOW_XP") {
          return {
            status: "retry",
            need: "xp",
            amount: 16,
            reason: `need more XP to apply ${need.enchant.id}: ${result.reason ?? "low XP"}`,
          };
        }
        if (result.code === "ENCHANT_CONFLICT") {
          return { status: "failed", reason: `enchantment conflict applying ${need.enchant.id}` };
        }
        return { status: "retry", reason: `apply_book failed: ${result.reason ?? result.code}` };
      }
    }

    // 4. Equip everything that made it through enchanting.
    await ctx.refresh();
    for (const requirement of checklist) {
      if (requirement.optional) continue;
      const carried = findItemStacks(ctx.snapshot.bot, requirement.item).find((entry) => entry.location === "inventory");
      if (!carried) continue;
      const result = await ctx.act({ type: "equip", item: requirement.item, slot: equipSlotFor(requirement.item), timeoutMs: 15_000 });
      if (!result.ok) {
        ctx.log("gear.equip_failed", { item: requirement.item, code: result.code, reason: result.reason }, "warn");
      }
      await ctx.refresh();
    }

    const verification = verifyGear(ctx.snapshot.bot, checklist);
    if (verification.verified) {
      ctx.note("checkpoint gear verified and equipped");
      return { status: "done", reason: "declared gear checkpoint verified" };
    }
    return {
      status: "retry",
      reason: `gear still incomplete: ${verification.missingItems.concat(verification.missingEnchantments).join("; ")}`,
    };
  }
}

type BuyResult = "ok" | "retry" | "need_emeralds" | "failed";

async function buyGearItem(ctx: TaskContext, item: string): Promise<BuyResult> {
  await ctx.refresh();
  if (!ctx.snapshot.world.village) return "failed";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await ctx.refresh();
    const villagers = ctx.snapshot.world.villagers;
    if (villagers.length === 0) {
      const center = ctx.snapshot.world.village?.center;
      if (!center) return "failed";
      await ctx.act({ type: "navigate", target: center, range: 5, timeoutMs: 30_000 });
      await ctx.refresh();
      continue;
    }
    for (const villager of villagers) {
      const inspected = await inspectVillager(ctx, villager.id);
      if (!inspected) continue;
      const offer = inspected.trades?.find(
        (candidate) => candidate.output.item === item && candidate.minLevel <= inspected.level && candidate.uses < candidate.maxUses,
      );
      if (!offer) continue;
      const price = emeraldPrice(offer);
      const emeralds = countItem(ctx.snapshot.bot.inventory, "minecraft:emerald");
      if (price > emeralds) return "need_emeralds";
      if (distance(ctx.snapshot.bot.position, inspected.position) > 4) {
        const move = await ctx.act({ type: "navigate", target: inspected.position, range: 3, timeoutMs: 30_000 });
        if (!move.ok) continue;
        await ctx.refresh();
      }
      if (ctx.snapshot.bot.inventory.length >= ctx.config.economy.dropThreshold) await ctx.freeSpace();
      const result = await ctx.act({ type: "trade", villagerId: inspected.id, offerIndex: offer.index, times: 1, timeoutMs: 30_000 });
      if (result.ok) {
        ctx.recordTrade(result, inspected.id, offer.index);
        ctx.note(`bought ${item} from ${inspected.profession}`);
        await ctx.refresh();
        return "ok";
      }
      if (result.code === "MISSING_ITEM") return "need_emeralds";
      if (result.code === "INVENTORY_FULL") {
        await ctx.freeSpace();
        continue;
      }
      if (result.code === "OUT_OF_RANGE") continue;
      return "retry";
    }
    return "failed";
  }
  return "failed";
}

function bookDeficits(ctx: TaskContext): Map<string, number> {
  const needs = remainingEnchantNeeds(ctx.snapshot.bot, ctx.config.gear.checklist);
  const deficits = new Map<string, number>();
  for (const need of needs) {
    deficits.set(need.enchant.id, (deficits.get(need.enchant.id) ?? 0) + 1);
  }
  for (const stack of ctx.snapshot.bot.inventory) {
    if (stack.item !== "minecraft:enchanted_book" || !stack.enchants) continue;
    for (const enchant of stack.enchants) {
      const count = deficits.get(enchant.id);
      if (count && count > 0) deficits.set(enchant.id, count - 1);
    }
  }
  for (const [key, value] of deficits) if (value <= 0) deficits.delete(key);
  return deficits;
}

function chooseNeededBookOffer(villager: Villager, deficits: Map<string, number>): TradeOffer | undefined {
  const offers = villager.trades ?? [];
  return offers.find((offer) => {
    if (offer.output.item !== "minecraft:enchanted_book") return false;
    if (offer.uses >= offer.maxUses) return false;
    const enchant = offer.output.enchants?.[0]?.id;
    if (!enchant) return false;
    return (deficits.get(enchant) ?? 0) > 0;
  });
}

function emeraldPrice(offer: TradeOffer): number {
  return offer.inputs
    .filter((input) => input.item === "minecraft:emerald")
    .reduce((sum, input) => sum + input.count, 0);
}

function estimateMissingCost(ctx: TaskContext): number {
  const verification = verifyGear(ctx.snapshot.bot, ctx.config.gear.checklist);
  return verification.missingItems.length * 20 + 40;
}

function findStickEmeraldOffer(villager: Villager): TradeOffer | undefined {
  return (villager.trades ?? []).find(
    (offer) =>
      offer.output.item === "minecraft:emerald" &&
      offer.inputs.length === 1 &&
      offer.inputs[0]?.item === "minecraft:stick" &&
      offer.minLevel <= villager.level,
  );
}

async function ensureVillager(ctx: TaskContext, profession: string): Promise<Villager | null> {
  let visible = ctx.snapshot.world.villagers.find((villager) => villager.profession === profession);
  if (visible) return visible;
  const village = ctx.snapshot.world.village;
  if (!village) return null;
  const move = await ctx.act({ type: "navigate", target: village.center, range: 5, timeoutMs: 30_000 });
  if (!move.ok) return null;
  await ctx.refresh();
  visible = ctx.snapshot.world.villagers.find((villager) => villager.profession === profession);
  return visible ?? null;
}

async function inspectVillager(ctx: TaskContext, villagerId: string): Promise<Villager | null> {
  let villager = ctx.snapshot.world.villagers.find((candidate) => candidate.id === villagerId);
  if (!villager) return null;
  if (villager.tradesKnown && villager.trades) return villager;
  if (distance(ctx.snapshot.bot.position, villager.position) > 6) {
    const move = await ctx.act({ type: "navigate", target: villager.position, range: 3, timeoutMs: 30_000 });
    if (!move.ok) return null;
    await ctx.refresh();
  }
  const result = await ctx.act({ type: "inspect_trades", villagerId, timeoutMs: 15_000 });
  if (!result.ok) return null;
  await ctx.refresh();
  villager = ctx.snapshot.world.villagers.find((candidate) => candidate.id === villagerId);
  return villager?.tradesKnown ? villager : null;
}

/** Drop low-value items, then excess raw materials, to keep the inventory usable. */
export async function dropJunk(ctx: TaskContext): Promise<boolean> {
  const inventory = ctx.snapshot.bot.inventory;
  for (const item of JUNK) {
    const stack = inventory.find((candidate) => candidate.item === item);
    if (!stack) continue;
    const result = await ctx.act({ type: "drop", item, count: stack.count, timeoutMs: 10_000 }, { skipReflex: true });
    if (result.ok) return true;
  }
  const logs = countItem(inventory, "minecraft:oak_log");
  if (logs > 128) {
    const result = await ctx.act({ type: "drop", item: "minecraft:oak_log", count: logs - 64, timeoutMs: 10_000 }, { skipReflex: true });
    if (result.ok) return true;
  }
  const sticks = countItem(inventory, "minecraft:stick");
  if (sticks > 256) {
    const result = await ctx.act({ type: "drop", item: "minecraft:stick", count: sticks - 128, timeoutMs: 10_000 }, { skipReflex: true });
    if (result.ok) return true;
  }
  return false;
}

export function taskForGoal(goal: string, target?: number): Task | null {
  switch (goal) {
    case "explore_village":
      return new ExploreTask();
    case "settle":
      return new SettleTask();
    case "earn_emeralds":
      return new EconomyTask(target);
    case "acquire_gear":
      return new GearTask();
    default:
      return null;
  }
}

export type { ItemStack, Snapshot };
