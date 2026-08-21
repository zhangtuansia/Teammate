import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ExecutionSession,
  type ExecutionTurn,
  type NormalizedExecutionEvent,
} from "@teammate/execution-core";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { ExecutionRuntimeAdapter } from "./execution-runtime-adapter.js";
import {
  enforcePrivateFileCreationMask,
  ensurePrivateDirectory,
  restrictPrivateFile,
  writePrivateFile,
} from "./private-filesystem.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { runtimeProcessEnvironment } from "./runtime-env.js";
import {
  createAgentRuntime,
  normalizeRuntimeId,
  type AgentRuntimeHandle,
  type AgentRuntimeId,
  type RuntimeActivity,
  type RuntimeConnectionConfig,
  type RuntimeThinkingLevel,
} from "./runtimes/index.js";

const ACTIVITY_HEARTBEAT_MS = 60_000;
const ACTIVITY_SEND_ERROR_LOG_INTERVAL_MS = 30_000;
export const DEFAULT_AGENT_TURN_TIMEOUT_MS = 10 * 60_000;
const RUNTIME_ERROR_MESSAGE_PREFIX = "<!-- teammate:runtime-error -->";
const RUNTIME_TURN_TIMEOUT_MESSAGE =
  "The AI response timed out. Teammate is restarting the runtime before continuing queued messages. Retry this message; if it keeps happening, check the model connection or choose another model.";
const CODEX_MODELS = new Set([
  "default",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.3-codex",
]);
const REPLY_SENT_MARKER = /\[teammate:reply-sent\]/gi;
const MAX_ACTIVITY_DETAIL_LENGTH = 200;

function normalizeVisibleOutput(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeActivityDetail(value: string) {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_ACTIVITY_DETAIL_LENGTH
    ? `${collapsed.slice(0, MAX_ACTIVITY_DETAIL_LENGTH - 1)}…`
    : collapsed;
}

/**
 * Agents that already replied (or decided no reply is needed) end the turn
 * with this marker so a marker-only trailing text persists nothing.
 */
function stripReplySentMarker(output: string) {
  const stripped = output.replace(REPLY_SENT_MARKER, " ");
  return {
    claimsReplySent: stripped !== output,
    remainder: normalizeVisibleOutput(stripped),
  };
}

function runtimeConnectionErrorMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return runtimeConnectionErrorMessage(record.message) ||
    runtimeConnectionErrorMessage(record.error) ||
    runtimeConnectionErrorMessage(record.detail);
}

interface AgentRecord {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  system_prompt: string | null;
  runtime?: string | null;
  model: string;
  connection_id?: string | null;
  thinking_level?: string | null;
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
  /** The message header + content without the recent-history prefix, so
   * queued same-channel messages can merge without duplicating context. */
  body?: string;
  channelId: string | null;
  ambient: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}
const QUEUE_MERGE_LIMIT = 5;

interface ManagedRuntime {
  handle: AgentRuntimeHandle;
  runtimeId: AgentRuntimeId;
  model: string;
  connectionId: string | null;
  thinkingLevel: RuntimeThinkingLevel;
  sessionId: string | null;
  busy: boolean;
  activity: RuntimeActivity;
  activityLabel: string;
  activityDetail: string;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  execution: ExecutionSession<QueuedMessage, RuntimeThinkingLevel>;
  executionAdapter: ExecutionRuntimeAdapter<RuntimeThinkingLevel>;
  activeChannelId: string | null;
  pendingOutput: string;
  turnStartSeq: number | null;
  turnAmbient: boolean;
  eventTail: Promise<void>;
  restartAfterTurn: boolean;
}

interface StoredSession {
  runtime_session_id?: string | null;
  runtime_session_runtime?: string | null;
  session_id?: string | null;
}

export interface AgentManagerOptions {
  turnTimeoutMs?: number;
  /** Directory holding uploaded attachments, so agents can open the real file
   * behind an `/api/attachments/...` reference. */
  attachmentsDir?: string;
}

