import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "./config.js";

export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): Config {
  let raw: unknown = {};
  if (path) {
    const absolute = resolve(path);
    if (!existsSync(absolute)) throw new Error(`config file not found: ${absolute}`);
    const text = readFileSync(absolute, "utf8");
    if (extname(absolute).toLowerCase() === ".json") raw = JSON.parse(text);
    else raw = parseYaml(text) ?? {};
  }
  const config = ConfigSchema.parse(raw);
  return applyEnv(config, env);
}

function applyEnv(config: Config, env: NodeJS.ProcessEnv): Config {
  const next: Config = structuredClone(config);
  if (env.MCBOT_ADAPTER_URL) next.adapter.url = env.MCBOT_ADAPTER_URL;
  if (env.MCBOT_USERNAME) next.bot.username = env.MCBOT_USERNAME;
  if (env.MCBOT_LOG_LEVEL) {
    const level = env.MCBOT_LOG_LEVEL;
    if (level === "debug" || level === "info" || level === "warn" || level === "error") next.logging.level = level;
  }
  if (env.MCBOT_STATE_DIR) next.persistence.dir = env.MCBOT_STATE_DIR;
  if (env.MCBOT_PLANNER_MODE === "qwen" || env.MCBOT_PLANNER_MODE === "deterministic") {
    next.planner.mode = env.MCBOT_PLANNER_MODE;
  }
  if (env.MCBOT_QWEN_BASE_URL) next.planner.qwen.baseUrl = env.MCBOT_QWEN_BASE_URL;
  if (env.MCBOT_QWEN_MODEL) next.planner.qwen.model = env.MCBOT_QWEN_MODEL;
  if (env.MCBOT_QWEN_API_KEY_ENV) next.planner.qwen.apiKeyEnv = env.MCBOT_QWEN_API_KEY_ENV;
  if (env.MCBOT_ALLOW_REMOTE_ADAPTER === "1" || env.MCBOT_ALLOW_REMOTE_ADAPTER === "true") {
    next.guardrails.allowRemoteAdapter = true;
  }
  if (env.MCBOT_SERVER_WHITELIST) {
    next.guardrails.serverWhitelist = env.MCBOT_SERVER_WHITELIST.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return next;
}
