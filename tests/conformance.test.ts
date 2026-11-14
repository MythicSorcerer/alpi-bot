import { describe, expect, it } from "vitest";
import { runAdapterConformance } from "../src/adapter/conformance.js";
import { GameAdapterServer } from "../src/adapter/ws-server.js";
import { silentLogger } from "../src/logging/logger.js";
import { SimulatedGame } from "../src/sim/simulator.js";
import { tempDir, testConfig } from "./helpers.js";

describe("adapter conformance", () => {
  it("passes the required protocol checks against the simulator adapter", async () => {
    const config = testConfig(tempDir("conformance"));
    const sim = new SimulatedGame({ seed: 7 });
    const server = new GameAdapterServer(sim, { host: "127.0.0.1", port: 0, logger: silentLogger });
    const address = await server.listen();
    config.adapter.url = address.url;
    try {
      const result = await runAdapterConformance(config, { logger: silentLogger, timeoutMs: 2_000 });
      const names = result.checks.map((check) => check.name);
      expect(result.ok).toBe(true);
      expect(result.adapter?.name).toBe("MinecraftSimulator");
      expect(result.server?.version).toBe("1.21.4");
      expect(names).toEqual(
        expect.arrayContaining([
          "handshake",
          "capabilities",
          "ping",
          "snapshot",
          "execute-wait",
          "cancel-message",
          "duplicate-hello",
          "handshake-required",
          "protocol-mismatch",
          "invalid-json",
          "invalid-message",
          "oversized-message",
          "busy",
        ]),
      );
      expect(result.checks.filter((check) => check.status === "fail")).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
