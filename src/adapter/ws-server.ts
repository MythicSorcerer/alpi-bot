import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { Logger } from "../logging/logger.js";
import { isLoopbackHost } from "../guardrails.js";
import {
  PROTOCOL_VERSION,
  ClientMessageSchema,
  SnapshotSchema,
  ServerMessageSchema,
  actionTimeoutMs,
  type Action,
  type ActionResult,
  type AdapterInfo,
  type AdapterEvent,
  type AdapterLimits,
  type ServerInfo,
  type Snapshot,
} from "../protocol/types.js";
import { AdapterError } from "./types.js";

export interface AdapterBackend {
  readonly info: AdapterInfo;
  readonly limits: AdapterLimits;
  readonly server?: ServerInfo;
  snapshot(): Promise<Snapshot> | Snapshot;
  execute(action: Action, actionId: string, signal: AbortSignal): Promise<ActionResult>;
  cancel?(actionId: string): void;
  close?(): Promise<void> | void;
}

export interface GameAdapterServerOptions {
  host?: string;
  port?: number;
  logger?: Logger;
}

interface ActiveAction {
  actionId: string;
  abort: AbortController;
  socket: WebSocket;
}

export class GameAdapterServer {
  private readonly backend: AdapterBackend;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly log: Logger;
  private wss: WebSocketServer | null = null;
  private http: Server | null = null;
  private clients = new Set<WebSocket>();
  private active: ActiveAction | null = null;
  private recentActions: number[] = [];
  private closing = false;

  constructor(backend: AdapterBackend, options: GameAdapterServerOptions = {}) {
    this.backend = backend;
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 0;
    this.log = options.logger ?? new Logger({ pretty: false });
    if (!isLoopbackHost(this.host)) {
      throw new AdapterError("game adapter may only bind to a loopback interface", "GUARDRAIL_BLOCKED", false);
    }
  }

  async listen(): Promise<{ host: string; port: number; url: string }> {
    if (this.wss) throw new Error("adapter server already listening");
    this.http = createServer((request, response) => {
      response.writeHead(426, { "content-type": "text/plain" });
      response.end(`upgrade required: connect with WebSocket to ws://${this.host}:${this.port}/adapter\n`);
    });
    this.wss = new WebSocketServer({
      server: this.http,
      maxPayload: this.backend.limits.maxMessageBytes,
      perMessageDeflate: false,
    });
    this.wss.on("connection", (socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.http!.once("error", onError);
      this.http!.listen(this.requestedPort, this.host, () => {
        this.http!.off("error", onError);
        resolve();
      });
    });
    const address = this.http.address();
    if (!address || typeof address === "string") throw new Error("adapter server did not get a TCP address");
    const url = `ws://${this.host}:${address.port}/adapter`;
    this.log.info("game adapter listening", { url, adapter: this.backend.info.name });
    return { host: this.host, port: address.port, url };
  }

