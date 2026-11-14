import { describe, expect, it } from "vitest";
import {
  DeterministicPlanner,
  QwenPlanner,
  deterministicGoal,
  goalFeasible,
  parseDecision,
  type PlannerContext,
} from "../src/planner/planner.js";
import { silentLogger } from "../src/logging/logger.js";
import type { Snapshot } from "../src/protocol/types.js";
import { SimulatedGame } from "../src/sim/simulator.js";
import { tempDir, testConfig } from "./helpers.js";

function context(overrides: Partial<PlannerContext> = {}): PlannerContext {
  const snapshot = new SimulatedGame({ seed: 5 }).snapshot();
  snapshot.world.village = {
    id: "test-village",
    center: { x: 480, y: 64, z: 0 },
    radius: 40,
    population: 8,
    beds: 10,
    workstations: 5,
    valid: true,
  };
  return {
    phase: "bootstrap",
    snapshot,
    gearVerified: false,
    missingGear: ["minecraft:diamond_sword"],
    emeraldTarget: 240,
    settled: true,
    notes: [],
    ...overrides,
  };
}

describe("deterministic planner", () => {
  it("walks through exploration, settlement, economy and gear", async () => {
    const planner = new DeterministicPlanner();
    const noVillage = context({ settled: false });
    noVillage.snapshot.world.village = null;
    expect((await planner.plan(noVillage)).goal).toBe("explore_village");

    expect((await planner.plan(context({ settled: false }))).goal).toBe("settle");
    expect((await planner.plan(context())).goal).toBe("earn_emeralds");

    const funded = context();
    funded.snapshot.bot.inventory.push({ item: "minecraft:emerald", count: 240 });
    expect((await planner.plan(funded)).goal).toBe("acquire_gear");

    const complete = context({ gearVerified: true });
    complete.snapshot.bot.inventory.push({ item: "minecraft:emerald", count: 240 });
    expect((await planner.plan(complete)).goal).toBe("verify_checkpoint");
  });

  it("never recommends gear before the village is settled", () => {
    const decision = deterministicGoal(context({ settled: false, gearVerified: true }));
    expect(decision.goal).toBe("settle");
  });

  it("rejects model goals that do not fit the observed state", () => {
    const noVillage = context({ settled: false });
    noVillage.snapshot.world.village = null;
    expect(goalFeasible("explore_village", noVillage)).toBe(true);
    expect(goalFeasible("settle", noVillage)).toBe(false);
    expect(goalFeasible("earn_emeralds", noVillage)).toBe(false);
    expect(goalFeasible("verify_checkpoint", noVillage)).toBe(false);

    expect(goalFeasible("settle", context({ settled: false }))).toBe(true);
    expect(goalFeasible("earn_emeralds", context())).toBe(true);
    expect(goalFeasible("acquire_gear", context())).toBe(true);
    expect(goalFeasible("acquire_gear", context({ settled: false }))).toBe(false);
    expect(goalFeasible("verify_checkpoint", context())).toBe(false);
    expect(goalFeasible("verify_checkpoint", context({ gearVerified: true }))).toBe(true);
    expect(goalFeasible("done", context({ gearVerified: true }))).toBe(true);
  });
});

describe("optional Qwen planner", () => {
  it("accepts only a bounded JSON goal", () => {
    expect(parseDecision('{"goal":"settle","reason":"village found"}')).toEqual({
      goal: "settle",
      reason: "village found",
    });
    expect(parseDecision('```json\n{"goal":"acquire_gear","reason":"funded"}\n```')?.goal).toBe("acquire_gear");
    expect(parseDecision('{"goal":"teleport","reason":"cheat"}')).toBeNull();
    expect(parseDecision('{"goal":"settle"}')).toBeNull();
    expect(parseDecision("not json")).toBeNull();
  });

  it("uses model output when available", async () => {
    const config = testConfig(tempDir("planner-qwen"));
    config.planner.mode = "qwen";
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"goal":"earn_emeralds","reason":"budget is low"}' } }],
          usage: { total_tokens: 42 },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const planner = new QwenPlanner(config, silentLogger, fakeFetch);
    const decision = await planner.plan(context());
    expect(decision.goal).toBe("earn_emeralds");
    expect(decision.source).toBe("qwen");
    expect(decision.tokens).toBe(42);
    expect(decision.failed).toBe(false);
  });

  it("falls back to deterministic policy on errors and after repeated failures", async () => {
    const config = testConfig(tempDir("planner-fallback"));
    config.planner.mode = "qwen";
    const failingFetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const planner = new QwenPlanner(config, silentLogger, failingFetch);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const decision = await planner.plan(context());
      expect(decision.source).toBe("deterministic");
      expect(decision.failed).toBe(true);
    }
    const disabled = await planner.plan(context());
    expect(disabled.failed).toBe(false);
    expect(disabled.source).toBe("deterministic");
    expect(disabled.reason).toContain("disabled after repeated failures");
  });
});
