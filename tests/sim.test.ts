import { describe, expect, it } from "vitest";
import { SnapshotSchema, type ActionResult, type Action } from "../src/protocol/types.js";
import { SimulatedGame } from "../src/sim/simulator.js";
import { countItem } from "../src/util/items.js";

let counter = 0;

async function act(sim: SimulatedGame, action: Action): Promise<ActionResult> {
  counter += 1;
  return sim.execute(action, `test-${counter}`);
}

describe("deterministic simulator", () => {
  it("is reproducible for a fixed seed and validates against the snapshot schema", () => {
    const first = new SimulatedGame({ seed: 99, villageDistance: 480 });
    const second = new SimulatedGame({ seed: 99, villageDistance: 480 });
    const one = first.snapshot();
    const two = second.snapshot();
    expect(SnapshotSchema.safeParse(one).success).toBe(true);
    expect(one.world.nearbyBlocks).toEqual(two.world.nearbyBlocks);
    expect(one.bot.position).toEqual(two.bot.position);
    expect(one.world.village).toBeNull();
    expect(one.world.villagers).toHaveLength(0);
  });

  it("collects logs and crafts planks and sticks", async () => {
    const sim = new SimulatedGame({ seed: 42 });
    const collected = await act(sim, { type: "collect", item: "minecraft:oak_log", count: 48, radius: 128 });
    expect(collected.ok).toBe(true);
    expect(collected.data?.collected).toBeGreaterThan(0);
    expect(countItem(sim.snapshot().bot.inventory, "minecraft:oak_log")).toBeGreaterThanOrEqual(32);

    const planks = await act(sim, { type: "craft", item: "minecraft:oak_planks", count: 128 });
    expect(planks.ok).toBe(true);
    expect(countItem(sim.snapshot().bot.inventory, "minecraft:oak_planks")).toBeGreaterThanOrEqual(128);

    const sticks = await act(sim, { type: "craft", item: "minecraft:stick", count: 128 });
    expect(sticks.ok).toBe(true);
    expect(countItem(sim.snapshot().bot.inventory, "minecraft:stick")).toBeGreaterThanOrEqual(128);
  });

  it("walks to a village, inspects a villager and earns an emerald with a stick trade", async () => {
    const sim = new SimulatedGame({ seed: 42, villageDistance: 480 });
    await act(sim, { type: "collect", item: "minecraft:oak_log", count: 64, radius: 128 });
    await act(sim, { type: "craft", item: "minecraft:oak_planks", count: 128 });
    await act(sim, { type: "craft", item: "minecraft:stick", count: 256 });
    const center = sim.getVillageCenter();
    const walk = await act(sim, { type: "navigate", target: center, range: 4 });
    expect(walk.ok).toBe(true);

    const snapshot = sim.snapshot();
    expect(snapshot.world.village?.valid).toBe(true);
    const fletcher = snapshot.world.villagers.find((villager) => villager.profession === "fletcher");
    expect(fletcher).toBeDefined();
    await act(sim, { type: "navigate", target: fletcher!.position, range: 2 });
    const inspected = await act(sim, { type: "inspect_trades", villagerId: fletcher!.id });
    expect(inspected.ok).toBe(true);
    const offer = (inspected.data?.trades as Array<{ index: number; inputs: Array<{ item: string }>; output: { item: string } }>).find(
      (candidate) => candidate.inputs[0]?.item === "minecraft:stick" && candidate.output.item === "minecraft:emerald",
    );
    expect(offer).toBeDefined();
    const traded = await act(sim, { type: "trade", villagerId: fletcher!.id, offerIndex: offer!.index, times: 2 });
    expect(traded.ok).toBe(true);
    expect(countItem(sim.snapshot().bot.inventory, "minecraft:emerald")).toBe(2);
    expect(sim.getStats().trades).toBe(2);
  });

  it("rejects out-of-range trade actions with a stable code", async () => {
    const sim = new SimulatedGame({ seed: 42 });
    const snapshot = sim.snapshot();
    const result = await act(sim, { type: "trade", villagerId: "villager-unknown", offerIndex: 0, times: 1 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ENTITY_NOT_FOUND");
    expect(snapshot.world.village).toBeNull();
  });
});
