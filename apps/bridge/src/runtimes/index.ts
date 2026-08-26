import { ClaudeCodeRuntime } from "./claude-code-runtime.js";
import { CodexRuntime } from "./codex-runtime.js";
import { PiRuntime } from "./pi-runtime.js";
import type { AgentRuntime, AgentRuntimeId } from "./types.js";

export type {
  AgentRuntime,
  AgentRuntimeHandle,
  AgentRuntimeId,
  RuntimeActivity,
  RuntimeEvent,
  RuntimeLaunchConfig,
  RuntimeConnectionConfig,
  RuntimeMcpServer,
  RuntimeThinkingLevel,
  RuntimeModelDefinition,
} from "./types.js";

export function normalizeRuntimeId(value: unknown): AgentRuntimeId {
  return value === "claude-code" || value === "pi" ? value : "codex";
}

export function createAgentRuntime(id: AgentRuntimeId): AgentRuntime {
  if (id === "codex") return new CodexRuntime();
  if (id === "pi") return new PiRuntime();
  return new ClaudeCodeRuntime();
}
