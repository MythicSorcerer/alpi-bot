const SECRET_KEY = /token|secret|password|authorization|api[-_]?key|cookie/i;
const SECRET_VALUE = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

/** Redact secrets from log/event payloads. Never log account tokens or API keys. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[max-depth]";
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE, "$1[REDACTED]").replace(/(sk-)[A-Za-z0-9_-]{8,}/g, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(entry, depth + 1);
    }
    return result;
  }
  return value;
}

export function redactString(value: string): string {
  return String(redact(value));
}
