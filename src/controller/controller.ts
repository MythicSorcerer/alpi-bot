import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import { assertActionAllowed, assertServerAllowed, killSwitchActive } from "../guardrails.js";
import { Logger } from "../logging/logger.js";
import type { Action, ActionResult, ItemStack, Snapshot, Vec3 } from "../protocol/types.js";
import { PROTOCOL_VERSION, actionTimeoutMs } from "../protocol/types.js";
import type { GameAdapter } from "../adapter/types.js";
import { AdapterError } from "../adapter/types.js";
import { EventLog } from "../persistence/event-log.js";
import {
  buildCheckpoint,
  checkpointPath,
  saveCheckpoint,
  type Checkpoint,
} from "../persistence/checkpoint.js";
import { verifyGear, gearLabel, type GearVerification } from "../gear/checklist.js";
import { countItem } from "../util/items.js";
import { distance, sleep } from "../util/vec.js";
import { ReflexLayer } from "./reflex.js";
import { emptyMetrics, loadRunState, saveRunState, type Ledger, type Metrics, type RunState } from "./state.js";
import { taskForGoal, dropJunk, type TaskContext, type TaskResult } from "./tasks.js";
import {
  DeterministicPlanner,
  deterministicGoal,
  goalFeasible,
  makePlanner,
  type PlanDecision,
  type Planner,
  type PlannerContext,
} from "../planner/planner.js";
import { writeFileAtomic } from "../persistence/event-log.js";

export class RunBudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunBudgetExceeded";
  }
}

export class KillSwitchActivated extends Error {
  constructor() {
    super("kill switch file exists; stopping safely");
    this.name = "KillSwitchActivated";
  }
}

export class TaskFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskFailed";
  }
}

export interface ControllerOptions {
  runId?: string;
  resume?: boolean;
  logger?: Logger;
  planner?: Planner;
  signal?: AbortSignal;
  /** Skip the planner entirely; useful for deterministic simulations. */
  deterministic?: boolean;
}

export interface RunSummary {
  runId: string;
  runName: string;
  resumed: boolean;
  ok: boolean;
  phase: string;
  reason?: string;
  /** Wall-clock start of the persisted run (kept across resumes). */
  startedAt: number;
  /** Wall-clock start of this controller invocation. */
  sessionStartedAt: number;
  endedAt: number;
  /** Duration of this invocation, excluding time spent stopped between resumes. */
  durationMs: number;
  /** Age of the persisted run including any downtime between invocations. */
  runAgeMs: number;
  metrics: Metrics;
  ledger: Ledger;
  gear: GearVerification;
  notes: string[];
  snapshot: Snapshot | null;
  checkpoint: string | null;
  report: string;
  eventLog: string;
  adapter: { name: string; version: string } | null;
  server: { address: string; version: string; software?: string } | null;
}

interface TaskProgress {
  [key: string]: unknown;
}

export class BotController {
  runId: string;
  private readonly config: Config;
  private readonly adapter: GameAdapter;
  private readonly log: Logger;
  private readonly planner: Planner;
  private readonly deterministic: boolean;
  private readonly eventLog: EventLog;
  private readonly reflex: ReflexLayer;
  private readonly abort = new AbortController();
  private readonly externalSignal?: AbortSignal;
  private readonly checkpointTarget: string;
  private readonly reportTarget: string;
  private startedAt: number;
  private readonly sessionStartedAt: number;
  private resumed = false;
  private state: RunState;
  private snapshotValue: Snapshot | null = null;
  private taskState: TaskProgress = {};
  private currentGoal: string | null = null;
  private consecutiveFailures = 0;
  private lastActionType: string | undefined;
  private actionCounter = 0;
  private actionTimes: number[] = [];
  private phaseAttempts = 0;
  private topUps = 0;
  private lastDecision: PlanDecision | null = null;
  private closed = false;

