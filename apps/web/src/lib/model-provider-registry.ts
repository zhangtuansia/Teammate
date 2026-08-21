import type { ModelConnection, ModelProviderDescriptor } from "./model-connections";
import type { AgentRuntimeStatus } from "./agent-runtime-status";

export const BUILTIN_MODEL_PROVIDERS: readonly ModelProviderDescriptor[] = [
  {
    id: "openai-codex",
    name: "ChatGPT Plus / Pro",
    kind: "managed-oauth",
    authTypes: ["oauth"],
    modelCatalog: "sdk",
  },
  {
    id: "openai-compatible",
    name: "OpenAI compatible",
    kind: "compatible-api",
    authTypes: ["api-key"],
    modelCatalog: "user-defined",
  },
  {
    id: "anthropic-compatible",
    name: "Anthropic compatible",
    kind: "compatible-api",
    authTypes: ["api-key"],
    modelCatalog: "user-defined",
  },
] as const;

export function agentProviderItems(
  connections: readonly ModelConnection[],
  runtimes?: readonly AgentRuntimeStatus[] | null,
  language: "zh-CN" | "en-US" = "en-US",
) {
  const runtimeStatusPending = runtimes === null;
  const embeddedRuntimeUnavailable = runtimes !== undefined && !runtimes?.some(
    (runtime) => runtime.id === "pi" && runtime.installed,
  );
  const runtimeItem = (
    id: "codex" | "claude-code",
    fallbackLabel: string,
  ) => {
    const status = runtimes?.find((runtime) => runtime.id === id);
    const disabled = runtimes !== undefined && status?.installed !== true;
    const unavailableLabel = runtimeStatusPending
      ? language === "zh-CN" ? "正在检查" : "Checking"
      : language === "zh-CN" ? "未安装" : "Not installed";
    return {
      value: `runtime:${id}`,
      label: disabled
        ? `${status?.name || fallbackLabel} · ${unavailableLabel}`
        : status?.name || fallbackLabel,
      disabled,
    };
  };
  return [
    runtimeItem("codex", "Codex CLI"),
    runtimeItem("claude-code", "Claude Code CLI"),
    ...connections
      .map((connection) => {
        const ready = connection.hasCredential &&
          connection.status === "connected" &&
          connection.models.length > 0;
        const disabled = embeddedRuntimeUnavailable || !ready;
        const unavailableLabel = embeddedRuntimeUnavailable
          ? runtimeStatusPending
            ? language === "zh-CN" ? "正在检查运行时" : "Checking runtime"
            : language === "zh-CN" ? "运行时不可用" : "Runtime unavailable"
          : language === "zh-CN" ? "需要重新连接" : "Reconnect required";
        return {
          value: `connection:${connection.id}`,
          label: disabled ? `${connection.name} · ${unavailableLabel}` : connection.name,
          disabled,
        };
      }),
  ];
}

export function providerDescriptor(provider: ModelConnection["provider"]) {
  return BUILTIN_MODEL_PROVIDERS.find((descriptor) => descriptor.id === provider);
}
