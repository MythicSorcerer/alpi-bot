import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../persistence/event-log.js";

export const MetricsSchema = z
  .object({
    actionsAttempted: z.number().int().min(0),
    actionsSucceeded: z.number().int().min(0),
    actionsFailed: z.number().int().min(0),
    actionTimeouts: z.number().int().min(0),
    retries: z.number().int().min(0),
    reflexActions: z.number().int().min(0),
    deaths: z.number().int().min(0),
    trades: z.number().int().min(0),
    emeraldsEarned: z.number().int().min(0),
    emeraldsSpent: z.number().int().min(0),
    booksApplied: z.number().int().min(0),
    logsCollected: z.number().int().min(0),
    distanceMoved: z.number().min(0),
    modelCalls: z.number().int().min(0),
    modelFailures: z.number().int().min(0),
    modelLatencyMs: z.number().min(0),
    modelTokens: z.number().int().min(0),
  })
  .strict();
export type Metrics = z.infer<typeof MetricsSchema>;

export function emptyMetrics(): Metrics {
  return {
    actionsAttempted: 0,
    actionsSucceeded: 0,
    actionsFailed: 0,
    actionTimeouts: 0,
    retries: 0,
    reflexActions: 0,
    deaths: 0,
    trades: 0,
    emeraldsEarned: 0,
    emeraldsSpent: 0,
    booksApplied: 0,
    logsCollected: 0,
    distanceMoved: 0,
    modelCalls: 0,
    modelFailures: 0,
    modelLatencyMs: 0,
    modelTokens: 0,
  };
}

export const LedgerSchema = z
  .object({
    emeraldsEarned: z.number().int().min(0),
    emeraldsSpent: z.number().int().min(0),
    trades: z.number().int().min(0),
    entries: z
      .array(
        z
          .object({
            timestamp: z.number().int().min(0),
            kind: z.enum(["earn", "spend"]),
            emeralds: z.number().int().min(0),
            item: z.string(),
            count: z.number().int().min(1),
            villagerId: z.string(),
            tradeIndex: z.number().int().min(0),
          })
          .strict(),
      )
      .max(5_000),
  })
  .strict();
export type Ledger = z.infer<typeof LedgerSchema>;

export const RunStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1).max(128),
    phase: z.string().min(1).max(64),
    task: z.unknown(),
    metrics: MetricsSchema,
    ledger: LedgerSchema,
    notes: z.array(z.string().max(1024)).max(256),
    settled: z.boolean(),
    emeraldGoalOverride: z.number().int().min(1).max(10_000).nullable(),
    startedAt: z.number().int().min(0),
    updatedAt: z.number().int().min(0),
    checkpointsWritten: z.number().int().min(0),
  })
  .strict();
export type RunState = z.infer<typeof RunStateSchema>;

export function runStatePath(directory: string): string {
  return join(directory, "controller-state.json");
}

export function saveRunState(directory: string, state: RunState): void {
  writeFileAtomic(runStatePath(directory), `${JSON.stringify(state, null, 2)}\n`);
}

export function loadRunState(directory: string): RunState | null {
  const path = runStatePath(directory);
  if (!existsSync(path)) return null;
  const parsed = RunStateSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`controller state is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  return parsed.data;
}
