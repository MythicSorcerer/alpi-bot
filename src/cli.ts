#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { loadConfig } from "./config-file.js";
import { ConfigSchema, GearRequirementSchema, parseConfig, type Config } from "./config.js";
import { assertAdapterAllowed, isServerWhitelisted, killSwitchActive } from "./guardrails.js";
import { Logger } from "./logging/logger.js";
import { GameAdapterServer } from "./adapter/ws-server.js";
import { WsGameClient } from "./adapter/ws-client.js";
import { runAdapterConformance, summarizeConformance } from "./adapter/conformance.js";
import { BotController, type RunSummary } from "./controller/controller.js";
import { RunStateSchema } from "./controller/state.js";
import { verifyGear } from "./gear/checklist.js";
import { readEventLog, EventRecordSchema, writeFileAtomic } from "./persistence/event-log.js";
import {
  CheckpointSchema,
  checkpointPath,
  readCheckpoint,
  verifyCheckpoint,
} from "./persistence/checkpoint.js";
import {
  ActionSchema,
  ClientMessageSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  SnapshotSchema,
  type Snapshot,
} from "./protocol/types.js";
import { SimulatedGame, type SimScenario } from "./sim/simulator.js";

let exitCode = 0;

interface CommonOptions {
  config?: string;
  stateDir?: string;
  json?: boolean;
  logLevel?: "debug" | "info" | "warn" | "error";
}

function applyCommon(base: Config, options: CommonOptions): Config {
  const next = structuredClone(base);
  if (options.stateDir) next.persistence.dir = resolve(options.stateDir);
  if (options.logLevel) next.logging.level = options.logLevel;
  return parseConfig(next);
}