export class AgentManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly processes = new Map<string, ManagedRuntime>();
  private readonly deliveryTails = new Map<string, Promise<void>>();
  private readonly removedAgentIds = new Set<string>();
  private readonly agentsDir: string;
  private supabase: SupabaseClient;
  private readonly supabaseUrl: string;
  private readonly supabaseKey: string;
  private authToken: string;
  private agentAuthTokens: Map<string, string>;
  private readonly localServerUrl: string;
  private readonly attachmentsDir: string;
  private readonly serverId: string;
  private readonly runtimeApiKey: string;
  private readonly refreshAgentAuthTokens?: () => Promise<Record<string, string>>;
  private readonly turnTimeoutMs: number;
  private activityChannel: RealtimeChannel;
  private lastActivitySendErrorLogAt = 0;

  constructor(
    agentsDir: string,
    supabase: SupabaseClient,
    supabaseUrl: string,
    supabaseKey: string,
    authToken = "",
    localServerUrl = "",
    serverId = "local",
    runtimeApiKey = "",
    agentAuthTokens: Record<string, string> = {},
    refreshAgentAuthTokens?: () => Promise<Record<string, string>>,
    options: AgentManagerOptions = {},
  ) {
    this.agentsDir = agentsDir;
    this.supabase = supabase;
    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
    this.authToken = authToken;
    this.agentAuthTokens = new Map(Object.entries(agentAuthTokens));
    this.localServerUrl = localServerUrl;
    this.attachmentsDir = options.attachmentsDir || "";
    this.serverId = serverId;
    this.runtimeApiKey = runtimeApiKey;
    this.refreshAgentAuthTokens = refreshAgentAuthTokens;
    const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_AGENT_TURN_TIMEOUT_MS;
    if (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs < 1 || turnTimeoutMs > 2_147_483_647) {
      throw new RangeError("Agent turn timeout must be between 1 and 2147483647 ms");
    }
    this.turnTimeoutMs = Math.floor(turnTimeoutMs);

    enforcePrivateFileCreationMask();
    ensurePrivateDirectory(agentsDir);

    this.activityChannel = this.supabase.channel(`agent-activity:${this.serverId}`, {
      config: { private: true, broadcast: { ack: true, self: false } },
    });
    this.activityChannel.subscribe((status, error) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error("  Agent activity subscription failed:", status, error || "");
      }
    });
  }

  updateSupabaseClient(
    supabase: SupabaseClient,
    authToken: string,
    agentAuthTokens: Record<string, string> = {},
  ) {
    this.supabase.removeChannel(this.activityChannel);
    this.supabase = supabase;
    this.authToken = authToken;
    this.activityChannel = this.supabase.channel(`agent-activity:${this.serverId}`, {
      config: { private: true, broadcast: { ack: true, self: false } },
    });
    this.activityChannel.subscribe((status, error) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error("  Agent activity subscription failed:", status, error || "");
      }
    });

    this.updateAgentAuthTokens(agentAuthTokens);
  }

  updateAgentAuthTokens(agentAuthTokens: Record<string, string>) {
    this.agentAuthTokens = new Map(Object.entries(agentAuthTokens));
    // Spawned runtimes inherit the scoped token through their environment.
    // Recycle idle handles now and busy handles after their current turn so
    // subsequent CLI calls never keep using the retired token.
    for (const [agentId, managed] of this.processes) {
      if (managed.busy || managed.execution.queueLength > 0) {
        managed.restartAfterTurn = true;
        continue;
      }
      this.stopManagedRuntime(managed);
      this.processes.delete(agentId);
    }
  }

  async initAgent(agentId: string, agent: AgentRecord) {
    this.removedAgentIds.delete(agentId);
    const workDir = join(this.agentsDir, agentId);
    const existingWorkspace = existsSync(workDir);
    ensurePrivateDirectory(workDir);
    ensurePrivateDirectory(join(workDir, "notes"));
    const memoryPath = join(workDir, "MEMORY.md");
    if (!existsSync(memoryPath)) {
      const memoryContent = `# ${agent.display_name}

## Role
${agent.description || agent.display_name}

## Key Knowledge
- No notes saved yet. Knowledge will accumulate through conversations.

## Active Context
- Status: First startup — no prior conversations.
- Workspace initialized at: ${new Date().toISOString().split("T")[0]}
`;
      writePrivateFile(memoryPath, memoryContent);
    } else {
      restrictPrivateFile(memoryPath);
    }
    if (!existingWorkspace) {
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

  async sendToAgent(
    agentId: string,
    userMessage: string,
    channelId: string | null = null,
    options: { ambient?: boolean; body?: string } = {},
  ): Promise<void> {
    const previous = this.deliveryTails.get(agentId) || Promise.resolve();
    const delivery = previous
      .catch(() => undefined)
      .then(() =>
        this.sendToAgentNow(
          agentId,
          userMessage,
          channelId,
          options.ambient === true,
          options.body,
        ));
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
    channelId: string | null,
    ambient = false,
    body?: string,
  ): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session || this.removedAgentIds.has(agentId)) {
      throw new Error(`Agent ${agentId} not initialized`);
    }

    const { data: rawAgent, error } = await this.supabase
      .from("agents")
      .select("*")
      .eq("id", agentId)
      .single();
    if (error || !rawAgent) {
      throw new Error(error?.message || `Agent ${agentId} not found`);
    }
    if (this.removedAgentIds.has(agentId) || !this.sessions.has(agentId)) {
      throw new Error(`Agent ${agentId} was removed`);
    }
    const agent = rawAgent as AgentRecord;

    const current = this.processes.get(agentId);
    if (current?.busy) {
      // Craft-style steering: a follow-up in the same conversation joins the
      // running turn instead of waiting behind it, when the runtime supports it.
      const activeTurn = current.execution.activeTurn;
      if (
        activeTurn &&
        current.execution.phase === "running" &&
        channelId !== null &&
        channelId === current.activeChannelId &&
        current.executionAdapter.capabilities.steer
      ) {
        const steerOutcome = await current.executionAdapter.trySteer(userMessage, activeTurn);
        if (steerOutcome === "accepted") {
          if (current.execution.isCurrent(activeTurn)) {
            current.execution.submit(
              { userMessage, body, channelId, ambient, resolve: () => undefined, reject: () => undefined },
              { midStreamBehavior: "steer", steerOutcome },
            );
          }
          console.log(
            `  [${session.displayName}] Steered follow-up into the active ${current.runtimeId} turn.`,
          );
          return;
        }
      }
      console.log(
        `  [${session.displayName}] Agent busy, queueing message (${current.execution.queueLength + 1} queued)...`,
      );
      return new Promise<void>((resolve, reject) => {
        const payload = { userMessage, body, channelId, ambient, resolve, reject };
        const result = current.execution.phase === "running"
          ? current.execution.submit(payload)
          : current.execution.enqueue(payload);
        if (result.kind !== "queued") {
          reject(new Error("Could not queue the message while the runtime was busy"));
        }
      });
    }

    const runtimeId = normalizeRuntimeId(agent.runtime);
    const storedModel = this.resolveModel(runtimeId, agent.model);
    const model = runtimeId === "pi" && storedModel === "default" &&
      current?.runtimeId === "pi" && current.connectionId === (agent.connection_id || null)
      ? current.model
      : storedModel;
    let managed = current;
    if (
      !managed ||
      !managed.handle.isRunning() ||
      managed.runtimeId !== runtimeId ||
      managed.model !== model ||
      managed.connectionId !== (agent.connection_id || null) ||
      managed.thinkingLevel !== this.resolveThinkingLevel(agent.thinking_level)
    ) {
      const execution = managed?.execution;
      if (execution) execution.rotateGeneration();
      this.stopManagedRuntime(managed);
      try {
        managed = await this.startManagedRuntime(agentId, session, agent, execution);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent runtime failed to start";
        this.sendActivity(agentId, "error", "Runtime error", "", channelId);
        if (channelId) await this.persistRuntimeError(agentId, channelId, message);
        throw error;
      }
      if (this.removedAgentIds.has(agentId) || !this.sessions.has(agentId)) {
        const removalError = new Error(`Agent ${agentId} was removed`);
        const disposed = managed.execution.dispose(removalError.message);
        for (const queued of disposed.dropped) queued.payload.reject(removalError);
        this.stopManagedRuntime(managed);
        throw removalError;
      }
      this.processes.set(agentId, managed);
    }

    await this.deliverMessage(agentId, managed, session, userMessage, channelId, ambient);
  }

  /** True while a turn is running or queued work is waiting. Proactive nudges
   * check this so they never pile onto an agent that is already working. */
  isBusy(agentId: string): boolean {
    const managed = this.processes.get(agentId);
    if (!managed) return false;
    return managed.busy || managed.execution.queueLength > 0;
  }

  getWorkspaceDir(agentId: string): string | null {
    return this.sessions.get(agentId)?.workDir ?? null;
  }

  async cancelAgentTurn(agentId: string, reason = "User requested stop") {
    const managed = this.processes.get(agentId);
    if (!managed) return false;
    const operation = managed.eventTail
      .catch(() => undefined)
      .then(() => this.cancelManagedTurn(agentId, managed, reason));
    managed.eventTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async cancelManagedTurn(
    agentId: string,
    managed: ManagedRuntime,
    reason: string,
  ) {
    if (this.processes.get(agentId) !== managed) return false;
    const activeTurn = managed.execution.activeTurn;
    if (!activeTurn) return false;

    const cancelled = managed.execution.cancel(reason);
    const cancelError = new Error(reason);
    for (const queued of cancelled.dropped) queued.payload.reject(cancelError);
    managed.pendingOutput = "";
    managed.activeChannelId = null;
    managed.busy = false;

    let backendCancelled = false;
    try {
      backendCancelled = await managed.executionAdapter.cancel(reason, activeTurn);
    } catch (error) {
      console.error(
        `  [${agentId}] Runtime cancellation failed: ${
          error instanceof Error ? error.message : "Unknown cancellation error"
        }`,
      );
    }

    if (backendCancelled) {
      managed.execution.completeCancellation();
    } else {
      // An undeclared/unsupported cancellation capability must not leave a
      // provider running behind a locally-cancelled turn.
      managed.execution.dispose(reason);
      this.stopManagedRuntime(managed);
      if (this.processes.get(agentId) === managed) this.processes.delete(agentId);
    }
    this.broadcastActivity(agentId, "idle", "Idle", "");
    return true;
  }

  removeAgent(agentId: string) {
    this.removedAgentIds.add(agentId);
    const managed = this.processes.get(agentId);
    this.processes.delete(agentId);
    this.sessions.delete(agentId);
    this.deliveryTails.delete(agentId);

    if (!managed) return;
    const error = new Error("Agent removed");
    const disposed = managed.execution.dispose(error.message);
    for (const queued of disposed.dropped) queued.payload.reject(error);
    this.stopManagedRuntime(managed);
  }

  stopAll() {
    for (const [agentId, managed] of this.processes) {
      this.removedAgentIds.add(agentId);
      const error = new Error("Agent manager stopped");
      const disposed = managed.execution.dispose(error.message);
      for (const queued of disposed.dropped) queued.payload.reject(error);
      console.log(`  Stopping agent runtime: ${agentId}`);
      this.stopManagedRuntime(managed);
    }
    this.processes.clear();
    this.sessions.clear();
    this.deliveryTails.clear();
    this.supabase.removeChannel(this.activityChannel);
  }

  private resolveModel(runtimeId: AgentRuntimeId, model: string | null | undefined) {
    if (runtimeId === "codex") {
      return model && CODEX_MODELS.has(model) ? model : "default";
    }
    if (runtimeId === "pi") {
      return model?.trim() || "default";
    }
    return ["opus", "sonnet", "haiku"].includes(model || "")
      ? model!
      : "sonnet";
  }

  private resolveThinkingLevel(value: string | null | undefined): RuntimeThinkingLevel {
    return value === "low" || value === "high" ? value : "medium";
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
    existingExecution?: ExecutionSession<QueuedMessage, RuntimeThinkingLevel>,
  ): Promise<ManagedRuntime> {
    const runtimeId = normalizeRuntimeId(agent.runtime);
    let model = this.resolveModel(runtimeId, agent.model);
    const thinkingLevel = this.resolveThinkingLevel(agent.thinking_level);
    const sessionId = await this.loadSessionId(agentId, runtimeId);
    const teammateDir = this.prepareCliTransport(agentId, session);
    const runtime = createAgentRuntime(runtimeId);
    const connection = runtimeId === "pi"
      ? await this.loadRuntimeConnection(agent.connection_id)
      : undefined;
    if (connection) {
      if (model === "default" || !model) model = connection.defaultModel;
      if (!connection.models.some((candidate) => candidate.id === model)) {
        throw new Error("The selected model is no longer available for this connection");
      }
    }
    const agentAuthToken = await this.resolveAgentAuthToken(agentId);
    const execution = existingExecution ?? new ExecutionSession<
      QueuedMessage,
      RuntimeThinkingLevel
    >({ midStreamBehavior: "queue", thinkingLevel });
    execution.updateDefaults({ midStreamBehavior: "queue", thinkingLevel });
    const executionAdapter = new ExecutionRuntimeAdapter<RuntimeThinkingLevel>(
      execution.generation,
    );
    let managed: ManagedRuntime | null = null;
    const pendingEvents: Array<NormalizedExecutionEvent<RuntimeActivity>> = [];
    const handle = await runtime.start(
      {
        agentId,
        displayName: session.displayName,
        workDir: session.workDir,
        systemPrompt: this.readSystemPrompt(session, agent),
        model,
        thinkingLevel,
        sessionId,
        connection,
        env: {
          ...runtimeProcessEnvironment(),
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          TEAMMATE_AGENT_ID: agentId,
          TEAMMATE_SUPABASE_URL: this.supabaseUrl,
          TEAMMATE_SUPABASE_KEY: this.supabaseKey,
          TEAMMATE_AUTH_TOKEN: agentAuthToken,
          ...(this.localServerUrl
            ? { TEAMMATE_LOCAL_SERVER_URL: this.localServerUrl }
            : {}),
          ...(this.attachmentsDir
            ? { TEAMMATE_ATTACHMENTS_DIR: this.attachmentsDir }
            : {}),
          PATH: `${teammateDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
      (event) => {
        const normalized = executionAdapter.normalize(event);
        if (!normalized) return;
        if (!managed) {
          pendingEvents.push(normalized);
          return;
        }
        this.enqueueRuntimeEvent(agentId, managed, normalized, session.displayName);
      },
    );
    executionAdapter.attach(handle);

    managed = {
      handle,
      runtimeId,
      model,
      connectionId: agent.connection_id || null,
      thinkingLevel,
      sessionId,
      busy: false,
      activity: "idle",
      activityLabel: "Idle",
      activityDetail: "",
      heartbeatTimer: null,
      execution,
      executionAdapter,
      activeChannelId: null,
      pendingOutput: "",
      turnStartSeq: null,
      turnAmbient: false,
      eventTail: Promise.resolve(),
      restartAfterTurn: false,
    };
    for (const event of pendingEvents) {
      await this.handleRuntimeEvent(agentId, managed, event);
    }
    return managed;
  }

  private async resolveAgentAuthToken(agentId: string): Promise<string> {
    const current = this.agentAuthTokens.get(agentId);
    if (current) return current;
    if (this.refreshAgentAuthTokens) {
      const refreshed = await this.refreshAgentAuthTokens();
      this.agentAuthTokens = new Map(Object.entries(refreshed));
      const token = this.agentAuthTokens.get(agentId);
      if (token) return token;
    }
    throw new Error(`No scoped runtime credential is available for agent ${agentId}`);
  }

  private async deliverMessage(
    agentId: string,
    managed: ManagedRuntime,
    session: AgentSession,
    userMessage: string,
    channelId: string | null,
    ambient = false,
  ) {
    const turnStartSeq = channelId
      ? await this.loadLatestMessageSeq(channelId)
      : null;
    const submitted = managed.execution.submit({
      userMessage,
      channelId,
      ambient,
      resolve: () => undefined,
      reject: () => undefined,
    }, {
      midStreamBehavior: "queue",
      thinkingLevel: managed.thinkingLevel,
    });
    if (submitted.kind !== "started") {
      throw new Error("Could not start an execution turn on an idle runtime");
    }
    const turn = submitted.turn;
    managed.executionAdapter.bindTurn(turn);
    this.armTurnWatchdog(agentId, managed, turn);
    managed.busy = true;
    managed.activeChannelId = channelId;
    managed.pendingOutput = "";
    managed.turnStartSeq = turnStartSeq;
    managed.turnAmbient = ambient;
    console.log(
      `  [${session.displayName}] Forwarding message to ${managed.runtimeId} (${userMessage.length} chars)...`,
    );
    this.broadcastActivity(agentId, "working", "Working", "Message received");
    try {
      const dispatch = managed.handle.send(userMessage);
      void dispatch.catch((error: unknown) => {
        const failure = managed.executionAdapter.normalizeDispatchFailure(turn, error);
        if (failure) this.enqueueRuntimeEvent(agentId, managed, failure, session.displayName);
      });
    } catch (error) {
      const failure = managed.executionAdapter.normalizeDispatchFailure(turn, error);
      if (failure) this.enqueueRuntimeEvent(agentId, managed, failure, session.displayName);
    }
  }

  private armTurnWatchdog(
    agentId: string,
    managed: ManagedRuntime,
    turn: ExecutionTurn<QueuedMessage, RuntimeThinkingLevel>,
  ) {
    managed.execution.armWatchdog(
      turn,
      this.turnTimeoutMs || DEFAULT_AGENT_TURN_TIMEOUT_MS,
      (expiredTurn) => {
        const timeout = managed.executionAdapter.normalizeTimeout(
          expiredTurn,
          RUNTIME_TURN_TIMEOUT_MESSAGE,
        );
        if (!timeout) return;
        managed.restartAfterTurn = true;
        this.enqueueRuntimeEvent(
          agentId,
          managed,
          timeout,
          this.sessions.get(agentId)?.displayName || agentId,
        );
      },
    );
  }

  private enqueueRuntimeEvent(
    agentId: string,
    managed: ManagedRuntime,
    event: NormalizedExecutionEvent<RuntimeActivity>,
    displayName: string,
  ) {
    if (event.type === "terminal") {
      managed.execution.clearWatchdog(event.turn);
    }
    managed.eventTail = managed.eventTail
      .catch(() => undefined)
      .then(() => this.handleRuntimeEvent(agentId, managed, event))
      .catch((error) => {
        console.error(
          `  [${displayName}] Could not process runtime event: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        );
      });
  }

  private async handleRuntimeEvent(
    agentId: string,
    managed: ManagedRuntime,
    event: NormalizedExecutionEvent<RuntimeActivity>,
  ) {
    if (this.removedAgentIds.has(agentId)) return;
    if (managed.execution.phase === "disposed") return;
    if (event.generation !== managed.execution.generation) return;
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
        if (event.turn && !managed.execution.isCurrent(event.turn)) return;
        this.broadcastActivity(
          agentId,
          event.activity,
          event.label,
          normalizeActivityDetail(event.detail || ""),
        );
        break;
      case "output":
        if (!managed.execution.isCurrent(event.turn)) return;
        managed.pendingOutput = event.text.trim().slice(0, 50_000);
        break;
      case "context-compacting":
        if (!managed.execution.isCurrent(event.turn)) return;
        managed.restartAfterTurn = true;
        this.broadcastActivity(agentId, "working", "Optimizing context", "");
        break;
      case "terminal": {
        const finished = managed.execution.finish(event.turn, event.terminal);
        if (!finished.accepted) return;
        if (event.terminal.status === "timed_out") {
          managed.restartAfterTurn = true;
        }
        if (event.terminal.sessionId) {
          managed.sessionId = event.terminal.sessionId;
          await this.saveSessionId(
            agentId,
            managed.runtimeId,
            event.terminal.sessionId,
          );
        }
        if (event.terminal.status === "completed") {
          // Ambient turns are courtesy deliveries the agent was never asked to
          // answer: it speaks through the CLI or stays silent, so the trailing
          // safety net never posts for them.
          if (managed.activeChannelId && managed.pendingOutput && !managed.turnAmbient) {
            await this.persistOutputIfNeeded(
              agentId,
              managed.activeChannelId,
              managed.pendingOutput,
              managed.turnStartSeq,
            );
          }
          managed.pendingOutput = "";
          managed.busy = false;
          // Preserve the turn's channel on the terminal event so the UI can
          // settle the matching pending indicator without affecting another chat.
          this.broadcastActivity(agentId, "idle", "Idle", "");
          managed.activeChannelId = null;
          console.log(`  [${displayName}] ${managed.runtimeId} turn complete.`);
        } else {
          const failedChannelId = managed.activeChannelId;
          const message = event.terminal.message || "Runtime failed";
          managed.pendingOutput = "";
          const timedOut = event.terminal.status === "timed_out";
          this.broadcastActivity(
            agentId,
            "error",
            timedOut ? "Response timed out" : "Runtime error",
            timedOut ? "The runtime will restart automatically. Retry the message." : "",
          );
          managed.activeChannelId = null;
          console.error(`  [${displayName}] ${managed.runtimeId}: ${message}`);
          if (failedChannelId) {
            await this.persistRuntimeError(agentId, failedChannelId, message);
          }
          managed.busy = false;
        }
        await this.finalizeTurn(agentId, managed);
        break;
      }
    }
  }

  private async finalizeTurn(agentId: string, managed: ManagedRuntime) {
    let current = managed;
    while (current.restartAfterTurn) {
      // Keep new deliveries queued on this handle until its replacement is
      // installed, so a refresh cannot race a message into two runtimes.
      current.busy = true;
      try {
        current = await this.restartRuntime(agentId, current);
      } catch (error) {
        console.error(
          `  [${agentId}] Could not restart runtime after turn: ${
            error instanceof Error ? error.message : "Unknown runtime restart error"
          }`,
        );
        return;
      }
    }
    current.busy = false;
    this.drainQueue(agentId);
  }

  private drainQueue(agentId: string) {
    const managed = this.processes.get(agentId);
    const next = managed?.execution.dequeue()?.payload;
    if (!managed || !next) return;
    // Messages that piled up for the same channel while the runtime was busy
    // become one turn: keep the first prompt (it carries the history prefix)
    // and append the bare bodies of the rest.
    const batch = [next];
    while (batch.length < QUEUE_MERGE_LIMIT) {
      const upcoming = managed.execution.peekQueue();
      if (!upcoming || upcoming.channelId !== next.channelId) break;
      const merged = managed.execution.dequeue()?.payload;
      if (!merged) break;
      batch.push(merged);
    }
    const userMessage = batch
      .map((item, index) => (index === 0 ? item.userMessage : item.body || item.userMessage))
      .join("\n\n");
    const ambient = batch.every((item) => item.ambient);
    if (batch.length > 1) {
      console.log(`  Merged ${batch.length} queued messages into one turn.`);
    }
    void this.sendToAgentNow(agentId, userMessage, next.channelId, ambient, next.body).then(
      () => batch.forEach((item) => item.resolve()),
      (error: Error) => batch.forEach((item) => item.reject(error)),
    );
  }

  private async persistRuntimeError(
    agentId: string,
    channelId: string,
    message: string,
  ) {
    const detail = message.trim().slice(0, 4_000) || "The runtime failed without an error message.";
    try {
      const { error } = await this.supabase.from("messages").insert({
        channel_id: channelId,
        sender_id: agentId,
        sender_type: "agent",
        content: `${RUNTIME_ERROR_MESSAGE_PREFIX}\n${detail}`,
      });
      if (error) {
        console.error(`  [${agentId}] Could not save runtime error message: ${error.message}`);
      }
    } catch (error) {
      console.error(
        `  [${agentId}] Could not save runtime error message: ${
          error instanceof Error ? error.message : "Unknown persistence error"
        }`,
      );
    }
  }

  private async loadLatestMessageSeq(channelId: string) {
    const { data, error } = await this.supabase
      .from("messages")
      .select("seq")
      .eq("channel_id", channelId)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error(`  Could not load message sequence: ${error.message}`);
      return null;
    }
    const value = Number((data as { seq?: number | string | null } | null)?.seq || 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  private async persistOutputIfNeeded(
    agentId: string,
    channelId: string,
    output: string,
    turnStartSeq: number | null,
  ) {
    const { claimsReplySent, remainder } = stripReplySentMarker(output);
    const visibleOutput = claimsReplySent ? remainder : output;

    if (turnStartSeq !== null) {
      const { data: existingMessages, error: lookupError } = await this.supabase
        .from("messages")
        .select("id")
        .eq("channel_id", channelId)
        .eq("sender_id", agentId)
        .eq("sender_type", "agent")
        .gt("seq", turnStartSeq)
        .limit(1);
      if (lookupError) {
        console.error(`  [${agentId}] Could not check visible runtime output: ${lookupError.message}`);
      } else if (((existingMessages || []) as unknown[]).length > 0) {
        // The CLI is the agent's voice in the channel. Once it spoke there this
        // turn, the trailing runtime text is addressed to the harness — closing
        // narration, notes to self — and never a second chat message. Trailing
        // text is only persisted as a safety net for turns where the agent
        // produced an answer without ever reaching the channel.
        return;
      }
    }

    if (!visibleOutput) return;

    const { error } = await this.supabase.from("messages").insert({
      channel_id: channelId,
      sender_id: agentId,
      sender_type: "agent",
      content: visibleOutput,
    });
    if (error) {
      console.error(`  [${agentId}] Could not save runtime output: ${error.message}`);
    }
  }

  private async restartRuntime(agentId: string, previous: ManagedRuntime) {
    const session = this.sessions.get(agentId);
    const execution = previous.execution;
    // A token update racing the replacement will set this flag again on the
    // still-registered handle. Carry that request onto the new runtime.
    previous.restartAfterTurn = false;
    execution.rotateGeneration();
    this.stopManagedRuntime(previous);

    try {
      if (!session || this.removedAgentIds.has(agentId)) {
        throw new Error(`Agent ${agentId} is no longer available`);
      }
      const { data, error } = await this.supabase
        .from("agents")
        .select("*")
        .eq("id", agentId)
        .single();
      if (error || !data) {
        throw new Error(error?.message || `Agent ${agentId} is no longer available`);
      }

      const replacement = await this.startManagedRuntime(
        agentId,
        session,
        data as AgentRecord,
        execution,
      );
      if (this.removedAgentIds.has(agentId) || !this.sessions.has(agentId)) {
        this.stopManagedRuntime(replacement);
        throw new Error(`Agent ${agentId} was removed while its runtime restarted`);
      }
      replacement.restartAfterTurn = previous.restartAfterTurn;
      this.processes.set(agentId, replacement);
      return replacement;
    } catch (error) {
      const restartError = error instanceof Error
        ? error
        : new Error("Agent runtime restart failed");
      const disposed = execution.dispose(restartError.message);
      for (const queued of disposed.dropped) queued.payload.reject(restartError);
      if (this.processes.get(agentId) === previous) {
        this.processes.delete(agentId);
      }
      throw restartError;
    }
  }

  private stopManagedRuntime(managed: ManagedRuntime | undefined) {
    if (!managed) return;
    managed.execution.clearWatchdog();
    if (managed.heartbeatTimer) clearInterval(managed.heartbeatTimer);
    managed.heartbeatTimer = null;
    try {
      managed.handle.stop();
    } catch (error) {
      console.error(
        `  Runtime stop failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  private broadcastActivity(
    agentId: string,
    activity: RuntimeActivity,
    label = "",
    detail = "",
  ) {
    const managed = this.processes.get(agentId);
    let repeatsInProgressState = false;
    if (managed) {
      // Codex reports item.started and item.completed for the same step, so an
      // unchanged in-progress tuple would otherwise broadcast the same line twice.
      repeatsInProgressState =
        (activity === "thinking" || activity === "working") &&
        managed.activity === activity &&
        managed.activityLabel === label &&
        managed.activityDetail === detail;
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
    if (repeatsInProgressState) return;
    this.sendActivity(agentId, activity, label, detail);
  }

  private sendActivity(
    agentId: string,
    activity: RuntimeActivity,
    label: string,
    detail: string,
    channelId = this.processes.get(agentId)?.activeChannelId || null,
  ) {
    void this.activityChannel
      .send({
        type: "broadcast",
        event: "activity",
        payload: {
          serverId: this.serverId,
          channelId,
          agentId,
          activity,
          label,
          detail,
        },
      })
      .then((status) => {
        if (status !== "ok") this.reportActivitySendError(status);
      })
      .catch((error: unknown) => this.reportActivitySendError(error));
  }

  private reportActivitySendError(error: unknown) {
    const now = Date.now();
    if (now - this.lastActivitySendErrorLogAt < ACTIVITY_SEND_ERROR_LOG_INTERVAL_MS) {
      return;
    }
    this.lastActivitySendErrorLogAt = now;
    console.error(
      "  Agent activity broadcast failed:",
      error instanceof Error ? error.message : error,
    );
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
    let response: Response;
    try {
      response = await fetch(
        `${this.localServerUrl}/api/connections/${encodeURIComponent(connectionId)}/runtime`,
        {
          headers: {
            Authorization: `Bearer ${this.runtimeApiKey}`,
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (error) {
      if (error instanceof Error && (
        error.name === "AbortError" ||
        error.name === "TimeoutError"
      )) {
        throw new Error("Timed out while loading the model connection. Try again.", {
          cause: error,
        });
      }
      throw error;
    }
    const result = (await response.json().catch(() => ({}))) as {
      connection?: {
        id: string;
        name: string;
        provider: RuntimeConnectionConfig["provider"];
        base_url: string | null;
        api_format: RuntimeConnectionConfig["apiFormat"];
        default_model: string;
        models: RuntimeConnectionConfig["models"];
        credential: RuntimeConnectionConfig["credential"];
      };
      error?: unknown;
    };
    if (!response.ok || !result.connection) {
      throw new Error(
        runtimeConnectionErrorMessage(result.error) || "Could not load Pi model connection",
      );
    }
    if (
      Array.isArray((result.connection as { models?: unknown }).models) &&
      !(result.connection as { models: Array<{ id?: unknown }> }).models.some(
        (model) => model && model.id === result.connection!.default_model,
      )
    ) {
      throw new Error("The selected model is no longer available for this connection");
    }
    return {
      id: result.connection.id,
      name: result.connection.name,
      provider: result.connection.provider,
      baseUrl: result.connection.base_url,
      apiFormat: result.connection.api_format,
      defaultModel: result.connection.default_model,
      models: result.connection.models,
      credential: result.connection.credential,
    };
  }

  private prepareCliTransport(agentId: string, session: AgentSession): string {
    const teammateDir = join(session.workDir, ".teammate");
    // Move an existing pre-Teammate wrapper directory once instead of orphaning agent state.
    const legacyDir = join(session.workDir, ".zano");
    if (!existsSync(teammateDir) && existsSync(legacyDir)) {
      renameSync(legacyDir, teammateDir);
    }
    ensurePrivateDirectory(teammateDir);

    const wrapperPath = join(teammateDir, "teammate");
    const bashPath = (path: string) =>
      `'${path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
    const cmdPath = (path: string) => `"${path.replace(/"/g, '""')}"`;
    let bashCommand: string;
    let windowsCommand: string;
    const packagedCliPath = process.env.TEAMMATE_CLI_PATH;

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
        const cliPath = req.resolve("@teammate/cli/dist/index.js");
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
    return teammateDir;
  }
}
