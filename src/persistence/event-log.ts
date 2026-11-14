import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { redact } from "../util/redact.js";

export const EventRecordSchema = z
  .object({
    timestamp: z.number().int().min(0),
    runId: z.string().min(1).max(128),
    level: z.enum(["debug", "info", "warn", "error"]),
    event: z.string().min(1).max(128),
    phase: z.string().min(1).max(64).optional(),
    actionId: z.string().min(1).max(256).optional(),
    data: z.unknown().optional(),
  })
  .strict();
export type EventRecord = z.infer<typeof EventRecordSchema>;

/** Read and validate a JSONL evidence log. Blank lines are ignored. */
export function readEventLog(path: string): EventRecord[] {
  if (!existsSync(path)) throw new Error(`event log not found: ${path}`);
  const records: EventRecord[] = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new Error(`event log line ${index + 1} is not valid JSON: ${(error as Error).message}`);
    }
    const parsed = EventRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`event log line ${index + 1} is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }
    records.push(parsed.data as EventRecord);
  }
  return records;
}

/** Append-only JSONL evidence log, with one size-based rotation. */
export class EventLog {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly runId: string;

  constructor(directory: string, runId: string, maxBytes = 64 * 1024 * 1024) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "events.jsonl");
    this.maxBytes = maxBytes;
    this.runId = runId;
    if (!existsSync(this.file)) writeFileSync(this.file, "", "utf8");
  }

  get path(): string {
    return this.file;
  }

  append(record: Omit<EventRecord, "timestamp" | "runId"> & { timestamp?: number }): void {
    this.rotateIfNeeded();
    const entry: EventRecord = {
      timestamp: record.timestamp ?? Date.now(),
      runId: this.runId,
      level: record.level,
      event: record.event,
      ...(record.phase ? { phase: record.phase } : {}),
      ...(record.actionId ? { actionId: record.actionId } : {}),
      ...(record.data !== undefined ? { data: redact(record.data) } : {}),
    };
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private rotateIfNeeded(): void {
    try {
      if (statSync(this.file).size < this.maxBytes) return;
      const rotated = `${this.file}.1`;
      renameSync(this.file, rotated);
      writeFileSync(this.file, "", { encoding: "utf8", mode: 0o600 });
    } catch {
      // A missing file or a filesystem hiccup must not stop the run.
    }
  }
}

export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}
