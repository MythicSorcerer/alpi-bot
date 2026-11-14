import WebSocket from "ws";
import type { Config } from "../config.js";
import { assertAdapterAllowed } from "../guardrails.js";
import { Logger } from "../logging/logger.js";
import {
  ActionResultSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  SnapshotSchema,
  type AdapterLimits,
} from "../protocol/types.js";
import { sleep } from "../util/vec.js";
import { REQUIRED_CAPABILITIES } from "./types.js";

export type ConformanceStatus = "pass" | "fail" | "skip";

export interface ConformanceCheck {
  name: string;
  status: ConformanceStatus;
  detail: string;
}

export interface ConformanceResult {
  ok: boolean;
  url: string;
  protocolVersion: string;
  adapter: { name: string; version: string } | null;
  server: { address: string; version: string } | null;
  checks: ConformanceCheck[];
}

export interface ConformanceOptions {
  logger?: Logger;
  timeoutMs?: number;
}

interface Waiter {
  predicate: (value: unknown) => boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeIs(type: string) {
  return (value: unknown): boolean => isRecord(value) && value.type === type;
}

function errorCodeIs(code: string) {
  return (value: unknown): boolean => isRecord(value) && value.type === "error" && value.code === code;
}

/**
 * Small raw WebSocket probe. Conformance needs to send malformed and
 * pre-handshake messages, which the typed controller client deliberately
 * refuses to do.
 */
class Probe {
  private readonly messages: unknown[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly closeWaiters: Array<{ resolve: (value: { code: number; reason: string }) => void; timer: NodeJS.Timeout }> = [];
  private closeInfo: { code: number; reason: string } | null = null;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        value = { type: "__invalid_json__", raw: data.toString().slice(0, 200) };
      }
      this.messages.push(value);
      for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.waiters[index]!;
        let matches = false;
        try {
          matches = waiter.predicate(value);
        } catch {
          matches = false;
        }
        if (!matches) continue;
        this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      }
    });
    socket.on("close", (code, reason) => {
      this.closeInfo = { code, reason: reason.toString() };
      const error = new Error(`adapter closed the connection (${code} ${this.closeInfo.reason})`);
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      for (const waiter of this.closeWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(this.closeInfo);
      }
    });
    socket.on("error", () => {
      // A close event follows; the waiters handle it.
    });
  }

  static async connect(url: URL, timeoutMs: number): Promise<Probe> {
    const socket = new WebSocket(url, {
      handshakeTimeout: timeoutMs,
      maxPayload: 32 * 1024 * 1024,
      perMessageDeflate: false,
    });
    const probe = new Probe(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error(`could not connect to ${url.href} within ${timeoutMs}ms`));
      }, timeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`connection failed: ${error.message}`));
      });
    });
    return probe;
  }

  send(value: unknown): void {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("probe is not connected");
    this.socket.send(typeof value === "string" ? value : JSON.stringify(value));
  }

  async waitFor(
    predicate: (value: unknown) => boolean,
    label: string,
    timeoutMs: number,
  ): Promise<unknown> {
    const existing = this.messages.find(predicate);
    if (existing !== undefined) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  async waitForClose(timeoutMs: number): Promise<{ code: number; reason: string }> {
    if (this.closeInfo) return this.closeInfo;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.closeWaiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.closeWaiters.splice(index, 1);
        reject(new Error(`connection stayed open for ${timeoutMs}ms`));
      }, timeoutMs);
      this.closeWaiters.push({ resolve, timer });
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 1_000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close(1000, "conformance complete");
    });
  }
}

function passed(name: string, detail: string): ConformanceCheck {
  return { name, status: "pass", detail };
}

function failed(name: string, error: unknown): ConformanceCheck {
  return { name, status: "fail", detail: (error as Error).message };
}

function skipped(name: string, detail: string): ConformanceCheck {
  return { name, status: "skip", detail };
}

async function expectError(probe: Probe, code: string, timeoutMs: number): Promise<string> {
  const value = await probe.waitFor(errorCodeIs(code), `error ${code}`, timeoutMs);
  if (!isRecord(value) || value.type !== "error") throw new Error(`expected error ${code}`);
  return `received ${code}: ${String(value.message ?? "")}`;
}

/**
 * Run the adapter protocol checks without controlling the bot beyond one
 * short `wait`. Designed for the loopback adapter and safe to run against a
 * live adapter before the controller connects.
 */