  constructor(config: Config, adapter: GameAdapter, options: ControllerOptions = {}) {
    this.config = config;
    this.adapter = adapter;
    this.log = options.logger ?? new Logger({ level: config.logging.level, pretty: config.logging.pretty });
    this.deterministic = options.deterministic ?? false;
    this.planner =
      options.planner ??
      (this.deterministic ? new DeterministicPlanner() : makePlanner(config, this.log));
    this.reflex = new ReflexLayer(config);
    this.externalSignal = options.signal;
    this.runId = options.runId ?? newRunId();
    this.startedAt = Date.now();
    this.sessionStartedAt = this.startedAt;

    const loaded = options.resume === false ? null : loadRunState(config.persistence.dir);
    if (loaded) {
      this.state = loaded;
      this.startedAt = loaded.startedAt;
      this.resumed = true;
      this.currentGoal = loaded.phase === "done" ? null : loaded.phase;
      this.taskState = (loaded.task as TaskProgress | null) ?? {};
      this.actionCounter = loaded.metrics.actionsAttempted;
      this.log.info("resuming controller state", {
        runId: loaded.runId,
        phase: loaded.phase,
        actions: loaded.metrics.actionsAttempted,
      });
      this.runId = loaded.runId;
    } else {
      this.state = {
        schemaVersion: 1,
        runId: this.runId,
        phase: "bootstrap",
        task: {},
        metrics: emptyMetrics(),
        ledger: { emeraldsEarned: 0, emeraldsSpent: 0, trades: 0, entries: [] },
        notes: [],
        settled: false,
        emeraldGoalOverride: null,
        startedAt: this.startedAt,
        updatedAt: Date.now(),
        checkpointsWritten: 0,
      };
      this.currentGoal = null;
    }

    this.eventLog = new EventLog(config.persistence.dir, this.runId, config.persistence.maxEventFileBytes);
    this.checkpointTarget = checkpointPath(config, this.runId);
    this.reportTarget = `${config.persistence.dir}/report.json`;
    if (this.externalSignal) {
      if (this.externalSignal.aborted) this.abort.abort();
      else this.externalSignal.addEventListener("abort", () => this.abort.abort(), { once: true });
    }
    this.logEvent("run.created", {
      resume: Boolean(loaded),
      dryRun: false,
      scenario: config.simulation.scenario,
    });
  }

  get snapshot(): Snapshot {
    if (!this.snapshotValue) throw new Error("controller has no snapshot yet");
    return this.snapshotValue;
  }

  get metrics(): Metrics {
    return this.state.metrics;
  }

  get ledger(): Ledger {
    return this.state.ledger;
  }

