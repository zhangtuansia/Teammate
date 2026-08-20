import type { ChildProcess } from "node:child_process";

export type AgentRuntimeId = "claude-code" | "codex" | "pi";
export type RuntimeActivity = "idle" | "thinking" | "working" | "error";

export type RuntimeEvent =
  | { type: "session"; sessionId: string }
  | {
      type: "activity";
      activity: RuntimeActivity;
      label: string;
      detail?: string;
    }
  | { type: "context-compacting" }
  | { type: "turn-complete"; sessionId?: string }
  | { type: "turn-failed"; message: string };

export interface RuntimeLaunchConfig {
  agentId: string;
  displayName: string;
  workDir: string;
  systemPrompt: string;
  model: string;
  sessionId: string | null;
  env: NodeJS.ProcessEnv;
  connection?: RuntimeConnectionConfig;
}

export interface RuntimeConnectionConfig {
  id: string;
  name: string;
  provider: "openai-codex" | "openai-compatible" | "anthropic-compatible";
  baseUrl: string | null;
  apiFormat: "openai-codex-responses" | "openai-completions" | "anthropic-messages";
  defaultModel: string;
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