  get port(): number {
    const address = this.http?.address();
    return address && typeof address !== "string" ? address.port : this.requestedPort;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.active?.abort.abort();
    this.active = null;
    for (const client of this.clients) client.close(1001, "adapter shutting down");
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
    });
    await this.backend.close?.();
    this.wss = null;
    this.http = null;
  }

  private onConnection(socket: WebSocket): void {
    let handshaken = false;
    this.clients.add(socket);
    this.log.debug("adapter client connected", { clients: this.clients.size });
    const handshakeTimer = setTimeout(() => {
      if (!handshaken) socket.close(1008, "handshake timeout");
    }, 5_000);

    socket.on("message", (data) => {
      void this.onMessage(
        socket,
        data.toString(),
        () => {
          handshaken = true;
          clearTimeout(handshakeTimer);
        },
        () => handshaken,
      );
    });
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      this.clients.delete(socket);
      if (this.active?.socket === socket) {
        this.active.abort.abort();
        this.active = null;
      }
    });
    socket.on("error", (error) => this.log.debug("adapter client error", { message: error.message }));
  }

  private async onMessage(
    socket: WebSocket,
    raw: string,
    markHandshake: () => void,
    isHandshaken: () => boolean,
  ): Promise<void> {
    if (Buffer.byteLength(raw) > this.backend.limits.maxMessageBytes) {
      this.sendError(socket, undefined, "MESSAGE_TOO_LARGE", "message exceeds adapter limit", false);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.sendError(socket, undefined, "INVALID_JSON", "message is not valid JSON", false);
      return;
    }
    const parsed = ClientMessageSchema.safeParse(value);
    if (!parsed.success) {
      this.sendError(socket, undefined, "INVALID_MESSAGE", parsed.error.issues[0]?.message ?? "invalid message", false);
      return;
    }
    const message = parsed.data;
    if (message.type !== "hello" && !isHandshaken()) {
      const requestId = "requestId" in message ? message.requestId : undefined;
      this.sendError(socket, requestId, "HANDSHAKE_REQUIRED", "send hello before any other message", false);
      return;
    }
    if (message.type === "hello" && isHandshaken()) {
      this.sendError(socket, undefined, "INVALID_MESSAGE", "hello has already completed for this connection", false);
      return;
    }
    switch (message.type) {
      case "hello": {
        const [controllerMajor] = message.protocolVersion.split(".");
        const [adapterMajor] = PROTOCOL_VERSION.split(".");
        if (controllerMajor !== adapterMajor) {
          this.sendError(
            socket,
            undefined,
            "PROTOCOL_MISMATCH",
            `controller speaks ${message.protocolVersion}, adapter speaks ${PROTOCOL_VERSION}`,
            false,
          );
          socket.close(1008, "protocol mismatch");
          return;
        }
        markHandshake();
        this.send(socket, {
          type: "hello_ack",
          protocolVersion: PROTOCOL_VERSION,
          adapter: this.backend.info,
          limits: this.backend.limits,
          ...(this.backend.server ? { server: this.backend.server } : {}),
          tickRate: 20,
        });
        return;
      }
      case "ping":
        this.send(socket, { type: "pong", nonce: message.nonce });
        return;
      case "snapshot_request": {
        try {
          const snapshot = SnapshotSchema.parse(await this.backend.snapshot());
          this.send(socket, { type: "snapshot", requestId: message.requestId, snapshot });
        } catch (error) {
          this.sendError(socket, message.requestId, "SNAPSHOT_FAILED", (error as Error).message, true);
        }
        return;
      }
      case "cancel": {
        if (this.active?.actionId === message.targetActionId && this.active.socket === socket) {
          this.active.abort.abort();
          this.backend.cancel?.(message.targetActionId);
        }
        this.send(socket, {
          type: "result",
          requestId: message.requestId,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            requestId: message.requestId,
            actionId: message.targetActionId,
            ok: true,
            code: "OK",
            reason: "cancel acknowledged",
            startedAt: Date.now(),
            endedAt: Date.now(),
            snapshotSeq: 0,
            data: { cancelled: true },
          },
        });
        return;
      }
      case "execute": {
        if (this.active) {
          this.sendError(socket, message.requestId, "BUSY", `action ${this.active.actionId} is still running`, true);
          return;
        }
        if (!this.rateLimitOk()) {
          this.sendError(socket, message.requestId, "RATE_LIMITED", "too many actions per minute", true);
          return;
        }
        const timeout = Math.min(
          actionTimeoutMs(message.action) ?? 30_000,
          this.backend.limits.maxActionTimeoutMs,
        );
        const abort = new AbortController();
        this.active = { actionId: message.actionId, abort, socket };
        try {
          const result = await this.withTimeout(
            this.backend.execute(message.action, message.actionId, abort.signal),
            timeout,
            message,
            abort,
          );
          this.send(socket, {
            type: "result",
            requestId: message.requestId,
            result: { ...result, requestId: message.requestId },
          });
        } catch (error) {
          const code = abort.signal.aborted ? "CANCELLED" : "INTERNAL_ERROR";
          this.send(socket, {
            type: "result",
            requestId: message.requestId,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              requestId: message.requestId,
              actionId: message.actionId,
              ok: false,
              code,
              reason: (error as Error).message,
              startedAt: Date.now(),
              endedAt: Date.now(),
              snapshotSeq: 0,
            },
          });
        } finally {
          if (this.active?.actionId === message.actionId && this.active.socket === socket) this.active = null;
        }
        return;
      }
    }
  }

  private async withTimeout(
    promise: Promise<ActionResult>,
    timeoutMs: number,
    message: { requestId: string; actionId: string },
    abort: AbortController,
  ): Promise<ActionResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ActionResult>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve({
          protocolVersion: PROTOCOL_VERSION,
          requestId: message.requestId,
          actionId: message.actionId,
          ok: false,
          code: "TIMEOUT",
          reason: `action exceeded ${timeoutMs}ms`,
          startedAt: Date.now() - timeoutMs,
          endedAt: Date.now(),
          snapshotSeq: 0,
        });
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private rateLimitOk(): boolean {
    const limit = this.backend.limits.maxActionsPerMinute;
    if (!limit) return true;
    const now = Date.now();
    this.recentActions = this.recentActions.filter((time) => now - time < 60_000);
    if (this.recentActions.length >= limit) return false;
    this.recentActions.push(now);
    return true;
  }

  private send(socket: WebSocket, message: unknown): void {
    const parsed = ServerMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.log.error("refusing to send invalid server message", { issues: parsed.error.issues.slice(0, 3) });
      return;
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(parsed.data));
  }

  private sendError(
    socket: WebSocket,
    requestId: string | undefined,
    code: string,
    message: string,
    retryable: boolean,
  ): void {
    this.send(socket, { type: "error", ...(requestId ? { requestId } : {}), code, message, retryable });
  }

  broadcastEvent(event: AdapterEvent): void {
    for (const client of this.clients) {
      this.send(client, { type: "event", event });
    }
  }

  get isClosing(): boolean {
    return this.closing;
  }
}
