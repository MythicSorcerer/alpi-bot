import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Config, GearRequirement } from "../config.js";
import { LedgerSchema } from "../controller/state.js";
import { verifyGear, type GearVerification } from "../gear/checklist.js";
import {
  ArmorSchema,
  ItemStackSchema,
  PROTOCOL_VERSION,
  SnapshotSchema,
  Vec3Schema,
  VillagerSchema,
  VillageSchema,
} from "../protocol/types.js";
import { writeFileAtomic } from "./event-log.js";

export const CHECKPOINT_SCHEMA_VERSION = 1;

export const CheckpointSchema = z
  .object({
    schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
    runId: z.string().min(1).max(128),
    createdAt: z.number().int().min(0),
    updatedAt: z.number().int().min(0),
    protocolVersion: z.string().min(1),
    adapter: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
    server: z
      .object({ address: z.string().min(1), version: z.string().min(1), software: z.string().optional() })
      .nullable(),
    phase: z.string().min(1).max(64),
    snapshot: SnapshotSchema,
    villagers: z.array(VillagerSchema).max(128),
    village: VillageSchema.nullable(),
    inventory: z.array(ItemStackSchema),
    armor: ArmorSchema,
    mainhand: ItemStackSchema.nullable(),
    position: Vec3Schema,
    ledger: LedgerSchema,
    gear: z.object({
      verified: z.boolean(),
      items: z.array(z.unknown()),
      missingItems: z.array(z.string()),
      missingEnchantments: z.array(z.string()),
    }),
    checklist: z.array(z.unknown()),
    resume: z.object({
      phase: z.string().min(1),
      task: z.unknown(),
      notes: z.array(z.string().max(1024)).max(64),
      settled: z.boolean(),
    }),
    evidence: z.object({
      eventLog: z.string().min(1),
      report: z.string().min(1),
    }),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export type CheckpointPayload = Omit<Checkpoint, "checksum">;

export function checksumOf(payload: CheckpointPayload | Omit<Checkpoint, "checksum">): string {
  const clone = { ...payload } as Record<string, unknown>;
  delete clone.checksum;
  return createHash("sha256").update(JSON.stringify(clone)).digest("hex");
}

export function checkpointPath(config: Config, runId?: string): string {
  return join(config.persistence.dir, runId ? `checkpoint-${runId}.json` : "checkpoint.json");
}

export function buildCheckpoint(params: {
  runId: string;
  createdAt: number;
  phase: string;
  snapshot: Checkpoint["snapshot"];
  checklist: GearRequirement[];
  ledger: Checkpoint["ledger"];
  eventLog: string;
  report: string;
  task: unknown;
  notes: string[];
  settled: boolean;
  server: Checkpoint["server"];
}): Checkpoint {
  const verification: GearVerification = verifyGear(params.snapshot.bot, params.checklist);
  const payload: CheckpointPayload = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: params.runId,
    createdAt: params.createdAt,
    updatedAt: Date.now(),
    protocolVersion: PROTOCOL_VERSION,
    adapter: params.snapshot.adapter,
    server: params.server,
    phase: params.phase,
    snapshot: params.snapshot,
    villagers: params.snapshot.world.villagers,
    village: params.snapshot.world.village,
    inventory: params.snapshot.bot.inventory,
    armor: params.snapshot.bot.armor,
    mainhand: params.snapshot.bot.mainhand,
    position: params.snapshot.bot.position,
    ledger: params.ledger,
    gear: {
      verified: verification.verified,
      items: verification.items,
      missingItems: verification.missingItems,
      missingEnchantments: verification.missingEnchantments,
    },
    checklist: params.checklist,
    resume: { phase: params.phase, task: params.task, notes: params.notes, settled: params.settled },
    evidence: { eventLog: params.eventLog, report: params.report },
  };
  return { ...payload, checksum: checksumOf(payload) };
}

export function saveCheckpoint(config: Config, checkpoint: Checkpoint, path?: string): string {
  const target = path ?? checkpointPath(config, checkpoint.runId);
  writeFileAtomic(target, `${JSON.stringify(checkpoint, null, 2)}\n`);
  return target;
}

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointError";
  }
}

export function readCheckpoint(path: string): Checkpoint {
  if (!existsSync(path)) throw new CheckpointError(`checkpoint not found: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CheckpointError(`checkpoint is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = CheckpointSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CheckpointError(`checkpoint schema validation failed: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  const expected = checksumOf(parsed.data);
  if (parsed.data.checksum !== expected) {
    throw new CheckpointError("checkpoint checksum mismatch: file was modified or corrupted");
  }
  return parsed.data;
}

export function verifyCheckpoint(checkpoint: Checkpoint, checklist: GearRequirement[]): GearVerification {
  return verifyGear(checkpoint.snapshot.bot, checklist);
}