function makeLogger(config: Config, json: boolean): Logger {
  return new Logger({
    level: config.logging.level,
    pretty: json ? false : config.logging.pretty,
    ...(json ? { sink: (line: string) => process.stderr.write(`${line}\n`) } : {}),
  });
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function printSummary(summary: RunSummary): void {
  const emeralds = summary.snapshot?.bot.inventory
    .filter((stack) => stack.item === "minecraft:emerald")
    .reduce((sum, stack) => sum + stack.count, 0);
  const lines = [
    `run:        ${summary.runId}${summary.resumed ? " (resumed)" : ""}`,
    `name:       ${summary.runName}`,
    `result:     ${summary.ok ? "OK" : "INCOMPLETE"}${summary.reason ? ` (${summary.reason})` : ""}`,
    `duration:   ${formatDuration(summary.durationMs)} this session, ${formatDuration(summary.runAgeMs)} run age`,
    `adapter:    ${summary.adapter ? `${summary.adapter.name} ${summary.adapter.version}` : "unknown"}`,
    `server:     ${summary.server ? `${summary.server.address} (${summary.server.version})` : "unknown"}`,
    `actions:    ${summary.metrics.actionsSucceeded}/${summary.metrics.actionsAttempted} succeeded, ${summary.metrics.actionsFailed} failed, ${summary.metrics.retries} retries`,
    `reflexes:   ${summary.metrics.reflexActions}`,
    `economy:    ${summary.metrics.emeraldsEarned} earned, ${summary.metrics.emeraldsSpent} spent, ${summary.ledger.trades} trades${emeralds === undefined ? "" : `, ${emeralds} held`}`,
    `gear:       ${summary.gear.verified ? "verified" : "incomplete"} (${summary.gear.items.filter((item) => item.ok).length}/${summary.gear.items.length})`,
  ];
  if (!summary.gear.verified) {
    lines.push(`missing:    ${summary.gear.missingItems.concat(summary.gear.missingEnchantments).join("; ") || "unknown"}`);
  }
  lines.push(`checkpoint: ${summary.checkpoint ?? "not written"}`);
  lines.push(`report:     ${summary.report}`);
  lines.push(`events:     ${summary.eventLog}`);
  if (summary.notes.length > 0) {
    lines.push("notes:");
    for (const note of summary.notes) lines.push(`  - ${note}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function resolveCheckpoint(config: Config, explicit?: string): string {
  if (explicit) return resolve(explicit);
  const preferred = checkpointPath(config);
  if (existsSync(preferred)) return preferred;
  const directory = config.persistence.dir;
  if (!existsSync(directory)) throw new Error(`no checkpoint found: ${directory} does not exist`);
  const candidates = readdirSync(directory)
    .filter((name) => /^checkpoint.*\.json$/.test(name))
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const newest = candidates[0];
  if (!newest) throw new Error(`no checkpoint*.json found in ${directory}`);
  return newest;
}

function resolveEvidencePath(config: Config, explicit: string | undefined, fallback: string | undefined): string {
  if (explicit) return resolve(explicit);
  if (fallback) return fallback;
  return join(config.persistence.dir, "events.jsonl");
}

function parseChecklist(raw: unknown, label: string) {
  const parsed = z.array(GearRequirementSchema).min(1).parse(raw);
  if (parsed.length === 0) throw new Error(`${label} is empty`);
  return parsed;
}

function simulationOptions(config: Config, options: { scenario?: SimScenario; seed?: string; villageDistance?: string }) {
  return {
    scenario: options.scenario ?? config.simulation.scenario,
    seed: options.seed ? Number(options.seed) : config.run.seed,
    villageDistance: options.villageDistance ? Number(options.villageDistance) : config.simulation.villageDistance,
    detectionRadius: config.exploration.detectionRadius,
  };
}

function assertInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

async function doctorChecks(config: Config): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  checks.push({
    name: "node",
    status: major > 20 || (major === 20 && minor >= 11) ? "ok" : "fail",
    detail: `${process.versions.node} (requires >=20.11)`,
  });

  try {
    checks.push({ name: "config", status: "ok", detail: "schema validation passed" });
  } catch (error) {
    checks.push({ name: "config", status: "fail", detail: (error as Error).message });
  }

  if (config.guardrails.allowExploits) {
    checks.push({ name: "exploit-policy", status: "fail", detail: "allowExploits must stay false" });
  } else {
    checks.push({ name: "exploit-policy", status: "ok", detail: "exploit modules disabled" });
  }
  if (config.guardrails.allowChat) {
    checks.push({ name: "chat-policy", status: "fail", detail: "allowChat must stay false; there is no chat action" });
  } else {
    checks.push({ name: "chat-policy", status: "ok", detail: "no chat capability exposed" });
  }

  try {
    const url = assertAdapterAllowed(config);
    checks.push({
      name: "adapter-url",
      status: "ok",
      detail: `${url.protocol}//${url.host}${url.pathname}`,
    });
  } catch (error) {
    checks.push({ name: "adapter-url", status: "fail", detail: (error as Error).message });
  }

  const simulated = { address: "127.0.0.1:25565", version: "1.21.4" } as const;
  if (isServerWhitelisted(simulated, config)) {
    checks.push({ name: "server-whitelist", status: "ok", detail: "127.0.0.1:25565 is allowed" });
  } else if (!config.guardrails.requireServerWhitelist) {
    checks.push({ name: "server-whitelist", status: "warn", detail: "whitelist checking is disabled" });
  } else {
    checks.push({ name: "server-whitelist", status: "warn", detail: "127.0.0.1:25565 is not whitelisted for live runs" });
  }

  try {
    mkdirSync(config.persistence.dir, { recursive: true });
    const probe = join(config.persistence.dir, `.mcbot-write-probe-${process.pid}`);
    writeFileSync(probe, "ok", { encoding: "utf8", mode: 0o600 });
    rmSync(probe, { force: true });
    checks.push({ name: "state-dir", status: "ok", detail: `${resolve(config.persistence.dir)} is writable` });
  } catch (error) {
    checks.push({ name: "state-dir", status: "fail", detail: (error as Error).message });
  }

  if (killSwitchActive(config)) {
    checks.push({ name: "kill-switch", status: "warn", detail: `${config.guardrails.killSwitchFile} exists; runs stop immediately` });
  } else {
    checks.push({ name: "kill-switch", status: "ok", detail: "not active" });
  }

  try {
    const sim = new SimulatedGame({
      scenario: config.simulation.scenario,
      seed: config.run.seed,
      villageDistance: config.simulation.villageDistance,
      detectionRadius: config.exploration.detectionRadius,
    });
    const snapshot: Snapshot = SnapshotSchema.parse(sim.snapshot());
    checks.push({
      name: "simulator",
      status: snapshot.bot.health > 0 ? "ok" : "fail",
      detail: `scenario=${config.simulation.scenario} seed=${config.run.seed} village=${config.simulation.villageDistance} blocks`,
    });
  } catch (error) {
    checks.push({ name: "simulator", status: "fail", detail: (error as Error).message });
  }

  if (config.planner.mode === "qwen") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    try {
      const response = await fetch(`${config.planner.qwen.baseUrl.replace(/\/$/, "")}/models`, {
        signal: controller.signal,
      });
      checks.push({
        name: "qwen",
        status: response.ok ? "ok" : "warn",
        detail: response.ok
          ? `${config.planner.qwen.baseUrl} responded`
          : `${config.planner.qwen.baseUrl} returned HTTP ${response.status}; deterministic fallback stays active`,
      });
    } catch (error) {
      checks.push({
        name: "qwen",
        status: "warn",
        detail: `unreachable (${(error as Error).message}); deterministic fallback stays active`,
      });
    } finally {
      clearTimeout(timer);
    }
  } else {
    checks.push({ name: "qwen", status: "ok", detail: "not configured; deterministic planner in use" });
  }

  return checks;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  exitCode = 0;
  const program = new Command();
  program
    .name("mcbot")
    .description("Player-like Minecraft bot controller with a typed adapter, survival reflexes, villager economy and gear checkpoint.")
    .version("0.1.0")
    .exitOverride();

  const addCommon = (command: Command): Command =>
    command
      .option("-c, --config <path>", "YAML or JSON config file")
      .option("--state-dir <path>", "override persistence.dir")
      .option("--json", "machine-readable output")
      .option("--log-level <level>", "debug, info, warn or error");

  addCommon(program.command("simulate"))
    .description("run the full controller against the deterministic in-process simulator")
    .option("--scenario <name>", "default, hostile-night or scarce")
    .option("--seed <number>", "simulation seed")
    .option("--village-distance <blocks>", "distance to the simulated village")
    .option("--max-actions <number>", "action budget override")
    .option("--max-minutes <number>", "time budget override")
    .option("--resume", "resume persisted controller state instead of starting fresh")
    .action(async (options) => {
      const base = loadConfig(options.config);
      const config = applyCommon(base, options as CommonOptions);
      if (options.scenario !== undefined) {
        if (!["default", "hostile-night", "scarce"].includes(options.scenario)) {
          throw new Error(`unknown scenario: ${options.scenario}`);
        }
        config.simulation.scenario = options.scenario as SimScenario;
      }
      const seed = assertInteger(options.seed, "--seed");
      if (seed !== undefined) config.run.seed = seed;
      const villageDistance = Number(options.villageDistance);
      if (options.villageDistance !== undefined) {
        if (!Number.isFinite(villageDistance) || villageDistance < 64) throw new Error("--village-distance must be >= 64");
        config.simulation.villageDistance = villageDistance;
      }
      const maxActions = assertInteger(options.maxActions, "--max-actions");
      if (maxActions !== undefined) config.run.maxActions = maxActions;
      const maxMinutes = Number(options.maxMinutes);
      if (options.maxMinutes !== undefined) {
        if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error("--max-minutes must be > 0");
        config.run.maxMinutes = maxMinutes;
      }
      const validated = parseConfig(config);
      const logger = makeLogger(validated, Boolean(options.json));
      const sim = new SimulatedGame(simulationOptions(validated, options));
      const controller = new BotController(validated, sim, {
        logger,
        resume: Boolean(options.resume),
        deterministic: true,
      });
      const summary = await controller.run();
      if (options.json) {
        write({
          ...summary,
          simulation: {
            ...sim.getStats(),
            scenario: validated.simulation.scenario,
            seed: validated.run.seed,
            villageCenter: sim.getVillageCenter(),
          },
        });
      } else {
        printSummary(summary);
      }
      if (!summary.ok) exitCode = 2;
    });

  addCommon(program.command("run"))
    .description("run the controller against a live loopback game adapter")
    .option("--fresh", "ignore persisted controller state and start a new run")
    .action(async (options) => {
      const base = loadConfig(options.config);
      const config = applyCommon(base, options as CommonOptions);
      const logger = makeLogger(config, Boolean(options.json));
      const adapter = new WsGameClient(config, logger);
      const controller = new BotController(config, adapter, {
        logger,
        resume: !options.fresh,
      });
      const onSignal = () => void controller.stop();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        const summary = await controller.run();
        if (options.json) write(summary);
        else printSummary(summary);
        if (!summary.ok) exitCode = 2;
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    });

  addCommon(program.command("adapter-sim"))
    .description("serve the deterministic simulator over the loopback WebSocket adapter protocol")
    .option("--port <number>", "listen port (0 picks a free port; defaults to simulation.port)")
    .option("--scenario <name>", "default, hostile-night or scarce")
    .option("--seed <number>", "simulation seed")
    .option("--village-distance <blocks>", "distance to the simulated village")
    .action(async (options) => {
      const base = loadConfig(options.config);
      const config = applyCommon(base, options as CommonOptions);
      if (options.scenario !== undefined) {
        if (!["default", "hostile-night", "scarce"].includes(options.scenario)) {
          throw new Error(`unknown scenario: ${options.scenario}`);
        }
        config.simulation.scenario = options.scenario as SimScenario;
      }
      const seed = assertInteger(options.seed, "--seed");
      if (seed !== undefined) config.run.seed = seed;
      const villageDistance = Number(options.villageDistance);
      if (options.villageDistance !== undefined) {
        if (!Number.isFinite(villageDistance) || villageDistance < 64) throw new Error("--village-distance must be >= 64");
        config.simulation.villageDistance = villageDistance;
      }
      const port = assertInteger(options.port, "--port") ?? config.simulation.port;
      const validated = parseConfig(config);
      const logger = makeLogger(validated, Boolean(options.json));
      const sim = new SimulatedGame(simulationOptions(validated, options));
      const server = new GameAdapterServer(sim, { host: "127.0.0.1", port: port ?? 0, logger });
      const address = await server.listen();
      if (options.json) {
        write({ url: address.url, host: address.host, port: address.port, adapter: sim.info.name, server: sim.server });
      } else {
        process.stdout.write(`adapter-sim listening on ${address.url}\n`);
        process.stdout.write(`whitelist if needed: ${sim.server?.address ?? "127.0.0.1:25565"}\n`);
      }
      await new Promise<void>((resolveWait) => {
        const shutdown = () => {
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);
          void server.close().finally(() => resolveWait());
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
    });

  addCommon(program.command("doctor"))
    .description("check config, guardrails, simulator, state directory and planner reachability")
    .action(async (options) => {
      const base = loadConfig(options.config);
      const config = applyCommon(base, options as CommonOptions);
      const checks = await doctorChecks(config);
      const failed = checks.filter((check) => check.status === "fail").length;
      if (options.json) write({ ok: failed === 0, checks });
      else {
        for (const check of checks) {
          process.stdout.write(`${check.status.toUpperCase().padEnd(4)} ${check.name.padEnd(18)} ${check.detail}\n`);
        }
        process.stdout.write(`\n${failed === 0 ? "doctor passed" : `doctor found ${failed} failure(s)`}\n`);
      }
      if (failed > 0) exitCode = 1;
    });

  addCommon(program.command("conformance"))
    .description("probe a loopback adapter against the wire protocol without running the bot")
    .option("--url <url>", "adapter WebSocket URL override")
    .option("--timeout-ms <number>", "per-check timeout", "3000")
    .action(async (options) => {
      const base = loadConfig(options.config);
      const config = applyCommon(base, options as CommonOptions);
      if (options.url !== undefined) config.adapter.url = options.url;
      const timeoutMs = assertInteger(options.timeoutMs, "--timeout-ms") ?? 3_000;
      if (timeoutMs < 100) throw new Error("--timeout-ms must be >= 100");
      const validated = parseConfig(config);
      const logger = makeLogger(validated, Boolean(options.json));
      const result = await runAdapterConformance(validated, { logger, timeoutMs });
      if (options.json) write(result);
      else {
        process.stdout.write(
          `adapter:   ${result.adapter ? `${result.adapter.name} ${result.adapter.version}` : "unknown"} at ${result.url}\n`,
        );
        process.stdout.write(`protocol:  ${result.protocolVersion}\n`);
        for (const check of result.checks) {
          process.stdout.write(`${check.status.toUpperCase().padEnd(4)} ${check.name.padEnd(20)} ${check.detail}\n`);
        }
        process.stdout.write(`\n${summarizeConformance(result)}\n`);
      }
      if (!result.ok) exitCode = 2;
    });

  addCommon(program.command("verify"))
    .description("verify a saved checkpoint checksum and its declared gear")
    .option("--checkpoint <path>", "checkpoint file; defaults to the newest in the state directory")
    .option("--checkpoint-checklist", "verify against the checklist stored in the checkpoint")
    .action(async (options) => {
      const base = loadConfig(options.config);
      const config = applyCommon(base, options as CommonOptions);
      const path = resolveCheckpoint(config, options.checkpoint);
      const checkpoint = readCheckpoint(path);
      const checklist = options.checkpointChecklist
        ? parseChecklist(checkpoint.checklist, "checkpoint checklist")
        : config.gear.checklist;
      const verification = verifyCheckpoint(checkpoint, checklist);
      const result = {
        ok: verification.verified,
        path,
        runId: checkpoint.runId,
        checksum: checkpoint.checksum,
        adapter: checkpoint.adapter,
        server: checkpoint.server,
        phase: checkpoint.phase,
        gear: verification,
        recordedGearVerified: checkpoint.gear.verified,
        checklistMatchesConfig:
          options.checkpointChecklist ? true : JSON.stringify(checkpoint.checklist) === JSON.stringify(config.gear.checklist),
      };
      if (options.json) write(result);
      else {
        process.stdout.write(`checkpoint: ${path}\n`);
        process.stdout.write(`checksum:   valid (${checkpoint.checksum.slice(0, 16)}...)\n`);
        process.stdout.write(`run:        ${checkpoint.runId}\n`);
        process.stdout.write(`phase:      ${checkpoint.phase}\n`);
        process.stdout.write(`server:     ${checkpoint.server ? `${checkpoint.server.address} (${checkpoint.server.version})` : "unknown"}\n`);
        process.stdout.write(`gear:       ${verification.verified ? "verified" : "incomplete"}\n`);
        for (const item of verification.items) {
          process.stdout.write(`  ${item.ok ? "OK  " : "MISS"} ${item.item}${item.missingEnchants.length > 0 ? ` missing ${item.missingEnchants.map((enchant) => `${enchant.id} ${enchant.level}`).join(", ")}` : ""}\n`);
        }
      }
      if (!verification.verified) exitCode = 2;
    });

  addCommon(program.command("inspect"))
    .description("summarize a checkpoint plus its event log and report")
    .option("--checkpoint <path>", "checkpoint file; defaults to the newest in the state directory")
    .option("--events <path>", "event log override")
    .option("--report <path>", "report override")
    .option("--notes <count>", "how many notes to print", "12")
    .action(async (options) => {
      const base = loadConfig(options.config);
      const config = applyCommon(base, options as CommonOptions);
      const path = resolveCheckpoint(config, options.checkpoint);
      const checkpoint = readCheckpoint(path);
      const eventsPath = resolveEvidencePath(config, options.events, checkpoint.evidence.eventLog);
      const reportPath = resolveEvidencePath(config, options.report, checkpoint.evidence.report);
      let events: ReturnType<typeof readEventLog> | null = null;
      let eventsError: string | null = null;
      try {
        events = readEventLog(eventsPath);
      } catch (error) {
        eventsError = (error as Error).message;
      }
      const report = existsSync(reportPath)
        ? (JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>)
        : null;
      const noteCount = Math.max(0, assertInteger(options.notes, "--notes") ?? 12);
      const emeralds = checkpoint.inventory
        .filter((stack) => stack.item === "minecraft:emerald")
        .reduce((sum, stack) => sum + stack.count, 0);
      const eventCounts: Record<string, number> = {};
      for (const event of events ?? []) eventCounts[event.event] = (eventCounts[event.event] ?? 0) + 1;
      const result = {
        path,
        runId: checkpoint.runId,
        phase: checkpoint.phase,
        createdAt: checkpoint.createdAt,
        updatedAt: checkpoint.updatedAt,
        adapter: checkpoint.adapter,
        server: checkpoint.server,
        position: checkpoint.position,
        health: checkpoint.snapshot.bot.health,
        food: checkpoint.snapshot.bot.food,
        xpLevel: checkpoint.snapshot.bot.xpLevel,
        emeralds,
        villagers: checkpoint.villagers.length,
        village: checkpoint.village,
        gear: checkpoint.gear,
        ledger: checkpoint.ledger,
        notes: checkpoint.resume.notes.slice(-noteCount),
        evidence: { eventLog: eventsPath, report: reportPath },
        eventCounts,
        eventsError,
        reportSummary: report
          ? {
              ok: report.ok,
              reason: report.reason,
              durationMs: report.durationMs,
              metrics: report.metrics,
              budget: report.budget,
            }
          : null,
      };
      if (options.json) write(result);
      else {
        process.stdout.write(`checkpoint: ${path}\n`);
        process.stdout.write(`run:        ${checkpoint.runId}\n`);
        process.stdout.write(`phase:      ${checkpoint.phase}\n`);
        process.stdout.write(`adapter:    ${checkpoint.adapter.name} ${checkpoint.adapter.version}\n`);
        process.stdout.write(`server:     ${checkpoint.server ? `${checkpoint.server.address} (${checkpoint.server.version})` : "unknown"}\n`);
        process.stdout.write(`position:   ${JSON.stringify(checkpoint.position)}\n`);
        process.stdout.write(`status:     health=${checkpoint.snapshot.bot.health} food=${checkpoint.snapshot.bot.food} xpLevel=${checkpoint.snapshot.bot.xpLevel}\n`);
        process.stdout.write(`economy:    ${checkpoint.ledger.emeraldsEarned} earned, ${checkpoint.ledger.emeraldsSpent} spent, ${checkpoint.ledger.trades} trades, ${emeralds} emeralds held\n`);
        process.stdout.write(`village:    ${checkpoint.village ? `population=${checkpoint.village.population} beds=${checkpoint.village.beds} valid=${checkpoint.village.valid}` : "none"}\n`);
        process.stdout.write(`gear:       ${checkpoint.gear.verified ? "verified" : "incomplete"}\n`);
        if (eventsError) process.stdout.write(`events:     unavailable (${eventsError})\n`);
        else {
          process.stdout.write(`events:     ${events?.length ?? 0} records at ${eventsPath}\n`);
          for (const [event, count] of Object.entries(eventCounts).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
            process.stdout.write(`  ${count.toString().padStart(5)}  ${event}\n`);
          }
        }
        if (report?.ok !== undefined) process.stdout.write(`report:     ok=${String(report.ok)} reason=${String(report.reason ?? "")}\n`);
        for (const note of checkpoint.resume.notes.slice(-noteCount)) process.stdout.write(`note:       ${note}\n`);
      }
    });

  addCommon(program.command("replay"))
    .description("validate and summarize an event log without re-executing any action")
    .option("--events <path>", "event log; defaults to <state-dir>/events.jsonl")
    .option("--limit <number>", "action entries to include", "100")
    .action(async (options) => {
      const base = loadConfig(options.config);
      const config = applyCommon(base, options as CommonOptions);
      const path = resolveEvidencePath(config, options.events, join(config.persistence.dir, "events.jsonl"));
      const events = readEventLog(path);
      const limit = Math.max(0, assertInteger(options.limit, "--limit") ?? 100);
      const runIds = [...new Set(events.map((event) => event.runId))];
      const levels: Record<string, number> = {};
      const counts: Record<string, number> = {};
      for (const event of events) {
        levels[event.level] = (levels[event.level] ?? 0) + 1;
        counts[event.event] = (counts[event.event] ?? 0) + 1;
      }
      let lastTimestamp = -1;
      let outOfOrder = 0;
      for (const event of events) {
        if (event.timestamp < lastTimestamp) outOfOrder += 1;
        lastTimestamp = event.timestamp;
      }
      const actions = events
        .filter((event) => event.event === "action.result")
        .slice(-limit)
        .map((event) => {
          const data = (event.data ?? {}) as Record<string, unknown>;
          return {
            timestamp: event.timestamp,
            action: data.action,
            ok: data.ok,
            code: data.code,
            reason: data.reason,
            durationMs: data.durationMs,
            phase: event.phase,
          };
        });
      const result = {
        path,
        records: events.length,
        runIds,
        levels,
        eventCounts: counts,
        outOfOrder,
        firstTimestamp: events[0]?.timestamp ?? null,
        lastTimestamp: events.at(-1)?.timestamp ?? null,
        actions,
      };
      if (options.json) write(result);
      else {
        process.stdout.write(`events:    ${events.length} records at ${path}\n`);
        process.stdout.write(`runs:      ${runIds.join(", ") || "none"}\n`);
        process.stdout.write(`levels:    ${Object.entries(levels).map(([level, count]) => `${level}=${count}`).join(" ")}\n`);
        if (outOfOrder > 0) process.stdout.write(`warning:   ${outOfOrder} timestamp regression(s)\n`);
        process.stdout.write("top events:\n");
        for (const [event, count] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
          process.stdout.write(`  ${count.toString().padStart(5)}  ${event}\n`);
        }
        if (actions.length > 0) {
          process.stdout.write("recent actions:\n");
          for (const action of actions) {
            process.stdout.write(`  ${action.ok ? "OK  " : "FAIL"} ${String(action.action).padEnd(14)} ${String(action.code).padEnd(18)} ${action.reason ?? ""}\n`);
          }
        }
      }
      if (outOfOrder > 0) exitCode = 2;
    });

  program
    .command("schema")
    .description("write JSON Schema documents for the protocol, config and persistence records")
    .option("--out <path>", "output file; defaults to stdout")
    .action((options) => {
      const definitions: Record<string, unknown> = {
        protocolVersion: { type: "string", const: PROTOCOL_VERSION },
      };
      const schemas: Array<[string, z.ZodTypeAny]> = [
        ["Action", ActionSchema],
        ["ClientMessage", ClientMessageSchema],
        ["ServerMessage", ServerMessageSchema],
        ["Snapshot", SnapshotSchema],
        ["Config", ConfigSchema],
        ["Checkpoint", CheckpointSchema],
        ["RunState", RunStateSchema],
        ["EventRecord", EventRecordSchema],
      ];
      for (const [name, schema] of schemas) {
        const converted = zodToJsonSchema(schema, { name, target: "jsonSchema7" }) as {
          $schema?: string;
          definitions?: Record<string, unknown>;
        };
        if (converted.definitions) Object.assign(definitions, converted.definitions);
        definitions[name] = converted.definitions?.[name] ?? converted;
        delete definitions.$schema;
      }
      const document = {
        $schema: "http://json-schema.org/draft-07/schema#",
        title: "all-purpose-mc-bot public schemas",
        protocolVersion: PROTOCOL_VERSION,
        definitions,
      };
      const text = `${JSON.stringify(document, null, 2)}\n`;
      if (options.out) {
        const target = resolve(options.out);
        writeFileAtomic(target, text);
        process.stdout.write(`wrote ${target}\n`);
      } else {
        process.stdout.write(text);
      }
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      return error.exitCode || 1;
    }
    process.stderr.write(`mcbot: ${(error as Error).message}\n`);
    return 1;
  }
  return exitCode;
}

const entry = process.argv[1];
const isEntrypoint = entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
if (isEntrypoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`mcbot: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
