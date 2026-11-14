import type { Config } from "../config.js";
import type { Logger } from "../logging/logger.js";
import type { Snapshot } from "../protocol/types.js";
import { countItem } from "../util/items.js";

export const GOALS = ["explore_village", "settle", "earn_emeralds", "acquire_gear", "verify_checkpoint", "done"] as const;
export type Goal = (typeof GOALS)[number];

export interface PlannerContext {
  phase: string;
  snapshot: Snapshot;
  gearVerified: boolean;
  missingGear: string[];
  emeraldTarget: number;
  settled: boolean;
  notes: string[];
}

export interface PlanDecision {
  goal: Goal;
  reason: string;
  source: "deterministic" | "qwen";
  latencyMs: number;
  tokens: number;
  failed: boolean;
}

export interface Planner {
  plan(context: PlannerContext): Promise<PlanDecision>;
}

export function deterministicGoal(context: PlannerContext): { goal: Goal; reason: string } {
  if (!context.snapshot.world.village) {
    return { goal: "explore_village", reason: "no village has been observed yet" };
  }
  if (!context.settled) {
    return { goal: "settle", reason: "village found but spawn/bed is not established" };
  }
  if (context.gearVerified) {
    return { goal: "verify_checkpoint", reason: "all declared gear requirements are present" };
  }
  const emeralds = countItem(context.snapshot.bot.inventory, "minecraft:emerald");
  const inventoryValue = emeralds + estimateGearBudget(context);
  if (emeralds < Math.min(context.emeraldTarget, Math.max(24, inventoryValue))) {
    return { goal: "earn_emeralds", reason: `holding ${emeralds} emeralds; the trade budget is not funded yet` };
  }
  return { goal: "acquire_gear", reason: "emerald budget is available; acquire and enchant the checkpoint gear" };
}

/**
 * Guard a model-selected goal against the observed state. A local model can
 * hallucinate a phase that has already passed; the deterministic policy is
 * always a valid fallback.
 */
export function goalFeasible(goal: Goal, context: PlannerContext): boolean {
  const hasVillage = Boolean(context.snapshot.world.village);
  switch (goal) {
    case "explore_village":
      return !hasVillage;
    case "settle":
      return hasVillage && !context.settled;
    case "earn_emeralds":
      return hasVillage && !context.gearVerified;
    case "acquire_gear":
      return hasVillage && context.settled && !context.gearVerified;
    case "verify_checkpoint":
    case "done":
      return context.gearVerified;
  }
}

function estimateGearBudget(context: PlannerContext): number {
  if (context.missingGear.length === 0) return 0;
  return context.missingGear.length * 18 + 40;
}

export class DeterministicPlanner implements Planner {
  async plan(context: PlannerContext): Promise<PlanDecision> {
    const decision = deterministicGoal(context);
    return { ...decision, source: "deterministic", latencyMs: 0, tokens: 0, failed: false };
  }
}

interface QwenResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
}

/**
 * Optional local-Qwen planner over an OpenAI-compatible endpoint. The model
 * only picks one of the bounded goals below; it never emits an action, code or
 * chat command. Timeouts and invalid output fall back to the deterministic
 * policy, so a model outage cannot stall survival reactions.
 */
export class QwenPlanner implements Planner {
  private readonly fallback = new DeterministicPlanner();
  private failureStreak = 0;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async plan(context: PlannerContext): Promise<PlanDecision> {
    if (this.failureStreak >= 3) {
      const decision = await this.fallback.plan(context);
      return { ...decision, reason: `model disabled after repeated failures; ${decision.reason}` };
    }
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.planner.qwen.timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const apiKey = process.env[this.config.planner.qwen.apiKeyEnv];
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const recommendation = deterministicGoal(context);
      const response = await this.fetchImpl(`${this.config.planner.qwen.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.planner.qwen.model,
          temperature: this.config.planner.qwen.temperature,
          max_tokens: this.config.planner.qwen.maxTokens,
          messages: [
            {
              role: "system",
              content:
                "You are the strategic planner for a Minecraft survival bot. Choose exactly one bounded goal from the allowed list. " +
                "You cannot execute actions or write code. Reply with JSON only: {\"goal\":\"<goal>\",\"reason\":\"<short reason>\"}. " +
                `Allowed goals: ${GOALS.join(", ")}.`,
            },
            { role: "user", content: summarize(context, recommendation.goal) },
          ],
        }),
      });
      if (!response.ok) throw new Error(`model HTTP ${response.status}`);
      const body = (await response.json()) as QwenResponse;
      const content = body.choices?.[0]?.message?.content ?? "";
      const parsed = parseDecision(content);
      if (!parsed) throw new Error("model did not return a valid goal decision");
      const latencyMs = Date.now() - started;
      this.failureStreak = 0;
      this.log.info("model selected goal", { goal: parsed.goal, latencyMs, reason: parsed.reason });
      return {
        ...parsed,
        source: "qwen",
        latencyMs,
        tokens: body.usage?.total_tokens ?? 0,
        failed: false,
      };
    } catch (error) {
      this.failureStreak += 1;
      const latencyMs = Date.now() - started;
      this.log.warn("model planner failed; using deterministic policy", {
        message: (error as Error).message,
        failures: this.failureStreak,
      });
      const decision = await this.fallback.plan(context);
      return {
        ...decision,
        reason: `model unavailable (${(error as Error).message}); ${decision.reason}`,
        latencyMs,
        failed: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function makePlanner(config: Config, logger: Logger): Planner {
  if (config.planner.mode === "qwen") return new QwenPlanner(config, logger);
  return new DeterministicPlanner();
}

function summarize(context: PlannerContext, recommendation: Goal): string {
  const { bot, world } = context.snapshot;
  return JSON.stringify({
    currentPhase: context.phase,
    position: bot.position,
    health: bot.health,
    food: bot.food,
    xpLevel: bot.xpLevel,
    emeralds: countItem(bot.inventory, "minecraft:emerald"),
    emeraldTarget: context.emeraldTarget,
    village: world.village
      ? { population: world.village.population, beds: world.village.beds, valid: world.village.valid }
      : null,
    settled: context.settled,
    gearVerified: context.gearVerified,
    missingGear: context.missingGear,
    timeOfDay: world.timeOfDay,
    hostiles: world.nearbyEntities.filter((entity) => entity.kind === "hostile").length,
    deterministicRecommendation: recommendation,
    notes: context.notes.slice(-8),
  });
}

export function parseDecision(content: string): { goal: Goal; reason: string } | null {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const goal = (parsed as { goal?: unknown }).goal;
  const reason = (parsed as { reason?: unknown }).reason;
  if (typeof goal !== "string" || !GOALS.includes(goal as Goal)) return null;
  if (typeof reason !== "string" || reason.length === 0 || reason.length > 500) return null;
  return { goal: goal as Goal, reason };
}
