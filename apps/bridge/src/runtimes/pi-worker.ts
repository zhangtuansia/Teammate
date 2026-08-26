import { createHash, randomUUID } from "node:crypto";
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
  | { type: "steer"; id: string; message: string }
  | { type: "shutdown" };

interface StoredSession {
  id: string;
  messages: AgentMessage[];
  /** Identifies the instructions this transcript was produced under. */
  promptFingerprint?: string;
}

let agent: Agent | null = null;
let config: WorkerConfig | null = null;
let sessionFile = "";
let sessionId = "";
let turnFailureSent = false;
let turnActive = false;
let continuationPending = false;
/** Stamped into the transcript so a later start can tell whether it was
 * produced under the instructions now in force. */
let activePromptFingerprint = "";

// Model output arrives as token-level deltas — often in sub-second bursts — and
// every activity event is persisted to the local event log. Deltas only feed a
// buffer; a per-turn ticker rebroadcasts the accumulated tail once per second,
// so bursts and steady streams alike surface without flooding the log.
const STREAM_ACTIVITY_INTERVAL_MS = 1_000;
type StreamKind = "text" | "toolcall";
let streamActivity: "thinking" | "working" = "thinking";
let streamLabel = "";
let streamKind: StreamKind = "text";
let streamBuffer = "";
let streamDirty = false;
let streamTimer: ReturnType<typeof setInterval> | null = null;
/** Set once the agent has spoken in the channel this turn. Whatever the model
 * writes afterwards is closing narration that never becomes a message, so it
 * must not reappear as a second "thinking" phase after the reply lands. */
let repliedThisTurn = false;
/** Tool calls that are the agent speaking, so their completion can retire the
 * activity indicator the moment the message lands rather than leaving it up
 * through the model's wrap-up. */
const replyToolCalls = new Set<string>();

/** Tool arguments stream as raw JSON. Surface the command being typed rather
 * than the `{"command":"…` envelope around it. */
