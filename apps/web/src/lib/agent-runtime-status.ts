import { apiUrl } from "./api-url";
import { isAgentRuntime, type AgentRuntimeId } from "./agent-runtime";

export interface AgentRuntimeStatus {
  id: AgentRuntimeId;
  name: string;
  defaultModel: string;
  executable: string | null;
  installed: boolean;
}

export async function loadAgentRuntimes(signal?: AbortSignal) {
  const response = await fetch(apiUrl("/api/runtimes"), { signal });
  const result = (await response.json()) as {
    runtimes?: AgentRuntimeStatus[];
    error?: string;
  };
  if (!response.ok) throw new Error(result.error || "Could not load agent runtimes");
  return (result.runtimes || []).filter((runtime) => isAgentRuntime(runtime.id));
}

export function installedAgentRuntimeIds(
  runtimes: readonly AgentRuntimeStatus[],
): AgentRuntimeId[] {
  return runtimes.filter((runtime) => runtime.installed).map((runtime) => runtime.id);
}
