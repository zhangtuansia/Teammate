import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@mariozechner/pi-agent-core";
import {
  streamSimple,
  type Api,
  type Model,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type {
  RuntimeConnectionConfig,
  RuntimeEvent,
  RuntimeThinkingLevel,
} from "./types.js";


interface WorkerConfig {
  workDir: string;
  systemPrompt: string;
  model: string;
  thinkingLevel: RuntimeThinkingLevel;
  connection: RuntimeConnectionConfig;
}

type IncomingMessage =
  | { type: "init"; config: WorkerConfig }
  | { type: "prompt"; id: string; message: string }
  | { type: "shutdown" };

interface StoredSession {
  id: string;
  messages: AgentMessage[];
}

let agent: Agent | null = null;
let config: WorkerConfig | null = null;
let sessionFile = "";
let sessionId = "";
let turnFailureSent = false;

function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendEvent(event: RuntimeEvent) {
  send({ type: "event", event });
}

function modelForConnection(
  connection: RuntimeConnectionConfig,
  requested: string,
): Model<Api> {
  const id = requested === "default" ? connection.defaultModel : requested;
  const definition = connection.models.find((model) => model.id === id);
  if (!definition) {
    throw new Error("The selected model is no longer available for this connection");
  }
  const input = definition.input?.length
    ? definition.input
    : definition.supportsImages
      ? ["text", "image"] as const
      : ["text"] as const;
  return {
    id,
    name: definition.name || id,
    api: connection.apiFormat,
    provider: connection.provider === "openai-codex"
      ? "openai-codex"
      : `teammate-${connection.id}`,
    baseUrl: connection.provider === "openai-codex"
      ? "https://chatgpt.com/backend-api"
      : connection.baseUrl || "",
    reasoning: definition.reasoning === true,
    input: [...input],
    cost: {
      input: definition.cost?.input ?? 0,
      output: definition.cost?.output ?? 0,
      cacheRead: definition.cost?.cacheRead ?? 0,
      cacheWrite: definition.cost?.cacheWrite ?? 0,
    },
    contextWindow: definition.contextWindow && definition.contextWindow > 0
      ? definition.contextWindow
      : 32_000,
    maxTokens: definition.maxTokens && definition.maxTokens > 0
      ? definition.maxTokens
      : 4_096,
  };
}

function streamForConnection(connection: RuntimeConnectionConfig): StreamFn {
  const apiKey = connection.credential.type === "oauth"
    ? connection.credential.access
    : connection.credential.key;
  return (model, context, options) => streamSimple(
    model,
    context,
    { ...options, apiKey },
  );
}

function readStoredSession(path: string): StoredSession | null {
  if (!existsSync(path)) return null;
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as StoredSession;
    return stored.id && Array.isArray(stored.messages) ? stored : null;
  } catch {
    return null;
  }
}

function persistSession() {
  if (!agent || !sessionFile) return;
  const temporary = `${sessionFile}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({ id: sessionId, messages: agent.state.messages }),
    { mode: 0o600 },
  );
  renameSync(temporary, sessionFile);
}

const BashParameters = Type.Object({
  command: Type.String({ description: "Shell command to run" }),
});

function createBashTool(workDir: string): AgentTool<typeof BashParameters, { exitCode: number | null }> {
  return {
    name: "bash",
    label: "Shell",
    description: "Run a shell command in the agent workspace. Use the teammate CLI to send messages.",
    parameters: BashParameters,
    async execute(_toolCallId, parameters, signal) {
      return new Promise((resolve, reject) => {
        const child = spawn("/bin/zsh", ["-lc", parameters.command], {
          cwd: workDir,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        const append = (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.length > 200_000) output = output.slice(-200_000);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const abort = () => child.kill("SIGTERM");
        signal?.addEventListener("abort", abort, { once: true });
        child.on("error", reject);
        child.on("close", (exitCode) => {
          signal?.removeEventListener("abort", abort);
          resolve({
            content: [{ type: "text", text: output || `(exit ${exitCode ?? "unknown"})` }],
            details: { exitCode },
          });
        });
      });
    },
  };
}

function latestAssistantText(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function handleAgentEvent(event: AgentEvent) {
  switch (event.type) {
    case "agent_start":
      sendEvent({ type: "activity", activity: "thinking", label: "Thinking" });
      break;
    case "tool_execution_start":
      sendEvent({
        type: "activity",
        activity: "working",
        label: "Working",
        detail: event.toolName,
      });
      break;
    case "agent_end":
      persistSession();
      if (agent?.state.errorMessage) {
        turnFailureSent = true;
        sendEvent({ type: "turn-failed", message: agent.state.errorMessage });
      } else {
        const output = latestAssistantText(event.messages);
        if (output) sendEvent({ type: "output", text: output });
        sendEvent({ type: "turn-complete", sessionId });
      }
      break;
  }
}

async function initialize(nextConfig: WorkerConfig) {
  config = nextConfig;
  const sessionDir = join(config.workDir, ".teammate-pi-sessions");
  mkdirSync(sessionDir, { recursive: true });
  sessionFile = join(sessionDir, "session.json");
  const stored = readStoredSession(sessionFile);
  sessionId = stored?.id || randomUUID();
  const selectedModel = modelForConnection(config.connection, config.model);
  agent = new Agent({
    sessionId,
    initialState: {
      systemPrompt: config.systemPrompt,
      model: selectedModel,
      thinkingLevel: selectedModel.reasoning ? config.thinkingLevel : "off",
      tools: [createBashTool(config.workDir)],
      messages: stored?.messages || [],
    },
    streamFn: streamForConnection(config.connection),
    toolExecution: "sequential",
  });
  agent.subscribe(handleAgentEvent);
  send({ type: "ready", sessionId });
}

async function handle(message: IncomingMessage) {
  if (message.type === "init") {
    await initialize(message.config);
    return;
  }
  if (message.type === "shutdown") process.exit(0);
  if (!agent || !config) throw new Error("Pi worker is not initialized");
  agent.state.systemPrompt = config.systemPrompt;
  turnFailureSent = false;
  try {
    await agent.prompt(message.message);
    send({ type: "prompt-result", id: message.id });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Pi prompt failed";
    if (!turnFailureSent) sendEvent({ type: "turn-failed", message: detail });
    send({ type: "prompt-result", id: message.id, error: detail });
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  try {
    const message = JSON.parse(line) as IncomingMessage;
    void handle(message).catch((error) => {
      send({ type: "fatal", error: error instanceof Error ? error.message : "Pi worker failed" });
    });
  } catch (error) {
    send({ type: "fatal", error: error instanceof Error ? error.message : "Invalid Pi worker input" });
  }
});
