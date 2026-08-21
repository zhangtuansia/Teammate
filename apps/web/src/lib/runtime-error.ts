export type RuntimeErrorKind =
  | "unsupported-model"
  | "authentication"
  | "rate-limit"
  | "network"
  | "unknown";

export interface ParsedRuntimeError {
  kind: RuntimeErrorKind;
  detail: string;
}

const ERROR_KEYS = ["message", "detail", "error", "reason", "body"] as const;

function extractErrorText(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 20_000) {
      try {
        const nested = extractErrorText(JSON.parse(trimmed) as unknown, depth + 1);
        if (nested) return nested;
      } catch {
        // A human-readable error may happen to start with a brace.
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const detail = extractErrorText(entry, depth + 1);
      if (detail) return detail;
    }
    return "";
  }
  if (typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  for (const key of ERROR_KEYS) {
    const detail = extractErrorText(record[key], depth + 1);
    if (detail) return detail;
  }
  return "";
}

export function parseRuntimeError(value: unknown): ParsedRuntimeError {
  const extracted = extractErrorText(value)
    .replace(/^error:\s*/i, "")
    .replace(/\n\s*at\s[\s\S]+$/, "")
    .trim();
  const lower = extracted.toLowerCase();

  if (
    /unsupported|not supported|unknown model|model.+(?:not found|unavailable|invalid)/i.test(extracted)
  ) {
    return { kind: "unsupported-model", detail: "" };
  }
  if (/unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication|oauth|token.+expired/i.test(lower)) {
    return { kind: "authentication", detail: "" };
  }
  if (/rate.?limit|too many requests|quota/i.test(lower)) {
    return { kind: "rate-limit", detail: "" };
  }
  if (/network|fetch failed|econn|timed?\s*out|socket|dns/i.test(lower)) {
    return { kind: "network", detail: "" };
  }

  return {
    kind: "unknown",
    detail: extracted && !/^\s*[\[{]/.test(extracted)
      ? extracted.slice(0, 500)
      : "",
  };
}
