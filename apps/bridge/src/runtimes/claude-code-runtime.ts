import { spawn, type ChildProcess } from "node:child_process";
import type {
  AgentRuntime,
  AgentRuntimeHandle,
  RuntimeEvent,
  RuntimeLaunchConfig,
} from "./types.js";
import { resolveRuntimeCommand } from "./command.js";

interface ClaudeStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
}

function describeToolUse(contentBlock: {
  name?: string;
  input?: Record<string, unknown>;
}): { label: string; detail: string } {
  const toolName = contentBlock.name || "tool";

  switch (toolName) {
    case "Read":
      return { label: "Reading file", detail: "" };
    case "Write":
      return { label: "Writing file", detail: "" };
    case "Edit":
      return { label: "Editing file", detail: "" };
    case "Bash":
      return { label: "Running command", detail: "" };
    case "Grep":
      return { label: "Searching", detail: "" };
    case "Glob":
      return { label: "Finding files", detail: "" };
    case "Agent":
      return { label: "Running agent", detail: "" };
    case "WebSearch":
      return { label: "Searching web", detail: "" };
    case "WebFetch":
      return { label: "Fetching URL", detail: "" };
    case "Skill":
      return { label: "Running skill", detail: "" };
    case "TodoWrite":
      return { label: "Updating tasks", detail: "" };
    default:
      return { label: `Running ${toolName}`, detail: "" };
  }
}

class ClaudeCodeHandle implements AgentRuntimeHandle {
  readonly runtimeId = "claude-code" as const;
  private currentSessionId: string | null;
  private stdoutBuffer = "";
  private pendingText = "";
  private finalOutput = "";
  private stopped = false;

  constructor(
    private readonly proc: ChildProcess,
    sessionId: string | null,
    private readonly displayName: string,
    private readonly onEvent: (event: RuntimeEvent) => void,
  ) {
    this.currentSessionId = sessionId;
    this.attachProcessListeners();
  }

  get sessionId() {
    return this.currentSessionId;
  }

  isRunning() {
    return !this.stopped && !this.proc.killed && this.proc.exitCode === null;
  }

  async send(message: string) {
    if (!this.isRunning() || !this.proc.stdin) {
      throw new Error("Claude Code process is not running");
    }
    this.pendingText = "";
    this.finalOutput = "";

    const payload = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: message }],
      },
      ...(this.currentSessionId
        ? { session_id: this.currentSessionId }
        : {}),
    });

    await new Promise<void>((resolve, reject) => {
      this.proc.stdin!.write(`${payload}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  stop() {
    this.stopped = true;
    if (!this.proc.killed) this.proc.kill();
  }

  private attachProcessListeners() {
    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString();
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) this.handleLine(line.trim());
      }
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (!message || /Reconnecting\.\.\.|Falling back from WebSockets/i.test(message)) {
        return;
      }
      console.error(`  [${this.displayName}] Claude stderr: ${message.substring(0, 240)}`);
    });

    this.proc.on("error", (error) => {
      if (!this.stopped) this.onEvent({ type: "turn-failed", message: error.message });
    });

    this.proc.on("close", (code) => {
      if (!this.stopped && code !== 0) {
        this.onEvent({
          type: "turn-failed",
          message: `Claude Code exited with code ${code}`,
        });
      }
    });
  }

  private flushText() {
    const text = this.pendingText.trim();
    if (text) this.finalOutput = text;
    this.pendingText = "";
  }

  private handleLine(line: string) {
    let event: ClaudeStreamEvent;
    try {
      event = JSON.parse(line) as ClaudeStreamEvent;
    } catch {
      return;
    }

    if (event.type === "system") {
      if (event.subtype === "init" && event.session_id) {
        this.currentSessionId = event.session_id;
        this.onEvent({ type: "session", sessionId: event.session_id });
      }
      if (event.subtype === "compacting") {
        this.flushText();
        this.onEvent({ type: "context-compacting" });
      }
      return;
    }

    if (event.type === "assistant") {
      for (const block of event.message?.content || []) {
        if (block.type === "thinking") {
          this.flushText();
          this.onEvent({
            type: "activity",
            activity: "thinking",
            label: "Thinking",
          });
        } else if (block.type === "text") {
          this.pendingText = block.text || "";
        } else if (block.type === "tool_use") {
          this.flushText();
          const { label, detail } = describeToolUse(block);
          this.onEvent({ type: "activity", activity: "working", label, detail });
        }
      }
      return;
    }

    if (event.type === "result") {
      this.flushText();
      if (event.result?.trim()) this.finalOutput = event.result.trim();
      if (event.session_id) {
        this.currentSessionId = event.session_id;
        this.onEvent({ type: "session", sessionId: event.session_id });
      }
      if (this.finalOutput) {
        this.onEvent({ type: "output", text: this.finalOutput });
      }
      this.onEvent({
        type: "turn-complete",
        ...(event.session_id ? { sessionId: event.session_id } : {}),
      });
    }
  }
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly id = "claude-code" as const;

  async start(
    config: RuntimeLaunchConfig,
    onEvent: (event: RuntimeEvent) => void,
  ) {
    const args = [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--append-system-prompt",
      config.systemPrompt,
      "--permission-mode",
      "bypassPermissions",
      "--model",
      config.model || "sonnet",
    ];
    if (config.sessionId) args.push("--resume", config.sessionId);

    const command = resolveRuntimeCommand("claude");
    console.log(
      `  [${config.displayName}] Starting Claude Code (${config.sessionId ? `resume: ${config.sessionId.substring(0, 8)}` : "new session"}) via ${command}`,
    );
    const proc = spawn(command, args, {
      cwd: config.workDir,
      env: config.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return new ClaudeCodeHandle(
      proc,
      config.sessionId,
      config.displayName,
      onEvent,
    );
  }
}
