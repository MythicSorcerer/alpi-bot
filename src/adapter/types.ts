import type { Action, ActionResult, AdapterInfo, AdapterLimits, Capability, ServerInfo, Snapshot } from "../protocol/types.js";

export const REQUIRED_CAPABILITIES: Capability[] = [
  "navigate",
  "collect",
  "mine",
  "place",
  "craft",
  "eat",
  "sleep",
  "inspect_trades",
  "trade",
  "reroll_trades",
  "breed",
  "equip",
  "attack",
  "flee",
  "apply_book",
  "drop",
  "surface",
  "wait",
  "stop",
];

/**
 * The controller only ever talks to the game through this narrow interface.
 * `WsGameClient` implements it over the loopback protocol; the simulator
 * implements it in-process for fast tests.
 */
export interface GameAdapter {
  readonly info: AdapterInfo;
  readonly server?: ServerInfo;
  readonly limits: AdapterLimits;
  connect?(): Promise<void>;
  /** Optional bounded reconnect policy used after a retryable failure. */
  reconnect?(): Promise<void>;
  snapshot(): Promise<Snapshot> | Snapshot;
  execute(action: Action, actionId: string, signal?: AbortSignal): Promise<ActionResult>;
  cancel?(actionId: string): Promise<void>;
  close(): Promise<void>;
}

export class AdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code = "ADAPTER_ERROR", retryable = true) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function actionFailure(
  requestId: string,
  actionId: string,
  code: ActionResult["code"],
  reason: string,
  extra: Partial<ActionResult> = {},
): ActionResult {
  const now = Date.now();
  return {
    protocolVersion: "1.0.0",
    requestId,
    actionId,
    ok: false,
    code,
    reason,
    startedAt: now,
    endedAt: now,
    snapshotSeq: 0,
    ...extra,
  };
}
