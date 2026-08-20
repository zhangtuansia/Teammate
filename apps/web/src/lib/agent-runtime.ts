export type AgentRuntimeId = "claude-code" | "codex" | "pi";

export const AGENT_RUNTIME_IDS: AgentRuntimeId[] = ["claude-code", "codex", "pi"];

export const CODEX_MODEL_ITEMS = [
  { value: "default", label: "Codex default" },
  { value: "gpt-5.6", label: "GPT-5.6" },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
] as const;

export function isAgentRuntime(value: unknown): value is AgentRuntimeId {
  return AGENT_RUNTIME_IDS.includes(value as AgentRuntimeId);
}

export function normalizeAgentRuntime(value: unknown): AgentRuntimeId {
  return value === "codex" || value === "pi" ? value : "claude-code";
}

export function defaultModelForRuntime(runtime: AgentRuntimeId) {
  return runtime === "claude-code" ? "sonnet" : "default";
}

export function isValidAgentModel(runtime: AgentRuntimeId, value: unknown) {
  if (typeof value !== "string") return false;
  const model = value.trim();
  if (runtime === "claude-code") {
    return ["opus", "sonnet", "haiku"].includes(model);
  }
  return (
    model === "default" ||
    (model.length > 0 &&
      model.length <= 120 &&
      /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model))
  );
}

export function normalizeAgentModel(runtime: AgentRuntimeId, value: unknown) {
  return isValidAgentModel(runtime, value)
    ? String(value).trim()
    : defaultModelForRuntime(runtime);
}