function readableStreamDetail(buffer: string, kind: StreamKind) {
  if (kind !== "toolcall") return buffer;
  const command = buffer.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)/);
  return (command ? command[1] : buffer)
    .replace(/\\[nrt]/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function flushStreamActivity() {
  if (!streamDirty) return;
  streamDirty = false;
  const detail = readableStreamDetail(streamBuffer, streamKind)
    .replace(/\s+/g, " ")
    .trim()
    .slice(-200);
  if (!detail) return;
  sendEvent({ type: "activity", activity: streamActivity, label: streamLabel, detail });
}

function resetStreamActivity() {
  streamLabel = "";
  streamBuffer = "";
  streamDirty = false;
}

function startStreamActivity() {
  resetStreamActivity();
  if (streamTimer) clearInterval(streamTimer);
  streamTimer = setInterval(flushStreamActivity, STREAM_ACTIVITY_INTERVAL_MS);
  streamTimer.unref?.();
}

function stopStreamActivity() {
  if (streamTimer) clearInterval(streamTimer);
  streamTimer = null;
  resetStreamActivity();
}

function pushStreamDelta(
  activity: "thinking" | "working",
  label: string,
  delta: string,
  kind: StreamKind = "text",
) {
  if (label !== streamLabel) {
    streamActivity = activity;
    streamLabel = label;
    streamKind = kind;
    streamBuffer = "";
  }
  streamBuffer += delta;
  streamDirty = true;
}

function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendEvent(event: RuntimeEvent) {
  send({ type: "event", event });
}

// Custom connections are added with a bare model id and no reasoning flag, which
// silently disables thinking. Recognize the widely used reasoning families so
// their thinking stream is requested by default; an explicit flag still wins.
function inferReasoningModel(id: string) {
  return /(?:claude-(?:[a-z]+-)?[45]|gpt-5|o[134](?:-mini|-pro)?$|deepseek-r|qwq|grok-[34]|gemini-[23][.-]|-thinking)/i.test(id);
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
    reasoning: definition.reasoning ?? inferReasoningModel(id),
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
    JSON.stringify({ id: sessionId, messages: agent.state.messages, promptFingerprint: activePromptFingerprint }),
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
        const shell =
          [process.env.SHELL, "/bin/bash", "/bin/zsh"].find(
            (candidate) => candidate && existsSync(candidate),
          ) ?? "/bin/sh";
        const child = spawn(shell, ["-lc", parameters.command], {
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
      startStreamActivity();
      repliedThisTurn = false;
      replyToolCalls.clear();
      sendEvent({ type: "activity", activity: "thinking", label: "Thinking" });
      break;
    case "message_update":
      if (event.assistantMessageEvent.type === "thinking_delta") {
        if (!repliedThisTurn) {
          pushStreamDelta("thinking", "Thinking", event.assistantMessageEvent.delta);
        }
      } else if (event.assistantMessageEvent.type === "text_delta") {
        if (!repliedThisTurn) {
          pushStreamDelta("thinking", "Preparing response", event.assistantMessageEvent.delta);
        }
      } else if (event.assistantMessageEvent.type === "toolcall_delta") {
        // Replies travel as CLI tool calls, so the streaming reply text lives
        // in the accumulating command arguments.
        pushStreamDelta(
          "working",
          "Working",
          event.assistantMessageEvent.delta,
          "toolcall",
        );
      }
      break;
    case "tool_execution_start": {
      // Providers often deliver the whole tool call in a sub-second burst, so
      // surface whatever streamed before the ticker could catch it.
      flushStreamActivity();
      resetStreamActivity();
      const command = typeof event.args?.command === "string" ? event.args.command : "";
      if (/\bteammate\s+message\s+send\b/.test(command)) {
        repliedThisTurn = true;
        replyToolCalls.add(event.toolCallId);
      }
      sendEvent({
        type: "activity",
        activity: "working",
        label: "Working",
        detail: event.toolName,
      });
      break;
    }
    case "tool_execution_end":
      // The message is in the channel now. Whatever the model writes next is
      // closing narration nobody sees, so stop implying it is still talking;
      // genuine follow-up work lights the indicator again on its own.
      if (replyToolCalls.delete(event.toolCallId)) {
        resetStreamActivity();
        sendEvent({ type: "activity", activity: "idle", label: "Idle" });
      }
      break;
    case "agent_end":
      stopStreamActivity();
      persistSession();
      if (agent?.state.errorMessage) {
        turnFailureSent = true;
        sendEvent({ type: "turn-failed", message: agent.state.errorMessage });
      } else if (agent?.hasQueuedMessages()) {
        // A steered follow-up raced the end of the run. Hold the terminal
        // events; the prompt handler continues the same logical turn.
        continuationPending = true;
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
  // A transcript is a record of decisions made under the instructions that
  // were live at the time, and the model imitates it far more readily than it
  // re-reads the system prompt. Carrying one across a prompt change means the
  // old rules keep being applied by example, so a changed prompt starts fresh.
  activePromptFingerprint = createHash("sha256")
    .update(config.systemPrompt)
    .digest("hex")
    .slice(0, 16);
  const carriedOver = stored?.promptFingerprint === activePromptFingerprint ? stored : null;
  if (stored && !carriedOver) {
    console.error("  [pi] System prompt changed — starting a fresh session.");
  }
  sessionId = carriedOver?.id || randomUUID();
  const selectedModel = modelForConnection(config.connection, config.model);
  agent = new Agent({
    sessionId,
    initialState: {
      systemPrompt: config.systemPrompt,
      model: selectedModel,
      thinkingLevel: selectedModel.reasoning ? config.thinkingLevel : "off",
      tools: [createBashTool(config.workDir)],
      messages: carriedOver?.messages || [],
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
  if (message.type === "steer") {
    const accepted = turnActive && agent !== null;
    if (accepted) {
      agent!.steer({
        role: "user",
        content: [{ type: "text", text: message.message }],
        timestamp: Date.now(),
      });
    }
    send({ type: "steer-result", id: message.id, accepted });
    return;
  }
  if (!agent || !config) throw new Error("Pi worker is not initialized");
  agent.state.systemPrompt = config.systemPrompt;
  turnFailureSent = false;
  continuationPending = false;
  turnActive = true;
  try {
    await agent.prompt(message.message);
    // A steer accepted in the final moments of the run stays queued; continue
    // the same logical turn until the queue is dry.
    while (continuationPending || agent.hasQueuedMessages()) {
      continuationPending = false;
      await agent.continue();
    }
    send({ type: "prompt-result", id: message.id });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Pi prompt failed";
    if (!turnFailureSent) sendEvent({ type: "turn-failed", message: detail });
    send({ type: "prompt-result", id: message.id, error: detail });
  } finally {
    turnActive = false;
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
