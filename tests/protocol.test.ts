import { describe, expect, it } from "vitest";
import {
  ActionSchema,
  ClientMessageSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  SnapshotSchema,
  actionTimeoutMs,
  parseAction,
} from "../src/protocol/types.js";
import { SimulatedGame } from "../src/sim/simulator.js";

describe("wire protocol", () => {
  it("pins a semantic protocol version", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("accepts a bounded navigate action and rejects out-of-range timeouts", () => {
    const action = parseAction({ type: "navigate", target: { x: 1, y: 64, z: 2 }, range: 3, timeoutMs: 5_000 });
    expect(action.type).toBe("navigate");
    expect(actionTimeoutMs(action)).toBe(5_000);
    expect(ActionSchema.safeParse({ type: "navigate", target: { x: 1, y: 64, z: 2 }, timeoutMs: 999_999 }).success).toBe(false);
  });

  it("rejects unknown actions and malformed item ids", () => {
    expect(ActionSchema.safeParse({ type: "teleport", target: { x: 0, y: 0, z: 0 } }).success).toBe(false);
    expect(
      ActionSchema.safeParse({ type: "collect", item: "oak_log", count: 2 }).success,
    ).toBe(false);
  });

  it("validates client and server envelopes", () => {
    expect(
      ClientMessageSchema.safeParse({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "test", version: "1.0.0" },
      }).success,
    ).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: "hello", protocolVersion: "1.0.0" }).success).toBe(false);
    expect(
      ServerMessageSchema.safeParse({ type: "pong", nonce: "abc" }).success,
    ).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "pong" }).success).toBe(false);
  });

  it("produces a schema-valid simulator snapshot", () => {
    const sim = new SimulatedGame({ seed: 7 });
    const snapshot = sim.snapshot();
    expect(SnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.adapter.name).toBe("MinecraftSimulator");
  });
});
