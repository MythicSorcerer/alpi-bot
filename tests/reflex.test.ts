import { describe, expect, it } from "vitest";
import { ReflexLayer } from "../src/controller/reflex.js";
import type { Snapshot } from "../src/protocol/types.js";
import { SimulatedGame } from "../src/sim/simulator.js";
import { tempDir, testConfig } from "./helpers.js";

function snapshot(): Snapshot {
  return new SimulatedGame({ seed: 13 }).snapshot();
}

const layer = new ReflexLayer(testConfig(tempDir("reflex")));
const idle = { consecutiveFailures: 0, settled: true };

describe("survival reflexes", () => {
  it("surfaces when drowning", () => {
    const state = snapshot();
    state.bot.inWater = true;
    state.bot.air = 20;
    expect(layer.evaluate(state, idle)?.action.type).toBe("surface");
  });

  it("climbs out when below the void floor", () => {
    const state = snapshot();
    state.bot.position.y = -70;
    const decision = layer.evaluate(state, idle);
    expect(decision?.action.type).toBe("navigate");
    expect(decision?.priority).toBe("critical");
  });

  it("flees a nearby hostile when health is low", () => {
    const state = snapshot();
    state.bot.health = 4;
    state.world.nearbyEntities.push({
      id: "zombie-test",
      type: "minecraft:zombie",
      kind: "hostile",
      position: { x: 2, y: 64, z: 0 },
      distance: 2,
    });
    const decision = layer.evaluate(state, idle);
    expect(decision?.action.type).toBe("flee");
  });

  it("fights a nearby hostile when healthy and armed", () => {
    const state = snapshot();
    state.bot.health = 20;
    state.world.nearbyEntities.push({
      id: "zombie-test",
      type: "minecraft:zombie",
      kind: "hostile",
      position: { x: 5, y: 64, z: 0 },
      distance: 5,
    });
    expect(layer.evaluate(state, idle)?.action.type).toBe("attack");
  });

  it("eats before continuing a task", () => {
    const state = snapshot();
    state.bot.food = 4;
    const decision = layer.evaluate(state, idle);
    expect(decision?.action.type).toBe("eat");
    expect(decision?.priority).toBe("high");
  });

  it("sleeps at night when a bed is reachable and no threat is nearby", () => {
    const state = snapshot();
    state.world.timeOfDay = 13_000;
    state.bot.position = { x: 480, y: 64, z: 0 };
    state.world.nearbyBlocks.push({ type: "minecraft:red_bed", position: { x: 482, y: 64, z: 0 } });
    expect(layer.evaluate(state, idle)?.action.type).toBe("sleep");
  });

  it("stops after repeated failures", () => {
    const state = snapshot();
    expect(layer.evaluate(state, { consecutiveFailures: 3, lastActionType: "navigate", settled: true })?.action.type).toBe("stop");
  });

  it("waits for the adapter to respawn a dead bot", () => {
    const state = snapshot();
    state.bot.health = 0;
    expect(layer.evaluate(state, idle)?.action.type).toBe("wait");
  });
});
