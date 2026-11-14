import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyMetrics, loadRunState, saveRunState, type RunState } from "../src/controller/state.js";
import {
  CheckpointError,
  buildCheckpoint,
  checkpointPath,
  checksumOf,
  readCheckpoint,
  saveCheckpoint,
  verifyCheckpoint,
} from "../src/persistence/checkpoint.js";
import { EventLog, readEventLog } from "../src/persistence/event-log.js";
import { SimulatedGame } from "../src/sim/simulator.js";
import { tempDir, testConfig } from "./helpers.js";

function sampleState(directory: string): RunState {
  const now = Date.now();
  return {
    schemaVersion: 1,
    runId: "run-test-1",
    phase: "acquire_gear",
    task: { rerolls: 2 },
    metrics: emptyMetrics(),
    ledger: { emeraldsEarned: 10, emeraldsSpent: 4, trades: 3, entries: [] },
    notes: ["note"],
    settled: true,
    emeraldGoalOverride: null,
    startedAt: now,
    updatedAt: now,
    checkpointsWritten: 0,
  };
}

describe("checkpoint and run-state persistence", () => {
  it("writes a checksummed checkpoint that survives a round trip", () => {
    const directory = tempDir("checkpoint");
    const config = testConfig(directory);
    const sim = new SimulatedGame({ seed: 3 });
    const snapshot = sim.snapshot();
    const checkpoint = buildCheckpoint({
      runId: "run-roundtrip",
      createdAt: Date.now(),
      phase: "bootstrap",
      snapshot,
      checklist: config.gear.checklist,
      ledger: { emeraldsEarned: 0, emeraldsSpent: 0, trades: 0, entries: [] },
      eventLog: join(directory, "events.jsonl"),
      report: join(directory, "report.json"),
      task: {},
      notes: ["hello"],
      settled: false,
      server: sim.server ?? null,
    });
    expect(checkpoint.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(checkpoint.checksum).toBe(checksumOf(checkpoint));
    const path = saveCheckpoint(config, checkpoint);
    expect(path).toBe(checkpointPath(config, "run-roundtrip"));
    const loaded = readCheckpoint(path);
    expect(loaded.runId).toBe("run-roundtrip");
    expect(loaded.snapshot.bot.position).toEqual(snapshot.bot.position);
    expect(verifyCheckpoint(loaded, config.gear.checklist).verified).toBe(false);
  });

  it("rejects tampered checkpoints", () => {
    const directory = tempDir("checkpoint-tamper");
    const config = testConfig(directory);
    const sim = new SimulatedGame({ seed: 3 });
    const checkpoint = buildCheckpoint({
      runId: "run-tamper",
      createdAt: Date.now(),
      phase: "bootstrap",
      snapshot: sim.snapshot(),
      checklist: config.gear.checklist,
      ledger: { emeraldsEarned: 0, emeraldsSpent: 0, trades: 0, entries: [] },
      eventLog: join(directory, "events.jsonl"),
      report: join(directory, "report.json"),
      task: {},
      notes: [],
      settled: false,
      server: null,
    });
    const path = saveCheckpoint(config, checkpoint);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.phase = "done";
    writeFileSync(path, JSON.stringify(raw));
    expect(() => readCheckpoint(path)).toThrow(CheckpointError);
    expect(() => readCheckpoint(path)).toThrow(/checksum mismatch/);
  });

  it("round-trips run state and refuses malformed state", () => {
    const directory = tempDir("run-state");
    const state = sampleState(directory);
    saveRunState(directory, state);
    expect(loadRunState(directory)).toEqual(state);
    writeFileSync(join(directory, "controller-state.json"), JSON.stringify({ ...state, unexpected: true }));
    expect(() => loadRunState(directory)).toThrow(/invalid/);
  });

  it("writes and reads a validated JSONL event log", () => {
    const directory = tempDir("event-log");
    const log = new EventLog(directory, "run-log");
    log.append({ level: "info", event: "run.created", phase: "bootstrap", data: { authorization: "Bearer secret" } });
    log.append({ level: "warn", event: "action.result", actionId: "bootstrap-1", data: { ok: false, code: "NO_PATH" } });
    const events = readEventLog(log.path);
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("run.created");
    expect((events[0]?.data as { authorization: string }).authorization).toBe("[REDACTED]");
    writeFileSync(log.path, `${readFileSync(log.path, "utf8")}not-json\n`);
    expect(() => readEventLog(log.path)).toThrow(/line 3/);
  });
});
