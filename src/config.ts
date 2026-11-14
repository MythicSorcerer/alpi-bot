import { z } from "zod";
import { EnchantmentSchema, ItemIdSchema } from "./protocol/types.js";

export const GearRequirementSchema = z
  .object({
    item: ItemIdSchema,
    enchants: z.array(EnchantmentSchema).min(1),
    optional: z.boolean().default(false),
  })
  .strict();
export type GearRequirement = z.infer<typeof GearRequirementSchema>;

/**
 * MVP checkpoint: a full diamond combat/mining kit with the declared books.
 * Mending is deliberately not part of the first checkpoint; it is tracked as an
 * accepted stretch enchantment instead of making the checkpoint unbounded.
 */
export const DEFAULT_GEAR_CHECKLIST: GearRequirement[] = [
  {
    item: "minecraft:diamond_helmet",
    enchants: [
      { id: "minecraft:protection", level: 4 },
      { id: "minecraft:unbreaking", level: 3 },
    ],
    optional: false,
  },
  {
    item: "minecraft:diamond_chestplate",
    enchants: [
      { id: "minecraft:protection", level: 4 },
      { id: "minecraft:unbreaking", level: 3 },
    ],
    optional: false,
  },
  {
    item: "minecraft:diamond_leggings",
    enchants: [
      { id: "minecraft:protection", level: 4 },
      { id: "minecraft:unbreaking", level: 3 },
    ],
    optional: false,
  },
  {
    item: "minecraft:diamond_boots",
    enchants: [
      { id: "minecraft:protection", level: 4 },
      { id: "minecraft:unbreaking", level: 3 },
      { id: "minecraft:feather_falling", level: 4 },
    ],
    optional: false,
  },
  {
    item: "minecraft:diamond_sword",
    enchants: [
      { id: "minecraft:sharpness", level: 5 },
      { id: "minecraft:unbreaking", level: 3 },
    ],
    optional: false,
  },
  {
    item: "minecraft:diamond_pickaxe",
    enchants: [
      { id: "minecraft:efficiency", level: 5 },
      { id: "minecraft:unbreaking", level: 3 },
    ],
    optional: false,
  },
  {
    item: "minecraft:diamond_axe",
    enchants: [
      { id: "minecraft:efficiency", level: 5 },
      { id: "minecraft:unbreaking", level: 3 },
    ],
    optional: false,
  },
];

export const ConfigSchema = z
  .object({
    bot: z
      .object({
        username: z.string().min(1).max(16).default("MCBot"),
        owner: z.string().max(128).default(""),
      })
      .strict()
      .default({}),
    run: z
      .object({
        name: z.string().min(1).max(64).default("checkpoint"),
        seed: z.number().int().default(42),
        maxActions: z.number().int().min(1).max(100_000).default(5_000),
        maxMinutes: z.number().min(1).max(24 * 60).default(120),
        checkpointEveryActions: z.number().int().min(1).max(1_000).default(10),
      })
      .strict()
      .default({}),
    adapter: z
      .object({
        url: z.string().url().default("ws://127.0.0.1:8765"),
        connectTimeoutMs: z.number().int().min(500).max(60_000).default(5_000),
        requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
        reconnectAttempts: z.number().int().min(0).max(20).default(3),
        reconnectDelayMs: z.number().int().min(100).max(60_000).default(1_000),
      })
      .strict()
      .default({}),
    guardrails: z
      .object({
        allowRemoteAdapter: z.boolean().default(false),
        requireServerWhitelist: z.boolean().default(true),
        serverWhitelist: z.array(z.string().min(1).max(256)).default(["127.0.0.1:25565", "localhost:25565"]),
        allowExploits: z.boolean().default(false),
        allowChat: z.boolean().default(false),
        maxActionTimeoutMs: z.number().int().min(1_000).max(120_000).default(60_000),
        killSwitchFile: z.string().max(512).default("./STOP"),
        maxActionsPerMinute: z.number().int().min(1).max(6_000).default(600),
      })
      .strict()
      .default({}),
    simulation: z
      .object({
        scenario: z.enum(["default", "hostile-night", "scarce"]).default("default"),
        villageDistance: z.number().min(64).max(8_000).default(480),
        port: z.number().int().min(0).max(65_535).default(0),
      })
      .strict()
      .default({}),
    exploration: z
      .object({
        stepBlocks: z.number().min(16).max(512).default(128),
        maxDistanceBlocks: z.number().min(64).max(16_000).default(1_024),
        detectionRadius: z.number().min(16).max(256).default(96),
        maxWaypoints: z.number().int().min(4).max(1_000).default(64),
      })
      .strict()
      .default({}),
    settlement: z
      .object({
        minPopulation: z.number().int().min(1).max(32).default(4),
        sleepAtNight: z.boolean().default(true),
      })
      .strict()
      .default({}),
    economy: z
      .object({
        emeraldTarget: z.number().int().min(1).max(10_000).default(240),
        maxRestocks: z.number().int().min(1).max(500).default(80),
        tradeActionBatch: z.number().int().min(1).max(64).default(12),
        restockWaitMs: z.number().int().min(1_000).max(300_000).default(30_000),
        keepFood: z.number().int().min(1).max(64).default(4),
        dropThreshold: z.number().int().min(10).max(45).default(33),
      })
      .strict()
      .default({}),
    gear: z
      .object({
        checklist: z.array(GearRequirementSchema).min(1).max(16).default(DEFAULT_GEAR_CHECKLIST),
        /** Stop looking for a book after this many librarian rerolls. */
        maxBookRerolls: z.number().int().min(0).max(500).default(80),
      })
      .strict()
      .default({}),
    reflex: z
      .object({
        enabled: z.boolean().default(true),
        lowHealth: z.number().min(1).max(20).default(8),
        lowFood: z.number().int().min(0).max(20).default(6),
        hostileRadius: z.number().min(1).max(48).default(8),
        criticalHostileRadius: z.number().min(1).max(48).default(4),
        voidY: z.number().min(-128).max(0).default(-60),
        stuckAfterFailures: z.number().int().min(1).max(20).default(3),
      })
      .strict()
      .default({}),
    planner: z
      .object({
        mode: z.enum(["deterministic", "qwen"]).default("deterministic"),
        qwen: z
          .object({
            baseUrl: z.string().url().default("http://127.0.0.1:11434/v1"),
            model: z.string().min(1).max(128).default("qwen2.5:14b-instruct"),
            apiKeyEnv: z.string().min(1).max(128).default("QWEN_API_KEY"),
            timeoutMs: z.number().int().min(500).max(120_000).default(15_000),
            maxTokens: z.number().int().min(16).max(4_096).default(256),
            temperature: z.number().min(0).max(2).default(0.1),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    persistence: z
      .object({
        dir: z.string().min(1).max(512).default("./state"),
        saveEvents: z.boolean().default(true),
        maxEventFileBytes: z.number().int().min(1024).max(512 * 1024 * 1024).default(64 * 1024 * 1024),
      })
      .strict()
      .default({}),
    logging: z
      .object({
        level: z.enum(["debug", "info", "warn", "error"]).default("info"),
        pretty: z.boolean().default(true),
      })
      .strict()
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

export function parseConfig(input: unknown): Config {
  return ConfigSchema.parse(input ?? {});
}
