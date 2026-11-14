import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GameAdapterServer } from "../src/adapter/ws-server.js";
import { WsGameClient } from "../src/adapter/ws-client.js";
import { BotController } from "../src/controller/controller.js";
import { loadRunState, runStatePath } from "../src/controller/state.js";
import { silentLogger } from "../src/logging/logger.js";
import { readCheckpoint } from "../src/persistence/checkpoint.js";
import { readEventLog } from "../src/persistence/event-log.js";
import { SimulatedGame } from "../src/sim/simulator.js";
import { tempDir, testConfig } from "./helpers.js";

describe("controller end to end", () => {
  it("reaches the gear checkpoint, writes verifiable evidence and can resume", async () => {
    const directory = tempDir("controller-inproc");
    const config = testConfig(directory);
    const sim = new SimulatedGame({ seed: config.run.seed, villageDistance: config.simulation.villageDistance });
    const controller = new BotController(config, sim, { logger: silentLogger, resume: false, deterministic: true });
    const summary = await controller.run();

    expect(summary.ok).toBe(true);
    expect(summary.reason).toMatch(/checkpoint verified/);
    expect(summary.gear.verified).toBe(true);
    expect(summary.gear.items).toHaveLength(7);
    expect(summary.metrics.actionsAttempted).toBeGreaterThan(100);
    expect(summary.metrics.actionsFailed).toBe(0);
    expect(summary.metrics.trades).toBeGreaterThan(200);
    expect(summary.metrics.booksApplied).toBeGreaterThanOrEqual(15);
    expect(summary.ledger.emeraldsEarned).toBeGreaterThanOrEqual(240);
    expect(summary.ledger.trades).toBe(summary.metrics.trades);
    expect(summary.checkpoint).toBeTruthy();
    expect(existsSync(summary.checkpoint!)).toBe(true);
    expect(existsSync(summary.report)).toBe(true);
    expect(existsSync(summary.eventLog)).toBe(true);

    const checkpoint = readCheckpoint(summary.checkpoint!);
    expect(checkpoint.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(checkpoint.phase).toBe("done");
    expect(checkpoint.gear.verified).toBe(true);
    expect(checkpoint.resume.settled).toBe(true);
    expect(checkpoint.server?.address).toBe("127.0.0.1:25565");
    expect(checkpoint.village?.valid).toBe(true);

    const events = readEventLog(summary.eventLog);
    expect(events.length).toBeGreaterThan(100);
    expect(events.some((event) => event.event === "action.result")).toBe(true);
    expect(events.some((event) => event.event === "plan.decision")).toBe(true);
    expect(events.some((event) => event.event === "note" && String((event.data as { text?: string }).text).includes("verified"))).toBe(true);

    const state = loadRunState(directory);
    expect(state?.phase).toBe("done");
    expect(state?.settled).toBe(true);

    const resumed = new BotController(config, sim, { logger: silentLogger });
    const resumedSummary = await resumed.run();
    expect(resumedSummary.ok).toBe(true);
    expect(resumedSummary.runId).toBe(summary.runId);
    expect(resumedSummary.metrics.actionsAttempted).toBe(summary.metrics.actionsAttempted);
  });

  it("applies the time budget to the current session, not the age of the run", async () => {
    const directory = tempDir("controller-resume-budget");
    const config = testConfig(directory);
    const sim = new SimulatedGame({ seed: config.run.seed, villageDistance: config.simulation.villageDistance });
    const first = new BotController(config, sim, { logger: silentLogger, resume: false, deterministic: true });
    const summary = await first.run();
    expect(summary.ok).toBe(true);

    // Pretend the run was persisted a day ago. A resumed session must get a
    // fresh time budget instead of stopping before its first action.
    const statePath = runStatePath(directory);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    persisted.startedAt = Date.now() - 24 * 60 * 60 * 1_000;
    writeFileSync(statePath, `${JSON.stringify(persisted, null, 2)}\n`);

    const resumed = new BotController(config, sim, { logger: silentLogger });
    const resumedSummary = await resumed.run();
    expect(resumedSummary.resumed).toBe(true);
    expect(resumedSummary.ok).toBe(true);
    expect(resumedSummary.reason).not.toMatch(/time budget/);
    expect(resumedSummary.durationMs).toBeLessThan(60_000);
    expect(resumedSummary.runAgeMs).toBeGreaterThan(60_000);
  });

  it("completes the same checkpoint over the loopback WebSocket protocol", async () => {
    const directory = tempDir("controller-ws");
    const config = testConfig(directory);
    const sim = new SimulatedGame({ seed: 11, villageDistance: 480 });
    const server = new GameAdapterServer(sim, { host: "127.0.0.1", port: 0, logger: silentLogger });
    const address = await server.listen();
    config.adapter.url = address.url;
    const adapter = new WsGameClient(config, silentLogger);
    try {
      const controller = new BotController(config, adapter, { logger: silentLogger, resume: false, deterministic: true });
      const summary = await controller.run();
      expect(summary.ok).toBe(true);
      expect(summary.adapter?.name).toBe("MinecraftSimulator");
      expect(summary.gear.verified).toBe(true);
      const checkpoint = readCheckpoint(summary.checkpoint!);
      expect(checkpoint.protocolVersion).toBe("1.0.0");
    } finally {
      await adapter.close();
      await server.close();
    }
  });
});
