import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  createAgentRuntime,
  normalizeRuntimeId,
  type AgentRuntimeHandle,
  type AgentRuntimeId,
  type RuntimeActivity,
  type RuntimeConnectionConfig,
  type RuntimeEvent,
} from "./runtimes/index.js";

const ACTIVITY_HEARTBEAT_MS = 60_000;

interface AgentRecord {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  system_prompt: string | null;
  runtime?: string | null;
  model: string;
  connection_id?: string | null;
  status: string;
}

interface AgentSession {
  id: string;
  name: string;
  displayName: string;
  workDir: string;
}

interface QueuedMessage {
  userMessage: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ManagedRuntime {
  handle: AgentRuntimeHandle;
  runtimeId: AgentRuntimeId;
  model: string;
  connectionId: string | null;
  sessionId: string | null;
  busy: boolean;
  activity: RuntimeActivity;
  activityLabel: string;
  activityDetail: string;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  messageQueue: QueuedMessage[];
  restartAfterTurn: boolean;
}

interface StoredSession {
  runtime_session_id?: string | null;
  runtime_session_runtime?: string | null;
  session_id?: string | null;
}

export class AgentManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly processes = new Map<string, ManagedRuntime>();
  private readonly deliveryTails = new Map<string, Promise<void>>();
  private readonly agentsDir: string;
  private supabase: SupabaseClient;
  private readonly supabaseUrl: string;
  private readonly supabaseKey: string;
  private authToken: string;
  private readonly localServerUrl: string;
  private activityChannel: RealtimeChannel;

