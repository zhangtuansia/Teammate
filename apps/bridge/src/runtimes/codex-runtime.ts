import { spawn, type ChildProcess } from "node:child_process";
import type {
  AgentRuntime,
  AgentRuntimeHandle,
  RuntimeEvent,
  RuntimeLaunchConfig,
} from "./types.js";
import { resolveRuntimeCommand } from "./command.js";

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  error?: { message?: string } | string;
  item?: {
    type?: string;
    text?: string;
    command?: string;
    name?: string;
    query?: string;
    changes?: unknown[];
  };
}

function describeCodexItem(item: CodexJsonEvent["item"]) {
  if (!item) return null;
  switch (item.type) {
    case "reasoning":
      return { activity: "thinking" as const, label: "Thinking", detail: item.text || "" };
    case "agent_message":
      return { activity: "thinking" as const, label: "Preparing response", detail: "" };
    case "command_execution":
      return { activity: "working" as const, label: "Running command", detail: item.command || "" };
    case "file_change":
      return { activity: "working" as const, label: "Editing files", detail: "" };
    case "mcp_tool_call":
      return { activity: "working" as const, label: "Using a tool", detail: item.name || "" };
    case "web_search":
      return { activity: "working" as const, label: "Searching web", detail: item.query || "" };
    case "todo_list":
      return { activity: "working" as const, label: "Updating plan", detail: "" };
    default:
      return null;
  }
}

class CodexHandle implements AgentRuntimeHandle {
  readonly runtimeId = "codex" as const;
  private currentSessionId: string | null;
  private activeChild: ChildProcess | null = null;
  private finalOutput = "";
  private stopped = false;

  constructor(
    private readonly config: RuntimeLaunchConfig,
    private readonly onEvent: (event: RuntimeEvent) => void,
  ) {
    this.currentSessionId = config.sessionId;
  }

  get sessionId() {
    return this.currentSessionId;
  }

  isRunning() {
    return !this.stopped;
  }

  async send(message: string) {
    if (this.stopped) throw new Error("Codex runtime has stopped");
    if (this.activeChild) throw new Error("Codex is already processing a turn");
    this.finalOutput = "";

    const prompt = `${this.config.systemPrompt}\n\n## Incoming Teammate message\n\n${message}`;
    const args = [
      "exec",
      "--ignore-user-config",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      "shell_environment_policy.inherit=all",
    ];
    args.push("-c", `model_reasoning_effort=\"${this.config.thinkingLevel}\"`);
    if (this.config.model && this.config.model !== "default") {
      args.push("--model", this.config.model);
    }
    if (this.currentSessionId) {
      args.push("resume", this.currentSessionId, "-");
    } else {
      args.push("-");
    }

    const command = resolveRuntimeCommand("codex");
    console.log(
      `  [${this.config.displayName}] Starting Codex turn (${this.currentSessionId ? `resume: ${this.currentSessionId.substring(0, 8)}` : "new session"}) via ${command}`,
    );

    const child = spawn(command, args, {
      cwd: this.config.workDir,
      env: this.config.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.activeChild = child;

    let stdoutBuffer = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) this.handleLine(line.trim());
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.stdin?.end(prompt);

    await new Promise<void>((resolve, reject) => {
      child.on("error", (error) => {
        this.activeChild = null;
        this.onEvent({ type: "turn-failed", message: error.message });
        reject(error);
      });
      child.on("close", (code) => {
        this.activeChild = null;
        if (stdoutBuffer.trim()) {
          this.handleLine(stdoutBuffer.trim());
          stdoutBuffer = "";
        }
        if (this.stopped) {
          resolve();
          return;
        }
        if (code !== 0) {
          const message = stderr.trim() || `Codex exited with code ${code}`;
          this.onEvent({ type: "turn-failed", message: message.substring(0, 500) });
          reject(new Error(message));
          return;
        }
        if (this.finalOutput.trim()) {
          this.onEvent({ type: "output", text: this.finalOutput.trim() });
        }
        this.onEvent({
          type: "turn-complete",
          ...(this.currentSessionId
            ? { sessionId: this.currentSessionId }
            : {}),
        });
        resolve();
      });
    });
  }

  stop() {
    this.stopped = true;
    if (this.activeChild && !this.activeChild.killed) this.activeChild.kill();
    this.activeChild = null;
  }

  private handleLine(line: string) {
    let event: CodexJsonEvent;
    try {
      event = JSON.parse(line) as CodexJsonEvent;
    } catch {
      return;
    }

    if (event.type === "thread.started" && event.thread_id) {
      this.currentSessionId = event.thread_id;
      this.onEvent({ type: "session", sessionId: event.thread_id });
      return;
    }

    if (event.type === "turn.started") {
      this.onEvent({
        type: "activity",
        activity: "working",
        label: "Working",
        detail: "Codex turn started",
      });
      return;
    }

    if (event.type === "item.started" || event.type === "item.completed") {
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        event.item.text?.trim()
      ) {
        this.finalOutput = event.item.text;
      }
      const activity = describeCodexItem(event.item);
      if (activity) this.onEvent({ type: "activity", ...activity });
      return;
    }

    if (event.type === "turn.completed") return;

    if (event.type === "turn.failed") {
      const message =
        typeof event.error === "string"
          ? event.error
          : event.error?.message || "Codex turn failed";
      this.onEvent({ type: "turn-failed", message });
    }
  }
}

export class CodexRuntime implements AgentRuntime {
  readonly id = "codex" as const;

  async start(
    config: RuntimeLaunchConfig,
    onEvent: (event: RuntimeEvent) => void,
  ) {
    return new CodexHandle(config, onEvent);
  }
}
