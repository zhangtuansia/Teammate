import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentRuntime,
  AgentRuntimeHandle,
  RuntimeEvent,
  RuntimeLaunchConfig,
} from "./types.js";

type WorkerMessage =
  | { type: "ready"; sessionId: string }
  | { type: "event"; event: RuntimeEvent }
  | { type: "prompt-result"; id: string; error?: string }
  | { type: "fatal"; error: string };

function workerCommand(config: RuntimeLaunchConfig) {
  const packagedPath = config.env.TEAMMATE_PI_PATH;
  const packagedWorker = config.env.TEAMMATE_PI_WORKER;
  if (
    packagedPath &&
    packagedWorker &&
    existsSync(packagedPath) &&
    existsSync(packagedWorker)
  ) {
    return { command: packagedPath, args: [packagedWorker] };
  }

  const runtimeDir = dirname(fileURLToPath(import.meta.url));
  const compiledWorker = join(runtimeDir, "pi-worker.js");
  if (existsSync(compiledWorker)) {
    return { command: process.execPath, args: [compiledWorker] };
  }
  const require = createRequire(import.meta.url);
  return {
    command: process.execPath,
    args: ["--import", require.resolve("tsx"), join(runtimeDir, "pi-worker.ts")],
  };
}

class PiRuntimeHandle implements AgentRuntimeHandle {
  readonly runtimeId = "pi" as const;
  sessionId: string | null = null;
  private running = true;
  private readyResolve: ((sessionId: string) => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private failure: Error | null = null;
  private readonly pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly child: ChildProcess,
    private readonly onEvent: (event: RuntimeEvent) => void,
  ) {
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr?.on("data", (chunk) => {
      const detail = String(chunk).trim();
      if (detail) console.error(`  [pi] ${detail}`);
    });
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code) => {
      if (!this.running) return;
      this.fail(new Error(`Pi worker exited${code === null ? "" : ` with code ${code}`}`));
    });
  }

  async initialize(config: RuntimeLaunchConfig) {
    const ready = new Promise<string>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.write({
      type: "init",
      config: {
        workDir: config.workDir,
        systemPrompt: config.systemPrompt,
        model: config.model,
        thinkingLevel: config.thinkingLevel,
        connection: config.connection,
      },
    });
    const timeout = setTimeout(() => {
      this.fail(new Error("Pi worker did not become ready"));
      this.child.kill("SIGTERM");
    }, 20_000);
    try {
      this.sessionId = await ready;
    } finally {
      clearTimeout(timeout);
      this.readyResolve = null;
      this.readyReject = null;
    }
  }

  isRunning() {
    return this.running && !this.child.killed;
  }

  async send(message: string) {
    if (!this.isRunning()) throw new Error("Pi runtime is not running");
    const id = randomUUID();
    const result = new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ type: "prompt", id, message });
    return result;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    const error = new Error("Pi runtime stopped");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.write({ type: "shutdown" });
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 1000);
    timer.unref();
  }

  private write(value: unknown) {
    this.child.stdin?.write(`${JSON.stringify(value)}\n`);
  }

  private handleLine(line: string) {
    let message: WorkerMessage;
    try {
      message = JSON.parse(line) as WorkerMessage;
    } catch {
      console.error(`  [pi] Invalid worker output: ${line}`);
      return;
    }
    if (message.type === "ready") {
      this.sessionId = message.sessionId;
      this.readyResolve?.(message.sessionId);
      this.onEvent({ type: "session", sessionId: message.sessionId });
      return;
    }
    if (message.type === "event") {
      this.onEvent(message.event);
      return;
    }
    if (message.type === "fatal") {
      this.fail(new Error(message.error));
      this.child.kill("SIGTERM");
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve();
  }

  private fail(error: Error) {
    if (this.failure || !this.running) return;
    this.failure = error;
    const initialized = this.sessionId !== null;
    this.running = false;
    this.readyReject?.(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (initialized) this.onEvent({ type: "turn-failed", message: error.message });
  }
}

export class PiRuntime implements AgentRuntime {
  readonly id = "pi" as const;

  async start(
    config: RuntimeLaunchConfig,
    onEvent: (event: RuntimeEvent) => void,
  ) {
    if (!config.connection) {
      throw new Error("Pi requires a configured model connection");
    }
    const executable = workerCommand(config);
    const child = spawn(executable.command, executable.args, {
      cwd: config.workDir,
      env: config.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const handle = new PiRuntimeHandle(child, onEvent);
    await handle.initialize(config);
    return handle;
  }
}
