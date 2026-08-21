export type AgentRuntimeId = "claude-code" | "codex" | "pi";

export const AGENT_RUNTIME_IDS: AgentRuntimeId[] = ["claude-code", "codex", "pi"];

export const CODEX_MODEL_ITEMS = [
  { value: "default", label: "Automatic (recommended)" },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
] as const;

export interface RuntimeModelConnection {
  id: string;
  provider: "openai-codex" | "openai-compatible" | "anthropic-compatible";
  default_model: string;
  models: readonly { id: string }[];
  hasCredential: boolean;
  status?: "connected" | "needs-auth" | "error";
}

export type RuntimeSelectionIssue =
  | "unsupported-runtime"
  | "runtime-unavailable"
  | "unsupported-model"
  | "connection-required"
  | "connection-unavailable"
  | "model-catalog-unavailable";

export interface AgentRuntimeSelection {
  runtime: AgentRuntimeId;
  model: string;
  connectionId: string | null;
}

export interface ResolvedAgentRuntimeSelection {
  selection: AgentRuntimeSelection;
  issue: RuntimeSelectionIssue | null;
  models: readonly string[];
}

export function isAgentRuntime(value: unknown): value is AgentRuntimeId {
  return AGENT_RUNTIME_IDS.includes(value as AgentRuntimeId);
}

export function normalizeAgentRuntime(value: unknown): AgentRuntimeId {
  return value === "claude-code" || value === "pi" ? value : "codex";
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
  if (runtime === "codex") {
    return CODEX_MODEL_ITEMS.some((item) => item.value === model);
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

function uniqueModels(models: readonly string[]) {
  return Array.from(new Set(models.filter((model) =>
    isValidAgentModel("pi", model),
  )));
}

/**
 * Canonical runtime/connection/model resolver used by agent forms and APIs.
 * Passing `model: undefined` intentionally selects the connection/runtime default,
 * which keeps runtime and connection changes atomic.
 */
export function resolveAgentRuntimeSelection(
  input: {
    runtime: unknown;
    model?: unknown;
    connectionId?: unknown;
  },
  connections: readonly RuntimeModelConnection[] = [],
  installedRuntimes?: readonly AgentRuntimeId[],
): ResolvedAgentRuntimeSelection {
  const runtime = normalizeAgentRuntime(input.runtime);
  if (!isAgentRuntime(input.runtime)) {
    return {
      selection: {
        runtime,
        model: defaultModelForRuntime(runtime),
        connectionId: null,
      },
      issue: "unsupported-runtime",
      models: [],
    };
  }

  if (installedRuntimes && !installedRuntimes.includes(runtime)) {
    return {
      selection: {
        runtime,
        model: defaultModelForRuntime(runtime),
        connectionId: null,
      },
      issue: "runtime-unavailable",
      models: [],
    };
  }

  if (runtime !== "pi") {
    const fallback = defaultModelForRuntime(runtime);
    const valid = input.model === undefined || isValidAgentModel(runtime, input.model);
    return {
      selection: {
        runtime,
        model: valid && input.model !== undefined ? String(input.model).trim() : fallback,
        connectionId: null,
      },
      issue: valid ? null : "unsupported-model",
      models: runtime === "codex"
        ? CODEX_MODEL_ITEMS.map((item) => item.value)
        : ["opus", "sonnet", "haiku"],
    };
  }

  const requestedConnectionId = typeof input.connectionId === "string"
    ? input.connectionId
    : "";
  const connection = connections.find((entry) => entry.id === requestedConnectionId);
  if (!requestedConnectionId) {
    return {
      selection: { runtime, model: "default", connectionId: null },
      issue: "connection-required",
      models: [],
    };
  }
  if (!connection || !connection.hasCredential || connection.status !== "connected") {
    return {
      selection: { runtime, model: "default", connectionId: requestedConnectionId },
      issue: "connection-unavailable",
      models: [],
    };
  }

  const models = uniqueModels(connection.models.map((model) => model.id));
  if (models.length === 0) {
    return {
      selection: { runtime, model: "default", connectionId: connection.id },
      issue: "model-catalog-unavailable",
      models,
    };
  }
  const defaultModel = models.includes(connection.default_model)
    ? connection.default_model
    : models[0];
  const requestedModel = input.model === undefined
    ? defaultModel
    : typeof input.model === "string"
      ? input.model.trim()
      : "";
  const valid = models.includes(requestedModel);
  return {
    selection: {
      runtime,
      model: valid ? requestedModel : defaultModel,
      connectionId: connection.id,
    },
    issue: valid ? null : "unsupported-model",
    models,
  };
}

export function runtimeSelectionIssueMessage(
  issue: RuntimeSelectionIssue | null,
  language: "zh-CN" | "en-US",
) {
  if (!issue) return "";
  const zh = language === "zh-CN";
  if (issue === "connection-required") {
    return zh ? "请先选择一个已连接的模型供应商。" : "Choose a connected model provider first.";
  }
  if (issue === "runtime-unavailable") {
    return zh
      ? "这个智能体运行时未安装，无法保存。请选择标记为可用的模型连接。"
      : "This agent runtime is not installed. Choose an available model connection before saving.";
  }
  if (issue === "connection-unavailable") {
    return zh ? "这个模型连接不可用，请重新连接或选择其他连接。" : "This model connection is unavailable. Reconnect it or choose another connection.";
  }
  if (issue === "model-catalog-unavailable") {
    return zh ? "这个连接还没有可用模型，请先在“设置 → 模型与连接”中刷新模型。" : "This connection has no available models yet. Refresh it in Settings → Models & connections.";
  }
  if (issue === "unsupported-model") {
    return zh ? "当前模型已过期或不受这个连接支持。请选择“自动（推荐）”或连接提供的模型后再保存。" : "This model is outdated or unsupported by the selected connection. Choose Automatic (recommended) or a model offered by the connection before saving.";
  }
  return zh ? "当前模型配置不受支持，请重新选择模型连接。" : "This model configuration is unsupported. Choose the model connection again.";
}
