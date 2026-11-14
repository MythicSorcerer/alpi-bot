import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = join(root, "node_modules", ".bin", "tsx");

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(tsx, ["src/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MCBOT_LOG_LEVEL: "error" },
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("CLI", () => {
  it("runs doctor against the checked-in default config", () => {
    const result = cli(["doctor", "--config", "config/default.yaml", "--state-dir", tempDir("cli-doctor"), "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; checks: Array<{ name: string; status: string }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.find((check) => check.name === "simulator")?.status).toBe("ok");
  });

  it("writes protocol JSON Schema", () => {
    const directory = tempDir("cli-schema");
    const target = join(directory, "protocol.schema.json");
    const result = cli(["schema", "--out", target]);
    expect(result.status).toBe(0);
    expect(existsSync(target)).toBe(true);
    const schema = JSON.parse(readFileSync(target, "utf8")) as { protocolVersion: string; definitions: Record<string, unknown> };
    expect(schema.protocolVersion).toBe("1.0.0");
    expect(schema.definitions.Action).toBeDefined();
    expect(schema.definitions.Checkpoint).toBeDefined();
  });

  it("simulates the checkpoint and verifies it from the CLI", () => {
    const directory = tempDir("cli-simulate");
    const simulated = cli([
      "simulate",
      "--config",
      "config/default.yaml",
      "--state-dir",
      directory,
      "--json",
    ]);
    expect(simulated.status).toBe(0);
    const summary = JSON.parse(simulated.stdout) as { ok: boolean; checkpoint: string; simulation: { trades: number } };
    expect(summary.ok).toBe(true);
    expect(existsSync(summary.checkpoint)).toBe(true);
    expect(summary.simulation.trades).toBeGreaterThan(0);

    const verified = cli(["verify", "--config", "config/default.yaml", "--state-dir", directory, "--json"]);
    expect(verified.status).toBe(0);
    const result = JSON.parse(verified.stdout) as { ok: boolean; runId: string; gear: { verified: boolean } };
    expect(result.ok).toBe(true);
    expect(result.gear.verified).toBe(true);
    expect(result.runId).toMatch(/^run-/);

    const replay = cli(["replay", "--config", "config/default.yaml", "--state-dir", directory, "--json", "--limit", "2"]);
    expect(replay.status).toBe(0);
    const events = JSON.parse(replay.stdout) as { records: number; outOfOrder: number };
    expect(events.records).toBeGreaterThan(100);
    expect(events.outOfOrder).toBe(0);
  });
});