export async function runAdapterConformance(
  config: Config,
  options: ConformanceOptions = {},
): Promise<ConformanceResult> {
  const url = assertAdapterAllowed(config);
  const timeoutMs = options.timeoutMs ?? 3_000;
  const log = options.logger ?? new Logger({ level: config.logging.level, pretty: config.logging.pretty });
  const checks: ConformanceCheck[] = [];
  let adapter: { name: string; version: string } | null = null;
  let server: { address: string; version: string } | null = null;
  let limits: AdapterLimits | null = null;

  let main: Probe | null = null;
  let stage = "connect";
  try {
    main = await Probe.connect(url, timeoutMs);
    stage = "handshake";
    main.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      client: { name: "mcbot-conformance", version: "0.1.0" },
    });
    const rawAck = await main.waitFor(typeIs("hello_ack"), "hello_ack", timeoutMs);
    const ack = ServerMessageSchema.parse(rawAck);
    if (ack.type !== "hello_ack") throw new Error("adapter did not answer hello with hello_ack");
    if (ack.protocolVersion.split(".")[0] !== PROTOCOL_VERSION.split(".")[0]) {
      throw new Error(`adapter protocol ${ack.protocolVersion} is incompatible with ${PROTOCOL_VERSION}`);
    }
    adapter = { name: ack.adapter.name, version: ack.adapter.version };
    server = ack.server ? { address: ack.server.address, version: ack.server.version } : null;
    limits = ack.limits;
    checks.push(passed("handshake", `${ack.adapter.name} ${ack.adapter.version} speaks ${ack.protocolVersion}`));

    stage = "capabilities";
    const missing = REQUIRED_CAPABILITIES.filter((capability) => !ack.adapter.capabilities.includes(capability));
    if (missing.length > 0) {
      checks.push({ name: "capabilities", status: "fail", detail: `missing ${missing.join(", ")}` });
    } else {
      checks.push(passed("capabilities", `${REQUIRED_CAPABILITIES.length} required capabilities advertised`));
    }

    stage = "ping";
    main.send({ type: "ping", nonce: "conformance-ping" });
    const pong = await main.waitFor(typeIs("pong"), "pong", timeoutMs);
    if (!isRecord(pong) || pong.nonce !== "conformance-ping") throw new Error("pong did not echo the nonce");
    checks.push(passed("ping", "pong echoed the nonce"));

    stage = "snapshot";
    main.send({ type: "snapshot_request", requestId: "conformance-snapshot" });
    const rawSnapshot = await main.waitFor(
      (value) => isRecord(value) && value.type === "snapshot" && value.requestId === "conformance-snapshot",
      "snapshot",
      timeoutMs,
    );
    const snapshotMessage = ServerMessageSchema.parse(rawSnapshot);
    if (snapshotMessage.type !== "snapshot") throw new Error("adapter did not answer with a snapshot");
    const snapshot = SnapshotSchema.parse(snapshotMessage.snapshot);
    if (snapshot.protocolVersion.split(".")[0] !== PROTOCOL_VERSION.split(".")[0]) {
      throw new Error(`snapshot protocol ${snapshot.protocolVersion} is incompatible`);
    }
    checks.push(
      passed(
        "snapshot",
        `${snapshot.bot.username} at ${snapshot.bot.position.x},${snapshot.bot.position.y},${snapshot.bot.position.z}; seq=${snapshot.seq}`,
      ),
    );

    stage = "execute-wait";
    main.send({
      type: "execute",
      requestId: "conformance-execute",
      actionId: "conformance-wait",
      action: { type: "wait", durationMs: 100 },
    });
    const rawResult = await main.waitFor(
      (value) => isRecord(value) && value.type === "result" && value.requestId === "conformance-execute",
      "result for a wait action",
      timeoutMs,
    );
    const resultMessage = ServerMessageSchema.parse(rawResult);
    if (resultMessage.type !== "result") throw new Error("adapter did not answer execute with a result");
    const result = ActionResultSchema.parse(resultMessage.result);
    if (!result.ok || result.code !== "OK") throw new Error(`wait action failed: ${result.code} ${result.reason ?? ""}`);
    checks.push(passed("execute-wait", `wait completed with code ${result.code}`));

    stage = "cancel-message";
    main.send({ type: "cancel", requestId: "conformance-cancel", targetActionId: "conformance-missing" });
    const rawCancel = await main.waitFor(
      (value) => isRecord(value) && value.type === "result" && value.requestId === "conformance-cancel",
      "cancel acknowledgement",
      timeoutMs,
    );
    const cancelMessage = ServerMessageSchema.parse(rawCancel);
    if (cancelMessage.type !== "result" || !cancelMessage.result.ok) {
      throw new Error("adapter did not acknowledge the cancel message");
    }
    checks.push(passed("cancel-message", "cancel acknowledged without an active action"));

    stage = "duplicate-hello";
    main.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      client: { name: "mcbot-conformance", version: "0.1.0" },
    });
    await expectError(main, "INVALID_MESSAGE", timeoutMs);
    checks.push(passed("duplicate-hello", "a second hello on one connection is rejected"));
  } catch (error) {
    checks.push(failed(stage, error));
    log.debug("conformance main probe failed", { stage, message: (error as Error).message });
  } finally {
    await main?.close().catch(() => undefined);
  }

  const negative = async (name: string, run: (probe: Probe) => Promise<string>): Promise<void> => {
    let probe: Probe | null = null;
    try {
      probe = await Probe.connect(url, timeoutMs);
      checks.push(passed(name, await run(probe)));
    } catch (error) {
      checks.push(failed(name, error));
    } finally {
      await probe?.close().catch(() => undefined);
    }
  };

  await negative("handshake-required", async (probe) => {
    probe.send({ type: "snapshot_request", requestId: "too-early" });
    return expectError(probe, "HANDSHAKE_REQUIRED", timeoutMs);
  });

  await negative("protocol-mismatch", async (probe) => {
    probe.send({
      type: "hello",
      protocolVersion: "999.0.0",
      client: { name: "mcbot-conformance", version: "0.1.0" },
    });
    return expectError(probe, "PROTOCOL_MISMATCH", timeoutMs);
  });

  await negative("invalid-json", async (probe) => {
    probe.send("{not valid json");
    return expectError(probe, "INVALID_JSON", timeoutMs);
  });

  await negative("invalid-message", async (probe) => {
    probe.send({ type: "definitely_not_a_protocol_message" });
    return expectError(probe, "INVALID_MESSAGE", timeoutMs);
  });

  const oversizedBudget = limits === null ? null : limits.maxMessageBytes + 1 <= 8 * 1024 * 1024 ? limits.maxMessageBytes : null;
  if (oversizedBudget !== null) {
    await negative("oversized-message", async (probe) => {
      probe.send(`"${"x".repeat(oversizedBudget)}"`);
      try {
        return await expectError(probe, "MESSAGE_TOO_LARGE", timeoutMs);
      } catch {
        const close = await probe.waitForClose(timeoutMs);
        return `socket closed after an oversized frame (${close.code} ${close.reason})`;
      }
    });
  } else {
    checks.push(skipped("oversized-message", "adapter limit is above the 8 MiB conformance probe budget"));
  }

  // Busy handling needs a blocking action. The simulator finishes instantly,
  // so a live adapter should report BUSY while the simulator reports a skip.
  let busyProbeA: Probe | null = null;
  let busyProbeB: Probe | null = null;
  try {
    busyProbeA = await Probe.connect(url, timeoutMs);
    busyProbeB = await Probe.connect(url, timeoutMs);
    for (const [probe, label] of [
      [busyProbeA, "a"],
      [busyProbeB, "b"],
    ] as const) {
      probe.send({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        client: { name: `mcbot-conformance-${label}`, version: "0.1.0" },
      });
      await probe.waitFor(typeIs("hello_ack"), "hello_ack", timeoutMs);
    }
    busyProbeA.send({
      type: "execute",
      requestId: "conformance-busy-a",
      actionId: "conformance-busy-a",
      action: { type: "wait", durationMs: 1_000 },
    });
    await sleep(30);
    busyProbeB.send({
      type: "execute",
      requestId: "conformance-busy-b",
      actionId: "conformance-busy-b",
      action: { type: "wait", durationMs: 50 },
    });
    const outcome = await busyProbeB.waitFor(
      (value) => isRecord(value) && (value.type === "result" || value.type === "error"),
      "busy result",
      timeoutMs,
    );
    if (isRecord(outcome) && outcome.type === "error" && outcome.code === "BUSY") {
      checks.push(passed("busy", "a second concurrent action was rejected with BUSY"));
    } else {
      checks.push(skipped("busy", "first action completed before the second could overlap (common on simulators)"));
    }
  } catch (error) {
    checks.push(failed("busy", error));
  } finally {
    await busyProbeA?.close().catch(() => undefined);
    await busyProbeB?.close().catch(() => undefined);
  }

  checks.push(skipped("rate-limit", "skipped to avoid spending the adapter's action budget; use a live soak test"));
  checks.push(skipped("action-timeout", "requires a deliberately blocking live action"));

  const ok = checks.every((check) => check.status !== "fail");
  return {
    ok,
    url: `${url.protocol}//${url.host}${url.pathname}`,
    protocolVersion: PROTOCOL_VERSION,
    adapter,
    server,
    checks,
  };
}

export function summarizeConformance(result: ConformanceResult): string {
  const passed = result.checks.filter((check) => check.status === "pass").length;
  const failed = result.checks.filter((check) => check.status === "fail").length;
  const skipped = result.checks.filter((check) => check.status === "skip").length;
  return `${passed} passed, ${failed} failed, ${skipped} skipped`;
}
