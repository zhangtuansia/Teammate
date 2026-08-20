import { apiUrl } from "./api-url";

export interface ModelConnection {
  id: string;
  name: string;
  provider: "openai-codex" | "openai-compatible" | "anthropic-compatible";
  auth_type: "oauth" | "api-key";
  base_url: string | null;
  api_format: "openai-codex-responses" | "openai-completions" | "anthropic-messages";
  default_model: string;
  hasCredential: boolean;
}

export async function loadModelConnections() {
  const response = await fetch(apiUrl("/api/connections"));
  const result = (await response.json()) as {
    connections?: ModelConnection[];
    error?: string;
  };
  if (!response.ok) throw new Error(result.error || "Could not load model connections");
  return result.connections || [];
}
