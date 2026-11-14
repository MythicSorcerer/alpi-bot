import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config-file.js";
import { DEFAULT_GEAR_CHECKLIST, parseConfig } from "../src/config.js";
import {
  assertActionAllowed,
  assertAdapterAllowed,
  assertServerAllowed,
  isLoopbackHost,
  isServerWhitelisted,
  killSwitchActive,
  parseHostPort,
} from "../src/guardrails.js";
import { redact } from "../src/util/redact.js";
import { tempDir, testConfig } from "./helpers.js";

describe("configuration", () => {
  it("fills safe defaults", () => {
    const config = parseConfig({});
    expect(config.bot.username).toBe("MCBot");
    expect(config.planner.mode).toBe("deterministic");
    expect(config.guardrails.allowRemoteAdapter).toBe(false);
    expect(config.guardrails.allowExploits).toBe(false);
    expect(config.guardrails.serverWhitelist).toContain("127.0.0.1:25565");
    expect(config.run.maxActions).toBe(5_000);
    expect(config.gear.checklist).toHaveLength(7);
    expect(config.gear.checklist.every((entry) => entry.optional === false)).toBe(true);
  });

  it("keeps the gear checkpoint explicit", () => {
    const items = DEFAULT_GEAR_CHECKLIST.map((entry) => entry.item);
    expect(items).toEqual([
      "minecraft:diamond_helmet",
      "minecraft:diamond_chestplate",
      "minecraft:diamond_leggings",
      "minecraft:diamond_boots",
      "minecraft:diamond_sword",
      "minecraft:diamond_pickaxe",
      "minecraft:diamond_axe",
    ]);
    const boots = DEFAULT_GEAR_CHECKLIST.find((entry) => entry.item === "minecraft:diamond_boots");
    expect(boots?.enchants).toContainEqual({ id: "minecraft:feather_falling", level: 4 });
  });

  it("rejects unknown keys and invalid ranges", () => {
    expect(() => parseConfig({ bot: { username: "ok", extra: true } })).toThrow();
    expect(() => parseConfig({ run: { maxActions: 0 } })).toThrow();
    expect(() => parseConfig({ economy: { emeraldTarget: 0 } })).toThrow();
  });

  it("loads and validates the checked-in default config", () => {
    const config = loadConfig("config/default.yaml", {});
    expect(config.simulation.scenario).toBe("default");
    expect(config.gear.checklist).toHaveLength(7);
    expect(config.planner.mode).toBe("deterministic");
  });

  it("applies environment overrides without logging secrets", () => {
    const config = loadConfig(undefined, {
      MCBOT_ADAPTER_URL: "ws://127.0.0.1:9999",
      MCBOT_USERNAME: "EnvBot",
      MCBOT_LOG_LEVEL: "debug",
      MCBOT_STATE_DIR: "/tmp/env-state",
      MCBOT_PLANNER_MODE: "qwen",
      MCBOT_QWEN_MODEL: "qwen-test",
      MCBOT_SERVER_WHITELIST: "localhost:25565, example.invalid:25566",
      MCBOT_ALLOW_REMOTE_ADAPTER: "1",
    });
    expect(config.adapter.url).toBe("ws://127.0.0.1:9999");
    expect(config.bot.username).toBe("EnvBot");
    expect(config.logging.level).toBe("debug");
    expect(config.persistence.dir).toBe("/tmp/env-state");
    expect(config.planner.mode).toBe("qwen");
    expect(config.planner.qwen.model).toBe("qwen-test");
    expect(config.guardrails.serverWhitelist).toEqual(["localhost:25565", "example.invalid:25566"]);
    expect(config.guardrails.allowRemoteAdapter).toBe(true);
  });
});

describe("guardrails", () => {
  it("recognizes loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.10.0.4")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("192.168.1.2")).toBe(false);
  });

  it("parses host/port pairs, including IPv6", () => {
    expect(parseHostPort("127.0.0.1:25565")).toEqual({ host: "127.0.0.1", port: 25565 });
    expect(parseHostPort("[::1]:25565")).toEqual({ host: "::1", port: 25565 });
    expect(parseHostPort("localhost")).toEqual({ host: "localhost", port: null });
  });

  it("refuses a non-loopback adapter unless explicitly enabled", () => {
    const config = testConfig(tempDir("guard-adapter"));
    config.adapter.url = "ws://example.com:8765";
    expect(() => assertAdapterAllowed(config)).toThrow(/not loopback/);
    config.guardrails.allowRemoteAdapter = true;
    expect(assertAdapterAllowed(config).hostname).toBe("example.com");
    config.adapter.url = "http://127.0.0.1:8765";
    expect(() => assertAdapterAllowed(config)).toThrow(/ws:\/\//);
  });

  it("enforces the server whitelist and wildcard entries", () => {
    const config = testConfig(tempDir("guard-server"));
    expect(isServerWhitelisted({ address: "127.0.0.1:25565", version: "1.21.4" }, config)).toBe(true);
    expect(isServerWhitelisted({ address: "127.0.0.1:25566", version: "1.21.4" }, config)).toBe(false);
    expect(() => assertServerAllowed(undefined, config)).toThrow(/did not report a server/);
    config.guardrails.serverWhitelist = ["*.example.test:25565"];
    expect(isServerWhitelisted({ address: "mc.example.test:25565", version: "1.21.4" }, config)).toBe(true);
    expect(isServerWhitelisted({ address: "example.test:25565", version: "1.21.4" }, config)).toBe(true);
    expect(isServerWhitelisted({ address: "mc.example.test:25566", version: "1.21.4" }, config)).toBe(false);
  });

  it("blocks oversized actions and exploit mode", () => {
    const config = testConfig(tempDir("guard-actions"));
    expect(() => assertActionAllowed({ type: "wait", durationMs: 400_000 }, config)).toThrow();
    expect(() => assertActionAllowed({ type: "collect", item: "minecraft:oak_log", count: 600 }, config)).toThrow();
    expect(() => assertActionAllowed({ type: "trade", villagerId: "v", offerIndex: 0, times: 65 }, config)).toThrow();
    expect(() => assertActionAllowed({ type: "stop" }, config)).not.toThrow();
    config.guardrails.allowExploits = true;
    expect(() => assertActionAllowed({ type: "stop" }, config)).toThrow(/never uses cheat/);
    config.guardrails.allowExploits = false;
    config.guardrails.allowChat = true;
    expect(() => assertActionAllowed({ type: "stop" }, config)).toThrow(/no chat action/);
  });

  it("detects the kill switch file", () => {
    const directory = tempDir("guard-kill");
    const config = testConfig(directory);
    config.guardrails.killSwitchFile = join(directory, "STOP");
    expect(killSwitchActive(config)).toBe(false);
    writeFileSync(config.guardrails.killSwitchFile, "stop");
    expect(killSwitchActive(config)).toBe(true);
  });
});

describe("redaction", () => {
  it("removes tokens, API keys and authorization values", () => {
    const redacted = redact({
      authorization: "Bearer abc.def",
      apiKey: "sk-abcdefghijkl",
      nested: { password: "hunter2", note: "token=abc123" },
      safe: "visible",
    }) as Record<string, unknown>;
    expect(redacted.authorization).toBe("[REDACTED]");
    expect(redacted.apiKey).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).password).toBe("[REDACTED]");
    expect(redacted.safe).toBe("visible");
  });
});