  async run(): Promise<RunSummary> {
    let reason: string | undefined;
    let ok = false;
    try {
      await this.connect();
      await this.refresh();
      this.log.info("controller started", {
        runId: this.runId,
        adapter: this.adapter.info.name,
        server: this.adapter.server?.address,
        mode: this.config.planner.mode,
      });

      while (true) {
        this.checkBudgets();
        await this.refresh();
        const verification = verifyGear(this.snapshot.bot, this.config.gear.checklist);
        if (verification.verified && this.snapshot.world.village?.valid && this.state.settled) {
          reason = "declared gear checkpoint verified";
          ok = true;
          break;
        }
        const goal = await this.selectGoal(verification);
        if (goal === "verify_checkpoint") {
          if (verification.verified) {
            reason = "declared gear checkpoint verified";
            ok = true;
            break;
          }
          this.log.warn("planner asked to verify incomplete gear; acquiring the remainder instead");
          await this.runGoal("acquire_gear");
          continue;
        }
        if (goal === "done") {
          reason = verification.verified ? "checkpoint complete" : "planner reached done without a verified checkpoint";
          ok = verification.verified;
          break;
        }
        const result = await this.runGoal(goal);
        if (result.status === "failed") {
          this.phaseAttempts += 1;
          this.log.warn("task failed", { goal, reason: result.reason, attempt: this.phaseAttempts });
          if (this.phaseAttempts >= 3) throw new TaskFailed(result.reason ?? `${goal} failed three times`);
          continue;
        }
        if (result.status === "retry") {
          this.state.metrics.retries += 1;
          if (result.need === "emeralds") {
            this.topUps += 1;
            if (this.topUps > 8) {
              throw new TaskFailed("emerald top-up limit reached; the economy cannot fund the checkpoint");
            }
            const current = countItem(this.snapshot.bot.inventory, "minecraft:emerald");
            this.state.emeraldGoalOverride = current + Math.max(16, result.amount ?? 64);
            this.currentGoal = null;
            this.log.info("funding a gear shortfall", {
              target: this.state.emeraldGoalOverride,
              reason: result.reason,
            });
            continue;
          }
          if (result.need === "xp") {
            this.topUps += 1;
            if (this.topUps > 8) throw new TaskFailed("XP top-up limit reached");
            const current = countItem(this.snapshot.bot.inventory, "minecraft:emerald");
            this.state.emeraldGoalOverride = current + Math.max(16, result.amount ?? 24);
            this.currentGoal = null;
            this.log.info("earning trade XP for enchanting", { reason: result.reason });
            continue;
          }
          this.phaseAttempts += 1;
          if (this.phaseAttempts >= 4) throw new TaskFailed(result.reason ?? `${goal} did not converge`);
          this.log.debug("task asked to retry", { goal, reason: result.reason });
          continue;
        }
        // done
        this.phaseAttempts = 0;
        this.handleGoalComplete(goal);
      }

      ok = ok && verifyGear((await this.refresh()).bot, this.config.gear.checklist).verified;
    } catch (error) {
      reason =
        error instanceof RunBudgetExceeded ||
        error instanceof TaskFailed ||
        error instanceof KillSwitchActivated ||
        error instanceof AdapterError
          ? error.message
          : (error as Error).message;
      if (this.abort.signal.aborted) reason = "run aborted by operator";
      this.log.error("controller stopping", { reason });
      await this.safeStop();
    }

    const finalSnapshot = this.snapshotValue;
    let verification = verifyGear(
      finalSnapshot?.bot ?? emptyBotSnapshot().bot,
      this.config.gear.checklist,
    );
    const finalOk = ok && verification.verified;
    this.state.phase = finalOk ? "done" : "stopped";
    this.persistState();
    let checkpoint: Checkpoint | null = null;
    try {
      if (finalSnapshot) {
        checkpoint = await this.writeCheckpoint(finalSnapshot);
        verification = verifyGear(finalSnapshot.bot, this.config.gear.checklist);
        this.log.info("checkpoint saved", { path: this.checkpointTarget, gear: gearLabel(verification) });
      }
    } catch (error) {
      this.log.error("could not write final checkpoint", { message: (error as Error).message });
    }
    const endedAt = Date.now();
    const summary: RunSummary = {
      runId: this.runId,
      runName: this.config.run.name,
      resumed: this.resumed,
      ok: finalOk,
      ...(reason ? { reason } : {}),
      phase: this.state.phase,
      startedAt: this.startedAt,
      sessionStartedAt: this.sessionStartedAt,
      endedAt,
      durationMs: endedAt - this.sessionStartedAt,
      runAgeMs: endedAt - this.startedAt,
      metrics: this.state.metrics,
      ledger: this.state.ledger,
      gear: verification,
      notes: [...this.state.notes],
      snapshot: finalSnapshot,
      checkpoint: checkpoint ? this.checkpointTarget : null,
      report: this.reportTarget,
      eventLog: this.eventLog.path,
      adapter: finalSnapshot ? { name: finalSnapshot.adapter.name, version: finalSnapshot.adapter.version } : null,
      server: this.adapter.server ?? null,
    };
    this.writeReport(summary);
    await this.close();
    return summary;
  }

  async stop(): Promise<void> {
    this.abort.abort();
  }

  private async connect(): Promise<void> {
    if (this.adapter.connect) await this.adapter.connect();
    assertServerAllowed(this.adapter.server, this.config);
    this.snapshotValue = null;
    this.logEvent("adapter.connected", {
      adapter: this.adapter.info,
      server: this.adapter.server,
    });
  }

