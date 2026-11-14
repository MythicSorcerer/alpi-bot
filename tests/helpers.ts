import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type Config } from "../src/config.js";

export function tempDir(prefix = "mcbot-test"): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export function testConfig(directory: string, overrides: Record<string, unknown> = {}): Config {
  return parseConfig({
    logging: { level: "error", pretty: false },
    persistence: { dir: directory },
    run: { maxActions: 30_000, maxMinutes: 60, checkpointEveryActions: 100 },
    ...overrides,
  });
}
