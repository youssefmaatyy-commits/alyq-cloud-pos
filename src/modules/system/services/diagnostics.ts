const SECRET_KEY = /(token|authorization|cookie|password|passcode|pin|secret|service.?role|private.?key|credential)/i;
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/** Recursive support-export boundary. Unknown secret-shaped fields are removed. */
export function redactDiagnosticValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    return value
      .replace(JWT, "[redacted-token]")
      .replace(/(bearer|token|password|cookie|pin|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
      .slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactDiagnosticValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, entry]) => [
      name,
      redactDiagnosticValue(entry, name),
    ]));
  }
  return value;
}

export function safeDiagnosticsJson(value: Record<string, unknown>): string {
  return JSON.stringify(redactDiagnosticValue(value), null, 2);
}