  private async refresh(): Promise<Snapshot> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const snapshot = await this.adapter.snapshot();
        this.snapshotValue = snapshot;
        return snapshot;
      } catch (error) {
        if (error instanceof AdapterError && error.retryable && attempt === 0 && (this.adapter.reconnect || this.adapter.connect)) {
          this.log.warn("snapshot failed; reconnecting", { message: error.message });
          await this.recoverConnection();
          continue;
        }
        throw error;
      }
    }
    throw new AdapterError("could not read a snapshot", "SNAPSHOT_FAILED");
  }

  /** Prefer an adapter's bounded reconnect policy over a single direct connect. */
  private async recoverConnection(): Promise<void> {
    if (this.adapter.reconnect) {
      await this.adapter.reconnect();
    } else if (this.adapter.connect) {
      await this.adapter.connect();
    }
  }

  private async selectGoal(verification: GearVerification): Promise<string> {
    const emeralds = countItem(this.snapshot.bot.inventory, "minecraft:emerald");
    if (this.state.emeraldGoalOverride !== null) {
      if (emeralds >= this.state.emeraldGoalOverride) {
        this.state.emeraldGoalOverride = null;
      } else {
        return "earn_emeralds";
      }
    }
    const deterministic = deterministicGoal({
      phase: this.state.phase,
      snapshot: this.snapshot,
      gearVerified: verification.verified,
      missingGear: verification.missingItems,
      emeraldTarget: this.config.economy.emeraldTarget,
      settled: this.state.settled,
      notes: this.state.notes,
    }).goal;
    const context: PlannerContext = {
      phase: this.state.phase,
      snapshot: this.snapshot,
      gearVerified: verification.verified,
      missingGear: verification.missingItems,
      emeraldTarget: this.config.economy.emeraldTarget,
      settled: this.state.settled,
      notes: this.state.notes,
    };
    let decision: PlanDecision;
    try {
      decision = await this.planner.plan(context);
    } catch (error) {
      decision = {
        goal: deterministic,
        reason: `planner error: ${(error as Error).message}`,
        source: "deterministic",
        latencyMs: 0,
        tokens: 0,
        failed: true,
      };
    }
    this.lastDecision = decision;
    if (decision.source === "qwen" || decision.failed) {
      this.state.metrics.modelCalls += 1;
      this.state.metrics.modelLatencyMs += decision.latencyMs;
      this.state.metrics.modelTokens += decision.tokens;
      if (decision.failed) this.state.metrics.modelFailures += 1;
    }
    this.logEvent("plan.decision", {
      goal: decision.goal,
      source: decision.source,
      reason: decision.reason,
      latencyMs: decision.latencyMs,
    });
    if (!goalFeasible(decision.goal, context)) {
      this.log.warn("planner selected a goal that does not fit the current state; using deterministic policy", {
        goal: decision.goal,
        fallback: deterministic,
      });
      return deterministic;
    }
    return decision.goal;
  }

  private async runGoal(goal: string): Promise<TaskResult> {
    let target: number | undefined;
    if (goal === "earn_emeralds") {
      target = this.state.emeraldGoalOverride ?? this.config.economy.emeraldTarget;
    }
    const task = taskForGoal(goal, target);
    if (!task) return { status: "done", reason: `${goal} has no task` };
    if (this.currentGoal !== goal) {
      this.currentGoal = goal;
      this.taskState = {};
      this.phaseAttempts = 0;
    }
    this.state.phase = goal;
    this.state.task = this.taskState;
    this.logEvent("task.start", { goal, target });
    const context = this.createTaskContext();
    const result = await task.run(context);
    this.state.task = this.taskState;
    this.logEvent("task.result", { goal, status: result.status, reason: result.reason, need: result.need }, result.status === "failed" ? "warn" : "info");
    this.persistState();
    return result;
  }

  private handleGoalComplete(goal: string): void {
    if (goal === "settle") {
      this.state.settled = true;
      this.note("settlement complete");
    }
    if (goal === "earn_emeralds") {
      this.state.emeraldGoalOverride = null;
    }
    this.currentGoal = null;
    this.taskState = {};
    this.state.task = {};
    this.state.phase = "bootstrap";
    this.persistState();
  }

  private createTaskContext(): TaskContext {
    const controller = this;
    return {
      config: this.config,
      logger: this.log,
      state: this.taskState,
      get snapshot() {
        return controller.snapshot;
      },
      get ledger() {
        return controller.state.ledger;
      },
      get metrics() {
        return controller.state.metrics;
      },
      async act(action, options = {}) {
        return controller.act(action, options);
      },
      async refresh() {
        return controller.refresh();
      },
      note(text) {
        controller.note(text);
      },
      log(event, data, level = "info") {
        controller.logEvent(event, data, level);
      },
      recordTrade(result, villagerId, offerIndex) {
        controller.recordTrade(result, villagerId, offerIndex);
      },
      async freeSpace() {
        return dropJunk(controller.createTaskContext());
      },
    };
  }

  private async act(action: Action, options: { skipReflex?: boolean; timeoutMs?: number } = {}): Promise<ActionResult> {
    this.checkBudgets();
    if (this.abort.signal.aborted) throw new AdapterError("run aborted", "ABORTED", false);
    if (killSwitchActive(this.config)) throw new KillSwitchActivated();

    if (!options.skipReflex) {
      const decision = this.reflex.evaluate(this.snapshot, {
        consecutiveFailures: this.consecutiveFailures,
        lastActionType: this.lastActionType,
        settled: this.state.settled,
      });
      if (decision) {
        this.state.metrics.reflexActions += 1;
        this.logEvent("reflex.action", { action: decision.action.type, reason: decision.reason, priority: decision.priority });
        const reflexResult = await this.execute(decision.action, `reflex-${this.actionCounter + 1}`);
        if (reflexResult.ok) {
          this.consecutiveFailures = 0;
          this.lastActionType = decision.action.type;
        }
      }
    }
    const result = await this.execute(action, `${this.state.phase}-${this.actionCounter + 1}`);
    if (!result.ok) {
      this.consecutiveFailures += 1;
    } else {
      this.consecutiveFailures = 0;
    }
    this.lastActionType = action.type;
    await this.persistAfterAction(result, action);
    return result;
  }

  private async execute(action: Action, tag: string): Promise<ActionResult> {
    await this.throttle();
    assertActionAllowed(action, this.config);
    const actionId = `${tag}-${randomBytes(3).toString("hex")}`;
    this.actionCounter += 1;
    this.state.metrics.actionsAttempted += 1;
    const started = Date.now();
    let result: ActionResult;
    try {
      result = await this.adapter.execute(
        { ...action, timeoutMs: actionTimeoutMs(action) ?? Math.min(this.config.adapter.requestTimeoutMs, 30_000) } as Action,
        actionId,
        this.abort.signal,
      );
    } catch (error) {
      const adapterError = error as AdapterError;
      this.state.metrics.actionsFailed += 1;
      this.logEvent("action.error", { action: action.type, message: adapterError.message, code: adapterError.code }, "warn");
      if (adapterError.retryable && (this.adapter.reconnect || this.adapter.connect) && !this.abort.signal.aborted) {
        try {
          await this.recoverConnection();
          await this.refresh();
        } catch (reconnectError) {
          this.log.warn("reconnect failed", { message: (reconnectError as Error).message });
        }
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId: actionId,
        actionId,
        ok: false,
        code: "NOT_CONNECTED",
        reason: adapterError.message,
        startedAt: started,
        endedAt: Date.now(),
        snapshotSeq: this.snapshotValue?.seq ?? 0,
      };
    }
    if (result.ok) this.state.metrics.actionsSucceeded += 1;
    else this.state.metrics.actionsFailed += 1;
    if (result.code === "TIMEOUT") this.state.metrics.actionTimeouts += 1;
    this.updateMetricsFromResult(action, result);
    this.logEvent(
      "action.result",
      {
        action: action.type,
        actionId,
        ok: result.ok,
        code: result.code,
        reason: result.reason,
        durationMs: result.endedAt - result.startedAt,
      },
      result.ok ? "debug" : "warn",
    );
    try {
      await this.refresh();
    } catch (error) {
      this.log.warn("could not refresh after action", { message: (error as Error).message });
    }
    return result;
  }

  private updateMetricsFromResult(action: Action, result: ActionResult): void {
    const data = (result.data ?? {}) as Record<string, unknown>;
    if (typeof data.collected === "number") this.state.metrics.logsCollected += data.collected;
    if (typeof data.moved === "number") this.state.metrics.distanceMoved += data.moved;
    if (action.type === "apply_book" && result.ok) this.state.metrics.booksApplied += 1;
    if (result.code === "PLAYER_DEAD") this.state.metrics.deaths += 1;
    else if (result.events?.some((event) => event.type === "respawn")) this.state.metrics.deaths += 1;
  }

  private recordTrade(result: ActionResult, villagerId: string, offerIndex: number): void {
    const data = (result.data ?? {}) as {
      times?: number;
      spent?: ItemStack[];
      received?: ItemStack;
    };
    const times = data.times ?? 1;
    this.state.ledger.trades += times;
    this.state.metrics.trades += times;
    const now = Date.now();
    for (const spent of data.spent ?? []) {
      if (spent.item !== "minecraft:emerald") continue;
      this.state.ledger.emeraldsSpent += spent.count;
      this.state.metrics.emeraldsSpent += spent.count;
      this.state.ledger.entries.push({
        timestamp: now,
        kind: "spend",
        emeralds: spent.count,
        item: spent.item,
        count: spent.count,
        villagerId,
        tradeIndex: offerIndex,
      });
    }
    if (data.received?.item === "minecraft:emerald") {
      this.state.ledger.emeraldsEarned += data.received.count;
      this.state.metrics.emeraldsEarned += data.received.count;
      this.state.ledger.entries.push({
        timestamp: now,
        kind: "earn",
        emeralds: data.received.count,
        item: "minecraft:emerald",
        count: data.received.count,
        villagerId,
        tradeIndex: offerIndex,
      });
    }
    if (this.state.ledger.entries.length > 5_000) {
      this.state.ledger.entries = this.state.ledger.entries.slice(-5_000);
    }
  }

  private async persistAfterAction(_result: ActionResult, _action: Action): Promise<void> {
    this.persistState();
    if (this.actionCounter % this.config.run.checkpointEveryActions === 0) {
      if (this.snapshotValue) {
        try {
          await this.writeCheckpoint(this.snapshotValue);
        } catch (error) {
          this.log.warn("periodic checkpoint failed", { message: (error as Error).message });
        }
      }
    }
  }

  private async writeCheckpoint(snapshot: Snapshot): Promise<Checkpoint> {
    const checkpoint = buildCheckpoint({
      runId: this.runId,
      createdAt: this.startedAt,
      phase: this.state.phase,
      snapshot,
      checklist: this.config.gear.checklist,
      ledger: this.state.ledger,
      eventLog: this.eventLog.path,
      report: this.reportTarget,
      task: this.taskState,
      notes: this.state.notes.slice(-64),
      settled: this.state.settled,
      server: this.adapter.server ?? null,
    });
    saveCheckpoint(this.config, checkpoint, this.checkpointTarget);
    this.state.checkpointsWritten += 1;
    this.persistState();
    return checkpoint;
  }

  private persistState(): void {
    this.state.updatedAt = Date.now();
    this.state.metrics.deaths = Math.max(this.state.metrics.deaths, 0);
    saveRunState(this.config.persistence.dir, this.state);
  }

  private note(text: string): void {
    this.state.notes.push(text);
    if (this.state.notes.length > 256) this.state.notes = this.state.notes.slice(-256);
    this.log.info(text);
    this.logEvent("note", { text });
  }

  private logEvent(event: string, data?: unknown, level: "debug" | "info" | "warn" | "error" = "info"): void {
    if (!this.config.persistence.saveEvents) return;
    this.eventLog.append({
      level,
      event,
      phase: this.state.phase,
      ...(this.lastActionType ? { actionId: this.lastActionType } : {}),
      ...(data !== undefined ? { data } : {}),
    });
  }

  private async throttle(): Promise<void> {
    // Wall-clock throttling applies to live adapters. Deterministic simulation
    // runs virtual time as fast as possible, so its action rate is meaningless.
    if (this.deterministic) return;
    const limit = this.config.guardrails.maxActionsPerMinute;
    const windowMs = 60_000;
    for (;;) {
      if (this.abort.signal.aborted) throw new AdapterError("run aborted", "ABORTED", false);
      const now = Date.now();
      this.actionTimes = this.actionTimes.filter((time) => now - time < windowMs);
      if (this.actionTimes.length < limit) break;
      const waitMs = Math.max(50, windowMs - (now - this.actionTimes[0]!) + 10);
      this.log.debug("rate limiting actions", { limit, waitMs });
      await sleep(Math.min(waitMs, 1_000));
    }
    this.actionTimes.push(Date.now());
  }

  private checkBudgets(): void {
    if (this.abort.signal.aborted) throw new AdapterError("run aborted", "ABORTED", false);
    if (killSwitchActive(this.config)) throw new KillSwitchActivated();
    if (this.state.metrics.actionsAttempted >= this.config.run.maxActions) {
      throw new RunBudgetExceeded(`action budget ${this.config.run.maxActions} exhausted`);
    }
    // The time budget applies to this invocation. A run that sat stopped for
    // hours must not burn its whole budget before the first action on resume.
    if (Date.now() - this.sessionStartedAt >= this.config.run.maxMinutes * 60_000) {
      throw new RunBudgetExceeded(`time budget ${this.config.run.maxMinutes} minutes exhausted for this session`);
    }
  }

  private writeReport(summary: RunSummary): void {
    const report = {
      schemaVersion: 1,
      runId: summary.runId,
      runName: summary.runName,
      owner: this.config.bot.owner,
      resumed: summary.resumed,
      ok: summary.ok,
      phase: summary.phase,
      reason: summary.reason ?? null,
      startedAt: summary.startedAt,
      sessionStartedAt: summary.sessionStartedAt,
      endedAt: summary.endedAt,
      durationMs: summary.durationMs,
      runAgeMs: summary.runAgeMs,
      adapter: summary.adapter,
      server: summary.server,
      metrics: summary.metrics,
      ledger: {
        emeraldsEarned: summary.ledger.emeraldsEarned,
        emeraldsSpent: summary.ledger.emeraldsSpent,
        trades: summary.ledger.trades,
        entries: summary.ledger.entries.length,
      },
      gear: summary.gear,
      checklist: this.config.gear.checklist,
      notes: summary.notes,
      bot: summary.snapshot
        ? {
            position: summary.snapshot.bot.position,
            health: summary.snapshot.bot.health,
            food: summary.snapshot.bot.food,
            xpLevel: summary.snapshot.bot.xpLevel,
            inventorySlots: summary.snapshot.bot.inventory.length,
            emeralds: countItem(summary.snapshot.bot.inventory, "minecraft:emerald"),
          }
        : null,
      village: summary.snapshot?.world.village ?? null,
      evidence: {
        checkpoint: summary.checkpoint,
        eventLog: summary.eventLog,
        report: summary.report,
      },
      planner: {
        mode: this.config.planner.mode,
        lastDecision: this.lastDecision,
      },
      budget: {
        maxActions: this.config.run.maxActions,
        maxMinutes: this.config.run.maxMinutes,
      },
      environment: {
        node: process.version,
        protocol: PROTOCOL_VERSION,
      },
    };
    writeFileAtomic(this.reportTarget, `${JSON.stringify(report, null, 2)}\n`);
  }

  private async safeStop(): Promise<void> {
    if (this.closed) return;
    try {
      await this.adapter.execute(
        { type: "stop" },
        `safe-stop-${Date.now()}`,
        AbortSignal.timeout(5_000),
      );
    } catch (error) {
      this.log.warn("safe stop action failed", { message: (error as Error).message });
    }
    if (this.snapshotValue) {
      try {
        await this.writeCheckpoint(this.snapshotValue);
      } catch (error) {
        this.log.warn("could not save stop checkpoint", { message: (error as Error).message });
      }
    }
    this.persistState();
    await this.close();
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.adapter.close();
    } catch (error) {
      this.log.debug("adapter close failed", { message: (error as Error).message });
    }
  }
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `run-${stamp}-${randomBytes(2).toString("hex")}`;
}

function emptyBotSnapshot(): Snapshot {
  return {
    protocolVersion: PROTOCOL_VERSION,
    seq: 0,
    timestamp: Date.now(),
    adapter: { name: "none", version: "0.0.0" },
    bot: {
      username: "MCBot",
      gameMode: "survival",
      dimension: "minecraft:overworld",
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0,
      health: 0,
      maxHealth: 20,
      food: 0,
      saturation: 0,
      air: 300,
      maxAir: 300,
      xpLevel: 0,
      xpPoints: 0,
      onGround: true,
      inWater: false,
      isSleeping: false,
      selectedSlot: 0,
      inventory: [],
      armor: { head: null, chest: null, legs: null, feet: null, offhand: null },
      mainhand: null,
      currentScreen: null,
      effects: [],
      spawnPoint: null,
      path: { active: false, status: "idle" },
      action: null,
    },
    world: {
      timeOfDay: 0,
      day: 0,
      weather: "clear",
      difficulty: "normal",
      nearbyEntities: [],
      nearbyBlocks: [],
      villagers: [],
      village: null,
    },
  };
}

export { distance };
