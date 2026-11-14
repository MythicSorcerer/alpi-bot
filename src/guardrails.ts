import type { Config } from "./config.js";
import { ActionSchema, actionTimeoutMs, type Action, type ServerInfo } from "./protocol/types.js";
import { DEFAULT_ACTION_TIMEOUT_MS } from "./protocol/types.js";
import { existsSync } from "node:fs";

export class GuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardrailError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

export function parseHostPort(address: string): { host: string; port: number | null } {
  const trimmed = address.trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    const host = trimmed.slice(1, close);
    const rest = trimmed.slice(close + 1);
    const port = rest.startsWith(":") ? Number(rest.slice(1)) : null;
    return { host, port: Number.isFinite(port) ? port : null };
  }
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > -1 && !trimmed.slice(lastColon + 1).includes(":")) {
    const port = Number(trimmed.slice(lastColon + 1));
    if (Number.isFinite(port)) return { host: trimmed.slice(0, lastColon), port };
  }
  return { host: trimmed, port: null };
}

export function assertAdapterAllowed(config: Config): URL {
  let url: URL;
  try {
    url = new URL(config.adapter.url);
  } catch {
    throw new GuardrailError(`invalid adapter URL: ${config.adapter.url}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new GuardrailError("adapter URL must use ws:// or wss://");
  }
  if (!isLoopbackHost(url.hostname) && !config.guardrails.allowRemoteAdapter) {
    throw new GuardrailError(
      `adapter ${url.host} is not loopback; set guardrails.allowRemoteAdapter=true only for a trusted host`,
    );
  }
  return url;
}

export function isServerWhitelisted(server: ServerInfo, config: Config): boolean {
  if (!config.guardrails.requireServerWhitelist) return true;
  const target = parseHostPort(server.address);
  const targetHost = target.host.toLowerCase();
  const targetPort = target.port;
  for (const entry of config.guardrails.serverWhitelist) {
    const allowed = parseHostPort(entry);
    const allowedHost = allowed.host.toLowerCase();
    const hostMatches = allowedHost.startsWith("*.")
      ? targetHost.endsWith(allowedHost.slice(1)) || targetHost === allowedHost.slice(2)
      : allowedHost === targetHost;
    if (!hostMatches) continue;
    if (allowed.port === null) return true;
    if (targetPort === allowed.port) return true;
  }
  return false;
}

export function assertServerAllowed(server: ServerInfo | undefined, config: Config): void {
  if (!config.guardrails.requireServerWhitelist) return;
  if (!server) {
    throw new GuardrailError("adapter did not report a server address; server whitelist cannot be verified");
  }
  if (!isServerWhitelisted(server, config)) {
    throw new GuardrailError(
      `server ${server.address} is not in guardrails.serverWhitelist; refusing to control the bot`,
    );
  }
}

/** Validate an action against the controller's hard policy before it reaches the adapter. */
export function assertActionAllowed(action: Action, config: Config): void {
  const timeout = actionTimeoutMs(action) ?? DEFAULT_ACTION_TIMEOUT_MS;
  if (timeout > config.guardrails.maxActionTimeoutMs) {
    throw new GuardrailError(
      `action timeout ${timeout}ms exceeds guardrails.maxActionTimeoutMs=${config.guardrails.maxActionTimeoutMs}`,
    );
  }
  if (config.guardrails.allowExploits) {
    throw new GuardrailError("allowExploits must stay false: this project never uses cheat/exploit modules");
  }
  if (config.guardrails.allowChat) {
    throw new GuardrailError("allowChat must stay false: the adapter protocol has no chat action");
  }
  switch (action.type) {
    case "collect":
      if (action.count > 512) throw new GuardrailError("collect count exceeds the 512 item bound");
      if (action.radius !== undefined && action.radius > 128) throw new GuardrailError("collect radius exceeds 128");
      break;
    case "craft":
      if (action.count > 1024) throw new GuardrailError("craft count exceeds the 1024 bound");
      break;
    case "trade":
      if ((action.times ?? 1) > 64) throw new GuardrailError("trade batch exceeds 64");
      break;
    case "wait":
      if (action.durationMs > 300_000) throw new GuardrailError("wait exceeds five minutes");
      break;
    default:
      break;
  }
}

export function killSwitchActive(config: Config): boolean {
  return existsSync(config.guardrails.killSwitchFile);
}
