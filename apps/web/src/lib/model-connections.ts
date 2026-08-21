import { apiUrl } from "./api-url";

export interface ConnectionModelDefinition {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<"text" | "image">;
  supportsImages?: boolean;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface ModelConnection {
  id: string;
  name: string;
  provider: "openai-codex" | "openai-compatible" | "anthropic-compatible";
  auth_type: "oauth" | "api-key";
  base_url: string | null;
  api_format: "openai-codex-responses" | "openai-completions" | "anthropic-messages";
  default_model: string;
  /** Provider-owned capability catalog. Agent forms must not invent models outside it. */
  models: ConnectionModelDefinition[];
  model_selection_mode: "automatically-synced" | "user-defined";
  models_refreshed_at: string | null;
  status: "connected" | "needs-auth" | "error";
  auth_error: string | null;
  hasCredential: boolean;
}

export interface ModelProviderDescriptor {
  id: ModelConnection["provider"];
  name: string;
  kind: "managed-oauth" | "compatible-api";
  authTypes: Array<ModelConnection["auth_type"]>;
  modelCatalog: "sdk" | "user-defined";
}

export async function loadModelConnections(signal?: AbortSignal) {
  return (await loadModelConnectionCatalog(signal)).connections;
}

export async function loadModelConnectionCatalog(signal?: AbortSignal) {
  const response = await fetch(apiUrl("/api/connections"), { signal });
  const result = (await response.json()) as {
    connections?: ModelConnection[];
    providers?: ModelProviderDescriptor[];
    error?: string;
  };
  if (!response.ok) throw new Error(result.error || "Could not load model connections");
  return {
    connections: result.connections || [],
    providers: result.providers || [],
  };
}
