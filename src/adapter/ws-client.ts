import WebSocket from "ws";
import type { Config } from "../config.js";
import { assertActionAllowed, assertAdapterAllowed, assertServerAllowed } from "../guardrails.js";
import { Logger } from "../logging/logger.js";
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  actionTimeoutMs,
  type Action,
  type ActionResult,
  type AdapterInfo,
  type AdapterLimits,
  type ServerInfo,
  type Snapshot,
} from "../protocol/types.js";
import { sleep } from "../util/vec.js";
import { AdapterError, REQUIRED_CAPABILITIES, type GameAdapter } from "./types.js";

function rawByteLength(data: WebSocket.RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return Buffer.byteLength(data as Buffer);
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  kind: "hello" | "snapshot" | "execute" | "ping";
}

export class WsGameClient implements GameAdapter {
  info: AdapterInfo = { name: "unknown", version: "0.0.0", capabilities: [] };
  server?: ServerInfo;
  limits: AdapterLimits = { maxActionTimeoutMs: 60_000, maxMessageBytes: 4 * 1024 * 1024 };
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private requestCounter = 0;
  private closing = false;
  private readonly log: Logger;
  private readonly url: URL;

  constructor(
    private readonly config: Config,
    logger?: Logger,
  ) {
    this.url = assertAdapterAllowed(config);
    this.log = logger ?? new Logger({ level: config.logging.level, pretty: config.logging.pretty });
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.closing = false;
    const socket = new WebSocket(this.url, {
      handshakeTimeout: this.config.adapter.connectTimeoutMs,
      maxPayload: 8 * 1024 * 1024,
      perMessageDeflate: false,
    });
    this.ws = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new AdapterError(`adapter connect timed out after ${this.config.adapter.connectTimeoutMs}ms`, "CONNECT_TIMEOUT"));
      }, this.config.adapter.connectTimeoutMs);
      const onError = (error: Error) => {
        clearTimeout(timer);
        reject(new AdapterError(`adapter connection failed: ${error.message}`, "CONNECT_FAILED"));
      };
      socket.once("error", onError);
      socket.once("open", () => {
        clearTimeout(timer);
        socket.off("error", onError);
        resolve();
      });
    });
    socket.on("message", (data) => this.onMessage(data));
    socket.on("close", (code, reason) => this.onClose(code, reason.toString()));
    socket.on("error", (error) => this.log.warn("adapter socket error", { message: error.message }));
    await this.handshake();
    this.log.info("connected to game adapter", {
      adapter: this.info.name,
      version: this.info.version,
      server: this.server?.address,
    });
  }

  private async handshake(): Promise<void> {
    const ackPromise = new Promise<unknown>((resolve, reject) => {
      const requestId = this.nextRequestId();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new AdapterError("adapter handshake timed out", "HANDSHAKE_TIMEOUT"));
      }, this.config.adapter.connectTimeoutMs);
      this.pending.set(requestId, {
        kind: "hello",
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
    });
    this.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      client: { name: "all-purpose-mc-bot", version: "0.1.0" },
    });
    const ack = await ackPromise;
    if (!ack || typeof ack !== "object") throw new AdapterError("invalid handshake response", "HANDSHAKE_INVALID");
    const ackVersion = (ack as { protocolVersion?: unknown }).protocolVersion;
    if (typeof ackVersion !== "string" || ackVersion.split(".")[0] !== PROTOCOL_VERSION.split(".")[0]) {
      throw new AdapterError(`adapter selected an incompatible protocol ${String(ackVersion)}`, "PROTOCOL_MISMATCH");
    }
    assertServerAllowed(this.server, this.config);
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.info.capabilities.includes(cap)) {
        this.log.debug("adapter does not advertise capability", { capability: cap });
      }
    }
  }

  async snapshot(): Promise<Snapshot> {
    await this.ensureConnected();
    const requestId = this.nextRequestId();
    const timeout = this.config.adapter.requestTimeoutMs;
    return new Promise<Snapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new AdapterError("snapshot request timed out", "SNAPSHOT_TIMEOUT"));
      }, timeout);
      this.pending.set(requestId, {
        kind: "snapshot",
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as Snapshot);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      this.send({ type: "snapshot_request", requestId });
    });
  }

  async execute(action: Action, actionId: string, signal?: AbortSignal): Promise<ActionResult> {
    assertActionAllowed(action, this.config);
    await this.ensureConnected();
    if (signal?.aborted) throw new AdapterError("action aborted before send", "ABORTED", false);
    const requestId = this.nextRequestId();
    const timeout = Math.min(
      (actionTimeoutMs(action) ?? this.config.adapter.requestTimeoutMs) + 2_000,
      this.config.guardrails.maxActionTimeoutMs + 2_000,
      this.config.adapter.requestTimeoutMs + 5_000,
    );
    return new Promise<ActionResult>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(requestId);
        clearTimeout(timer);
        void this.sendCancel(actionId).catch(() => undefined);
        reject(new AdapterError("action aborted", "ABORTED", false));
      };
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        signal?.removeEventListener("abort", onAbort);
        void this.sendCancel(actionId).catch(() => undefined);
        resolve({
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          actionId,
          ok: false,
          code: "TIMEOUT",
          reason: `adapter did not answer within ${timeout}ms`,
          startedAt: Date.now() - timeout,
          endedAt: Date.now(),
          snapshotSeq: 0,
        });
      }, timeout);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(requestId, {
        kind: "execute",
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(value as ActionResult);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        timer,
      });
      this.send({ type: "execute", requestId, actionId, action });
    });
  }

  async cancel(actionId: string): Promise<void> {
    await this.sendCancel(actionId);
  }

  private async sendCancel(actionId: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const requestId = this.nextRequestId();
    this.send({ type: "cancel", requestId, targetActionId: actionId });
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const [id, pending] of this.pending) {
      pending.reject(new AdapterError("adapter closed", "CLOSED", false));
      this.pending.delete(id);
    }
    if (!this.ws) return;
    const socket = this.ws;
    this.ws = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 2_000);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.close(1000, "controller shutdown");
      });
    }
  }

  async reconnect(): Promise<void> {
    await this.close();
    let attempt = 0;
    let lastError: Error | undefined;
    while (attempt < this.config.adapter.reconnectAttempts) {
      attempt += 1;
      try {
        await this.connect();
        return;
      } catch (error) {
        lastError = error as Error;
        this.log.warn("adapter reconnect failed", { attempt, message: lastError.message });
        if (attempt < this.config.adapter.reconnectAttempts) {
          await sleep(this.config.adapter.reconnectDelayMs * attempt);
        }
      }
    }
    throw new AdapterError(`could not reconnect: ${lastError?.message ?? "unknown"}`, "RECONNECT_FAILED");
  }

  private async ensureConnected(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) await this.connect();
  }

  private send(message: unknown): void {
    const parsed = ClientMessageSchema.safeParse(message);
    if (!parsed.success) throw new AdapterError(`refusing to send invalid message: ${parsed.error.message}`, "INVALID_MESSAGE", false);
    const encoded = JSON.stringify(parsed.data);
    if (Buffer.byteLength(encoded) > this.limits.maxMessageBytes) {
      throw new AdapterError("outgoing message exceeds adapter limit", "MESSAGE_TOO_LARGE", false);
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new AdapterError("adapter is not connected", "NOT_CONNECTED");
    }
    this.ws.send(encoded);
  }

  private onMessage(data: WebSocket.RawData): void {
    const bytes = rawByteLength(data);
    if (bytes > this.limits.maxMessageBytes) {
      this.log.warn("dropping oversized adapter message", { bytes });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.log.warn("adapter sent invalid JSON");
      return;
    }
    const message = ServerMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.log.warn("adapter sent invalid protocol message", { issues: message.error.issues.slice(0, 3) });
      return;
    }
    const value = message.data;
    switch (value.type) {
      case "hello_ack": {
        this.info = value.adapter;
        this.limits = value.limits;
        this.server = value.server;
        for (const [id, pending] of this.pending) {
          if (pending.kind === "hello") {
            pending.resolve(value);
            this.pending.delete(id);
            break;
          }
        }
        this.log.debug("handshake accepted", { capabilities: value.adapter.capabilities });
        return;
      }
      case "snapshot": {
        const pending = this.pending.get(value.requestId);
        if (pending?.kind === "snapshot") {
          pending.resolve(value.snapshot);
          this.pending.delete(value.requestId);
        }
        return;
      }
      case "result": {
        const pending = this.pending.get(value.requestId);
        if (pending?.kind === "execute") {
          pending.resolve(value.result);
          this.pending.delete(value.requestId);
        }
        return;
      }
      case "event": {
        const event = value.event;
        if (event.level === "error") this.log.error(`adapter: ${event.message}`, event.data);
        else if (event.level === "warn") this.log.warn(`adapter: ${event.message}`, event.data);
        else this.log.debug(`adapter: ${event.message}`, event.data);
        return;
      }
      case "error": {
        if (value.requestId) {
          const pending = this.pending.get(value.requestId);
          if (pending) {
            pending.reject(new AdapterError(value.message, value.code, value.retryable));
            this.pending.delete(value.requestId);
          }
        } else {
          this.log.error(`adapter error: ${value.message}`, { code: value.code });
        }
        return;
      }
      case "pong": {
        for (const [id, pending] of this.pending) {
          if (pending.kind === "ping") {
            pending.resolve(value);
            this.pending.delete(id);
            break;
          }
        }
        return;
      }
    }
  }

  private onClose(code: number, reason: string): void {
    this.ws = null;
    for (const [id, pending] of this.pending) {
      pending.reject(new AdapterError(`adapter disconnected (${code} ${reason})`, "DISCONNECTED"));
      this.pending.delete(id);
    }
    if (!this.closing) this.log.warn("adapter connection closed", { code, reason });
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${this.requestCounter}-${Date.now().toString(36)}`;
  }
}
