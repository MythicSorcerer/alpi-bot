import { redact } from "../util/redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  sink?: (line: string) => void;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly pretty: boolean;
  private readonly sink: (line: string) => void;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.pretty = options.pretty ?? true;
    this.sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
  }

  child(_context: Record<string, unknown>): Logger {
    return this;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write("debug", message, context);
  }
  info(message: string, context?: Record<string, unknown>): void {
    this.write("info", message, context);
  }
  warn(message: string, context?: Record<string, unknown>): void {
    this.write("warn", message, context);
  }
  error(message: string, context?: Record<string, unknown>): void {
    this.write("error", message, context);
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const timestamp = new Date().toISOString();
    if (this.pretty) {
      const suffix = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(redact(context))}` : "";
      this.sink(`${timestamp} ${level.toUpperCase().padEnd(5)} ${message}${suffix}`);
    } else {
      this.sink(JSON.stringify({ timestamp, level, message, ...((redact(context ?? {}) as object) ?? {}) }));
    }
  }
}

export const silentLogger = new Logger({ level: "error", sink: () => undefined });