  constructor(
    agentsDir: string,
    supabase: SupabaseClient,
    supabaseUrl: string,
    supabaseKey: string,
    authToken = "",
    localServerUrl = "",
  ) {
    this.agentsDir = agentsDir;
    this.supabase = supabase;
    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
    this.authToken = authToken;
    this.localServerUrl = localServerUrl;

    if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });

    this.activityChannel = this.supabase.channel("agent-activity", {
      config: { broadcast: { self: false } },
    });
    this.activityChannel.subscribe();
  }

  updateSupabaseClient(supabase: SupabaseClient, authToken: string) {
    this.supabase.removeChannel(this.activityChannel);
    this.supabase = supabase;
    this.authToken = authToken;
    this.activityChannel = this.supabase.channel("agent-activity", {
      config: { broadcast: { self: false } },
    });
    this.activityChannel.subscribe();
  }

  async initAgent(agentId: string, agent: AgentRecord) {
    const workDir = join(this.agentsDir, agentId);
    if (!existsSync(workDir)) {
      mkdirSync(join(workDir, "notes"), { recursive: true });
      const memoryContent = `# ${agent.display_name}

## Role
${agent.description || agent.display_name}

## Key Knowledge
- No notes saved yet. Knowledge will accumulate through conversations.

## Active Context
- Status: First startup — no prior conversations.
- Workspace initialized at: ${new Date().toISOString().split("T")[0]}
`;
      writeFileSync(join(workDir, "MEMORY.md"), memoryContent);
      console.log(`  [${agent.display_name}] Workspace created: ${workDir}`);
    } else {
      console.log(`  [${agent.display_name}] Workspace exists: ${workDir}`);
    }

    this.sessions.set(agentId, {
      id: agentId,
      name: agent.name,
      displayName: agent.display_name,
      workDir,
    });
    await this.supabase
      .from("agents")
      .update({ workspace_path: workDir })
      .eq("id", agentId);
  }

  async sendToAgent(agentId: string, userMessage: string): Promise<void> {
    const previous = this.deliveryTails.get(agentId) || Promise.resolve();
    const delivery = previous
      .catch(() => undefined)
      .then(() => this.sendToAgentNow(agentId, userMessage));
    this.deliveryTails.set(agentId, delivery);
    try {
      await delivery;
    } finally {
      if (this.deliveryTails.get(agentId) === delivery) {
        this.deliveryTails.delete(agentId);
      }
    }
  }

  private async sendToAgentNow(
    agentId: string,
    userMessage: string,
  ): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) throw new Error(`Agent ${agentId} not initialized`);

    const { data: rawAgent, error } = await this.supabase
      .from("agents")
      .select("*")
      .eq("id", agentId)
      .single();
    if (error || !rawAgent) {
      throw new Error(error?.message || `Agent ${agentId} not found`);
    }
    const agent = rawAgent as AgentRecord;

    const current = this.processes.get(agentId);
    if (current?.busy) {
      console.log(
        `  [${session.displayName}] Agent busy, queueing message (${current.messageQueue.length + 1} queued)...`,
      );
      return new Promise<void>((resolve, reject) => {
        current.messageQueue.push({ userMessage, resolve, reject });
      });
    }

    const runtimeId = normalizeRuntimeId(agent.runtime);
    const model = this.resolveModel(runtimeId, agent.model);
    let managed = current;
    if (
      !managed ||
      !managed.handle.isRunning() ||
      managed.runtimeId !== runtimeId ||
      managed.model !== model ||
      managed.connectionId !== (agent.connection_id || null)
    ) {
      const queued = managed?.messageQueue || [];
      this.stopManagedRuntime(managed);
      managed = await this.startManagedRuntime(agentId, session, agent, queued);
      this.processes.set(agentId, managed);
    }

    await this.deliverMessage(agentId, managed, session, userMessage);
  }

  getWorkspaceDir(agentId: string): string | null {
    return this.sessions.get(agentId)?.workDir ?? null;
  }

  stopAll() {
    for (const [agentId, managed] of this.processes) {
      for (const queued of managed.messageQueue) {
        queued.reject(new Error("Agent manager stopped"));
      }
      managed.messageQueue = [];
      console.log(`  Stopping agent runtime: ${agentId}`);
      this.stopManagedRuntime(managed);
    }
    this.processes.clear();
    this.sessions.clear();
    this.supabase.removeChannel(this.activityChannel);
  }

  private resolveModel(runtimeId: AgentRuntimeId, model: string | null | undefined) {
    if (runtimeId === "codex") {
      return model && !["opus", "sonnet", "haiku"].includes(model)
        ? model
        : "default";
    }
    if (runtimeId === "pi") {
      return model?.trim() || "default";
    }
    return ["opus", "sonnet", "haiku"].includes(model || "")
      ? model!
      : "sonnet";
  }

  private readSystemPrompt(session: AgentSession, agent: AgentRecord) {
    const memoryPath = join(session.workDir, "MEMORY.md");
    const memoryContext = existsSync(memoryPath)
      ? readFileSync(memoryPath, "utf-8")
      : "";
    return buildSystemPrompt(agent, memoryContext);
  }

  private async startManagedRuntime(
    agentId: string,
    session: AgentSession,
    agent: AgentRecord,
    messageQueue: QueuedMessage[] = [],
  ): Promise<ManagedRuntime> {
    const runtimeId = normalizeRuntimeId(agent.runtime);
    const model = this.resolveModel(runtimeId, agent.model);
    const sessionId = await this.loadSessionId(agentId, runtimeId);
    const zanoDir = this.prepareCliTransport(agentId, session);
    const runtime = createAgentRuntime(runtimeId);
    const connection = runtimeId === "pi"
      ? await this.loadRuntimeConnection(agent.connection_id)
      : undefined;
    let managed: ManagedRuntime | null = null;
    const pendingEvents: RuntimeEvent[] = [];
    const handle = await runtime.start(
      {
        agentId,
        displayName: session.displayName,
        workDir: session.workDir,
        systemPrompt: this.readSystemPrompt(session, agent),
        model,
        sessionId,
        connection,
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          ZANO_AGENT_ID: agentId,
          ZANO_SUPABASE_URL: this.supabaseUrl,
          ZANO_SUPABASE_KEY: this.supabaseKey,
          ZANO_AUTH_TOKEN: this.authToken,
          ...(this.localServerUrl
            ? { ZANO_LOCAL_SERVER_URL: this.localServerUrl }
            : {}),
          PATH: `${zanoDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
      (event) => {
        if (managed) void this.handleRuntimeEvent(agentId, managed, event);
        else pendingEvents.push(event);
      },
    );

    managed = {
      handle,
      runtimeId,
      model,
      connectionId: agent.connection_id || null,
      sessionId,
      busy: false,
      activity: "idle",
      activityLabel: "Idle",
      activityDetail: "",
      heartbeatTimer: null,
      messageQueue,
      restartAfterTurn: false,
    };
    for (const event of pendingEvents) {
      await this.handleRuntimeEvent(agentId, managed, event);
    }
    return managed;
  }

  private async deliverMessage(
    agentId: string,
    managed: ManagedRuntime,
    session: AgentSession,
    userMessage: string,
  ) {
    managed.busy = true;
    console.log(
      `  [${session.displayName}] Forwarding message to ${managed.runtimeId} (${userMessage.length} chars)...`,
    );
    this.broadcastActivity(agentId, "working", "Working", "Message received");
    try {
      await managed.handle.send(userMessage);
    } catch (error) {
      if (managed.busy) {
        await this.handleRuntimeEvent(agentId, managed, {
          type: "turn-failed",
          message: error instanceof Error ? error.message : "Runtime failed",
        });
      }
    }
  }

  private async handleRuntimeEvent(
    agentId: string,
    managed: ManagedRuntime,
    event: RuntimeEvent,
  ) {
    const registered = this.processes.get(agentId);
    if (registered && registered !== managed && registered.handle.isRunning()) {
      return;
    }
    const displayName = this.sessions.get(agentId)?.displayName || agentId;

    switch (event.type) {
      case "session":
        managed.sessionId = event.sessionId;
        await this.saveSessionId(agentId, managed.runtimeId, event.sessionId);
        console.log(
          `  [${displayName}] ${managed.runtimeId} session: ${event.sessionId.substring(0, 8)}...`,
        );
        break;
      case "activity":
        this.broadcastActivity(
          agentId,
          event.activity,
          event.label,
          event.detail || "",
        );
        break;
      case "context-compacting":
        managed.restartAfterTurn = true;
        this.broadcastActivity(agentId, "working", "Optimizing context", "");
        break;
      case "turn-complete":
        if (event.sessionId) {
          managed.sessionId = event.sessionId;
          await this.saveSessionId(agentId, managed.runtimeId, event.sessionId);
        }
        managed.busy = false;
        this.broadcastActivity(agentId, "idle", "Idle", "");
        console.log(`  [${displayName}] ${managed.runtimeId} turn complete.`);
        if (managed.restartAfterTurn) {
          await this.restartRuntime(agentId, managed);
        }
        this.drainQueue(agentId);
        break;
      case "turn-failed":
        if (!managed.busy && managed.activity === "error") return;
        managed.busy = false;
        this.broadcastActivity(agentId, "error", "Runtime error", event.message);
        console.error(`  [${displayName}] ${managed.runtimeId}: ${event.message}`);
        this.drainQueue(agentId);
        break;
    }
  }

  private drainQueue(agentId: string) {
    const managed = this.processes.get(agentId);
    const next = managed?.messageQueue.shift();
    if (!next) return;
    void this.sendToAgentNow(agentId, next.userMessage).then(
      next.resolve,
      next.reject,
    );
  }

  private async restartRuntime(agentId: string, previous: ManagedRuntime) {
    const session = this.sessions.get(agentId);
    if (!session) return;
    const { data } = await this.supabase
      .from("agents")
      .select("*")
      .eq("id", agentId)
      .single();
    if (!data) return;

    const queue = previous.messageQueue;
    previous.messageQueue = [];
    this.stopManagedRuntime(previous);
    const replacement = await this.startManagedRuntime(
      agentId,
      session,
      data as AgentRecord,
      queue,
    );
    this.processes.set(agentId, replacement);
  }

  private stopManagedRuntime(managed: ManagedRuntime | undefined) {
    if (!managed) return;
    if (managed.heartbeatTimer) clearInterval(managed.heartbeatTimer);
    managed.heartbeatTimer = null;
    managed.handle.stop();
  }

  private broadcastActivity(
    agentId: string,
    activity: RuntimeActivity,
    label = "",
    detail = "",
  ) {
    const managed = this.processes.get(agentId);
    if (managed) {
      managed.activity = activity;
      managed.activityLabel = label;
      managed.activityDetail = detail;
      if (activity === "thinking" || activity === "working") {
        if (!managed.heartbeatTimer) {
          managed.heartbeatTimer = setInterval(() => {
            this.sendActivity(agentId, managed.activity, managed.activityLabel, managed.activityDetail);
          }, ACTIVITY_HEARTBEAT_MS);
        }
      } else if (managed.heartbeatTimer) {
        clearInterval(managed.heartbeatTimer);
        managed.heartbeatTimer = null;
      }
    }
    this.sendActivity(agentId, activity, label, detail);
  }

  private sendActivity(
    agentId: string,
    activity: RuntimeActivity,
    label: string,
    detail: string,
  ) {
    this.activityChannel.send({
      type: "broadcast",
      event: "activity",
      payload: { agentId, activity, label, detail },
    });
  }

  private async saveSessionId(
    agentId: string,
    runtimeId: AgentRuntimeId,
    sessionId: string,
  ) {
    await this.supabase
      .from("agents")
      .update({
        runtime_session_id: sessionId,
        runtime_session_runtime: runtimeId,
        session_id: sessionId,
      })
      .eq("id", agentId);
  }

  private async loadSessionId(
    agentId: string,
    runtimeId: AgentRuntimeId,
  ): Promise<string | null> {
    const { data } = await this.supabase
      .from("agents")
      .select("runtime_session_id, runtime_session_runtime, session_id")
      .eq("id", agentId)
      .single();
    const stored = (data || {}) as StoredSession;
    if (stored.runtime_session_runtime === runtimeId) {
      return stored.runtime_session_id || null;
    }
    if (
      runtimeId === "claude-code" &&
      !stored.runtime_session_runtime &&
      stored.session_id
    ) {
      return stored.session_id;
    }
    return null;
  }

  private async loadRuntimeConnection(
    connectionId: string | null | undefined,
  ): Promise<RuntimeConnectionConfig> {
    if (!this.localServerUrl || !connectionId) {
      throw new Error("Pi requires a local model connection");
    }
    const response = await fetch(
      `${this.localServerUrl}/api/connections/${encodeURIComponent(connectionId)}/runtime`,
      {
        headers: {
          Authorization: `Bearer ${process.env.ZANO_API_KEY || "zk_local"}`,
        },
      },
    );
    const result = (await response.json()) as {
      connection?: {
        id: string;
        name: string;
        provider: RuntimeConnectionConfig["provider"];
        base_url: string | null;
        api_format: RuntimeConnectionConfig["apiFormat"];
        default_model: string;
        credential: RuntimeConnectionConfig["credential"];
      };
      error?: string;
    };
    if (!response.ok || !result.connection) {
      throw new Error(result.error || "Could not load Pi model connection");
    }
    return {
      id: result.connection.id,
      name: result.connection.name,
      provider: result.connection.provider,
      baseUrl: result.connection.base_url,
      apiFormat: result.connection.api_format,
      defaultModel: result.connection.default_model,
      credential: result.connection.credential,
    };
  }

  private prepareCliTransport(agentId: string, session: AgentSession): string {
    const zanoDir = join(session.workDir, ".zano");
    if (!existsSync(zanoDir)) mkdirSync(zanoDir, { recursive: true });

    const wrapperPath = join(zanoDir, "zano");
    const bashPath = (path: string) =>
      `'${path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
    const cmdPath = (path: string) => `"${path.replace(/"/g, '""')}"`;
    let bashCommand: string;
    let windowsCommand: string;
    const packagedCliPath = process.env.ZANO_CLI_PATH;

    if (this.localServerUrl && packagedCliPath && existsSync(packagedCliPath)) {
      bashCommand = `${bashPath(packagedCliPath)} "$@"`;
      windowsCommand = `${cmdPath(packagedCliPath)} %*`;
    } else if (this.localServerUrl) {
      const bridgeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      const cliPath = resolve(
        bridgeRoot,
        "..",
        "..",
        "packages",
        "cli",
        "src",
        "index.ts",
      );
      const tsxPath = join(bridgeRoot, "node_modules", "tsx", "dist", "cli.mjs");
      bashCommand = `${bashPath(process.execPath)} ${bashPath(tsxPath)} ${bashPath(cliPath)} "$@"`;
      windowsCommand = `${cmdPath(process.execPath)} ${cmdPath(tsxPath)} ${cmdPath(cliPath)} %*`;
    } else {
      try {
        const req = createRequire(import.meta.url);
        const cliPath = req.resolve("@fehey/zano-cli/dist/index.js");
        bashCommand = `node ${bashPath(cliPath)} "$@"`;
        windowsCommand = `node ${cmdPath(cliPath)} %*`;
      } catch {
        const bridgeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
        const cliPath = resolve(
          bridgeRoot,
          "..",
          "..",
          "packages",
          "cli",
          "src",
          "index.ts",
        );
        const tsxPath = join(bridgeRoot, "node_modules", "tsx", "dist", "cli.mjs");
        bashCommand = `${bashPath(process.execPath)} ${bashPath(tsxPath)} ${bashPath(cliPath)} "$@"`;
        windowsCommand = `${cmdPath(process.execPath)} ${cmdPath(tsxPath)} ${cmdPath(cliPath)} %*`;
      }
    }

    writeFileSync(wrapperPath, `#!/usr/bin/env bash\nexec ${bashCommand}\n`, {
      mode: 0o755,
    });
    if (process.platform === "win32") {
      writeFileSync(`${wrapperPath}.cmd`, `@echo off\r\n${windowsCommand}\r\n`);
    }
    return zanoDir;
  }
}
