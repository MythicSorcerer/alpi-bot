import type { Config } from "../config.js";
import type { Action, Entity, Snapshot } from "../protocol/types.js";
import { countItem } from "../util/items.js";

export interface ReflexContext {
  consecutiveFailures: number;
  lastActionType?: string;
  settled: boolean;
}

export interface ReflexDecision {
  action: Action;
  reason: string;
  priority: "critical" | "high" | "normal";
}

const FOOD_PRIORITY = [
  "minecraft:cooked_beef",
  "minecraft:cooked_porkchop",
  "minecraft:bread",
  "minecraft:baked_potato",
  "minecraft:apple",
  "minecraft:carrot",
];

/**
 * Tick-rate safety rules. These are evaluated locally before every controller
 * action and never depend on the planner or network availability.
 */
export class ReflexLayer {
  constructor(private readonly config: Config) {}

  evaluate(snapshot: Snapshot, context: ReflexContext): ReflexDecision | null {
    if (!this.config.reflex.enabled) return null;
    const { bot, world } = snapshot;

    if (bot.health <= 0) {
      return {
        action: { type: "wait", durationMs: 1_000 },
        reason: "waiting for the adapter to respawn the bot",
        priority: "critical",
      };
    }

    if (bot.position.y < this.config.reflex.voidY || (bot.inWater && bot.air < 40)) {
      if (bot.inWater) {
        return { action: { type: "surface" }, reason: "drowning; surfacing immediately", priority: "critical" };
      }
      return {
        action: {
          type: "navigate",
          target: { x: bot.position.x, y: 64, z: bot.position.z },
          range: 3,
          timeoutMs: 20_000,
        },
        reason: "below the configured void floor; returning to safe ground",
        priority: "critical",
      };
    }

    const hostiles = world.nearbyEntities
      .filter((entity): entity is Entity => entity.kind === "hostile" && (entity.distance ?? Infinity) <= this.config.reflex.hostileRadius)
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    const nearest = hostiles[0];
    if (nearest) {
      const distance = nearest.distance ?? Infinity;
      const critical = distance <= this.config.reflex.criticalHostileRadius;
      const lowHealth = bot.health <= this.config.reflex.lowHealth;
      if (lowHealth || !bot.mainhand) {
        return {
          action: { type: "flee", entityId: nearest.id, distance: 24, timeoutMs: 15_000 },
          reason: `${nearest.type} is ${Math.round(distance)} blocks away and combat is not safe`,
          priority: "critical",
        };
      }
      if (critical || (distance <= this.config.reflex.hostileRadius && bot.health >= this.config.reflex.lowHealth + 4)) {
        return {
          action: { type: "attack", entityId: nearest.id, timeoutMs: 10_000 },
          reason: `${nearest.type} is within ${Math.round(distance)} blocks; engaging locally`,
          priority: "critical",
        };
      }
    }

    if (bot.food <= this.config.reflex.lowFood) {
      const food = FOOD_PRIORITY.find((item) => countItem(bot.inventory, item) > 0);
      if (food) {
        return {
          action: { type: "eat", item: food, timeoutMs: 10_000 },
          reason: `food is ${bot.food}; eating ${food} before the next task step`,
          priority: "high",
        };
      }
    }

    if (bot.health <= this.config.reflex.lowHealth && bot.food >= 18) {
      return {
        action: { type: "wait", durationMs: 5_000, timeoutMs: 10_000 },
        reason: "health is low; letting natural regeneration run while no threat is nearby",
        priority: "high",
      };
    }

    const isNight = world.timeOfDay >= 12_500 && world.timeOfDay < 23_500;
    const bed = world.nearbyBlocks.find((block) => block.type.includes("bed") && Math.hypot(block.position.x - bot.position.x, block.position.z - bot.position.z) <= 8);
    if (isNight && !bot.isSleeping && bed && !nearest) {
      return {
        action: { type: "sleep", bed: bed.position, timeoutMs: 30_000 },
        reason: "night with a reachable bed and no nearby threat",
        priority: "normal",
      };
    }

    if (context.consecutiveFailures >= this.config.reflex.stuckAfterFailures && context.lastActionType !== "stop") {
      return {
        action: { type: "stop" },
        reason: `${context.consecutiveFailures} consecutive failures; stopping before recovery`,
        priority: "high",
      };
    }

    return null;
  }
}
