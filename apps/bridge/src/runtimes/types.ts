import type { ChildProcess } from "node:child_process";

export type AgentRuntimeId = "claude-code" | "codex" | "pi";
export type RuntimeThinkingLevel = "low" | "medium" | "high";
export type RuntimeActivity = "idle" | "thinking" | "working" | "error";

export type RuntimeEvent =
  | { type: "session"; sessionId: string }
  | {
      type: "activity";
      activity: RuntimeActivity;
      label: string;
      detail?: string;
    }
  | { type: "output"; text: string }
  | { type: "context-compacting" }
  | { type: "turn-complete"; sessionId?: string }
  | { type: "turn-failed"; message: string };

/**
 * A connector as a runtime needs to see it.
 *
 * Two shapes rather than one with optional fields: a local server is a command
 * to spawn, a remote one is a URL to call, and nothing sensible has both. Making
 * that a union means a connector missing its URL cannot be constructed at all,
 * instead of reaching a runtime that then writes a config it cannot use.
 */
export type RuntimeMcpServer =
  | {
      transport: "stdio";
      name: string;
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      /** Streamable HTTP, and the SSE transport that predates it. */
      transport: "http" | "sse";
      name: string;
      url: string;
      headers?: Record<string, string>;
    };

export interface RuntimeLaunchConfig {
  agentId: string;
  displayName: string;
  workDir: string;
  systemPrompt: string;
  model: string;
  thinkingLevel: RuntimeThinkingLevel;
  sessionId: string | null;
  env: NodeJS.ProcessEnv;
  connection?: RuntimeConnectionConfig;
  mcpServers?: RuntimeMcpServer[];
}

export interface RuntimeConnectionConfig {
  id: string;
  name: string;
  provider: "openai-codex" | "openai-compatible" | "anthropic-compatible";
  baseUrl: string | null;
  apiFormat: "openai-codex-responses" | "openai-completions" | "anthropic-messages";
  defaultModel: string;
  models: RuntimeModelDefinition[];
  credential:
    | { type: "api_key"; key: string }
    | {
        type: "oauth";
        access: string;
        refresh: string;
        expires: number;
        accountId?: string;
      };
}

export interface RuntimeModelDefinition {
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

export interface AgentRuntimeHandle {
  readonly runtimeId: AgentRuntimeId;
  readonly sessionId: string | null;
  isRunning(): boolean;
  send(message: string): Promise<void>;
  stop(): void;
}

export interface AgentRuntime {
  readonly id: AgentRuntimeId;
  start(
    config: RuntimeLaunchConfig,
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<AgentRuntimeHandle>;
}

export interface SpawnedRuntimeHandle extends AgentRuntimeHandle {
  readonly child: ChildProcess | null;
}
