import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ExecutionSession,
  type NormalizedExecutionEvent,
} from "@teammate/execution-core";
import { AgentManager } from "../src/agent-manager.js";
import { ExecutionRuntimeAdapter } from "../src/execution-runtime-adapter.js";
import type { RuntimeActivity } from "../src/runtimes/types.js";

interface VisibleMessage {
  id: string;
  content: string;
}

interface InsertedMessage {
  channel_id: string;
  sender_id: string;
  sender_type: string;
  content: string;
}

interface LookupRecord {
  columns: string;
  filters: Array<{ column: string; operator: "eq" | "gt"; value: unknown }>;
  order: { column: string; ascending: boolean } | null;
  limit: number;
}

function fakeMessageClient(options: {
  existing?: VisibleMessage[];
  lookupError?: string;
  insertError?: string;
} = {}) {
  const inserted: InsertedMessage[] = [];
  const lookups: LookupRecord[] = [];
  const client = {
    from(table: string) {
      assert.equal(table, "messages");
      let columns = "";
      let order: LookupRecord["order"] = null;
      const filters: LookupRecord["filters"] = [];
      const builder = {
        select(nextColumns: string) {
          columns = nextColumns;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push({ column, operator: "eq", value });
          return builder;
        },
        gt(column: string, value: unknown) {
          filters.push({ column, operator: "gt", value });
          return builder;
        },
        order(column: string, settings: { ascending: boolean }) {
          order = { column, ascending: settings.ascending };
          return builder;
        },
        async limit(value: number) {
          lookups.push({ columns, filters: [...filters], order, limit: value });
          return {
            data: options.existing || [],
            error: options.lookupError ? { message: options.lookupError } : null,
          };
        },
        async insert(message: InsertedMessage) {
          inserted.push(message);
          return {
            data: null,
            error: options.insertError ? { message: options.insertError } : null,
          };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, inserted, lookups };
}

function bareManager(client: SupabaseClient) {
  const manager = Object.create(AgentManager.prototype) as AgentManager;
  Reflect.set(manager, "supabase", client);
  return manager;
}

function persistOutput(manager: AgentManager) {
  return Reflect.get(manager, "persistOutputIfNeeded") as (
    agentId: string,
    channelId: string,
    output: string,
    turnStartSeq: number | null,
  ) => Promise<void>;
}

test("runtime final is persisted once when the CLI sent no visible message", async () => {
  const fake = fakeMessageClient();
  const manager = bareManager(fake.client);

  await persistOutput(manager).call(manager, "agent-a", "channel-a", "Final answer", 10);

  assert.deepEqual(fake.inserted, [{
    channel_id: "channel-a",
    sender_id: "agent-a",
    sender_type: "agent",
    content: "Final answer",
  }]);
  assert.deepEqual(fake.lookups[0]?.filters, [
    { column: "channel_id", operator: "eq", value: "channel-a" },
    { column: "sender_id", operator: "eq", value: "agent-a" },
    { column: "sender_type", operator: "eq", value: "agent" },
    { column: "seq", operator: "gt", value: 10 },
  ]);
});

test("any trailing runtime text is suppressed once the CLI replied this turn", async () => {
  const fake = fakeMessageClient({
    existing: [{ id: "message-1", content: "最终答复：\r\nFinal answer  \n" }],
  });
  const manager = bareManager(fake.client);

  await persistOutput(manager).call(manager, "agent-a", "channel-a", "Final answer", 10);

  assert.equal(fake.inserted.length, 0);
  assert.equal(fake.lookups[0]?.columns, "id");
  assert.equal(fake.lookups[0]?.limit, 1);
});

test("a reply-sent marker suppresses the closing summary the agent already sent", async () => {
  const fake = fakeMessageClient({
    existing: [{ id: "message-1", content: "北京今天 30°C，白天基本无雨。" }],
  });
  const manager = bareManager(fake.client);

  await persistOutput(manager).call(
    manager,
    "agent-a",
    "channel-a",
    "已经查好并发给用户了：今天北京最高 35°C。[teammate:reply-sent]",
    10,
  );

  assert.equal(fake.inserted.length, 0);
});

test("a reply-sent marker is ignored when the CLI never reached the channel", async () => {
  const fake = fakeMessageClient();
  const manager = bareManager(fake.client);

  await persistOutput(manager).call(
    manager,
    "agent-a",
    "channel-a",
    "[teammate:reply-sent] 北京今天 30°C。",
    10,
  );

  assert.equal(fake.inserted.length, 1);
  assert.equal(fake.inserted[0]?.content, "北京今天 30°C。");
});

test("marker-less closing narration is suppressed once the CLI replied", async () => {
  const narrations = [
    "已经把能力范围发给用户了。",
    "已经查好并发给用户了：今天北京最高35°C/最低24°C，整体偏热。",
    "Replied and saved a note about the user's observation on my reply length for future reference.",
  ];
  for (const narration of narrations) {
    const fake = fakeMessageClient({
      existing: [{ id: "message-1", content: "这是我通过 CLI 发出的正式回复。" }],
    });
    const manager = bareManager(fake.client);

    await persistOutput(manager).call(manager, "agent-a", "channel-a", narration, 10);

    assert.equal(fake.inserted.length, 0, `should suppress: ${narration}`);
  }
});

test("narration-shaped text is still persisted when the CLI never replied", async () => {
  const fake = fakeMessageClient();
  const manager = bareManager(fake.client);

  await persistOutput(manager).call(
    manager,
    "agent-a",
    "channel-a",
    "已经查好并发给用户了：今天北京最高35°C。",
    10,
  );

  assert.equal(fake.inserted.length, 1);
});

test("trailing text after an early CLI acknowledgement is also suppressed", async () => {
  // The prompt requires results to be reported through the CLI. Once the agent
  // has spoken in the channel this turn, trailing text is harness-facing and
  // posting it produced the double-reply bug (observed four times in a row).
  const fake = fakeMessageClient({
    existing: [{ id: "message-1", content: "收到，我先检查一下。" }],
  });
  const manager = bareManager(fake.client);

  await persistOutput(manager).call(
    manager,
    "agent-a",
    "channel-a",
    "检查完成：问题已经修复。",
    10,
  );

  assert.equal(fake.inserted.length, 0);
});

test("lookup failure still attempts the agent-bound visible fallback", async () => {
  const fake = fakeMessageClient({ lookupError: "lookup unavailable" });
  const manager = bareManager(fake.client);
  const originalConsoleError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => errors.push(args);

  try {
    await persistOutput(manager).call(manager, "agent-a", "channel-a", "Visible fallback", 10);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(fake.inserted.length, 1);
  assert.deepEqual(fake.inserted[0], {
    channel_id: "channel-a",
    sender_id: "agent-a",
    sender_type: "agent",
    content: "Visible fallback",
  });
  assert.match(String(errors[0]?.[0]), /Could not check visible runtime output/);
});

test("an ambient turn never posts trailing runtime text", async () => {
  const fake = fakeMessageClient();
  const manager = bareManager(fake.client);
  const execution = new ExecutionSession<never>();
  const started = execution.submit(undefined as never);
  assert.equal(started.kind, "started");
  if (started.kind !== "started") return;
  const managed = {
    handle: { isRunning: () => true, send: async () => undefined, stop: () => undefined },
    runtimeId: "codex",
    model: "default",
    connectionId: null,
    sessionId: null,
    busy: true,
    activity: "working",
    activityLabel: "Working",
    activityDetail: "",
    heartbeatTimer: null,
    execution,
    executionAdapter: new ExecutionRuntimeAdapter(1),
    activeChannelId: "channel-a",
    pendingOutput: "",
    turnStartSeq: 10,
    turnAmbient: true,
    eventTail: Promise.resolve(),
    restartAfterTurn: false,
  };
  Reflect.set(manager, "removedAgentIds", new Set<string>());
  Reflect.set(manager, "processes", new Map([["agent-a", managed]]));
  Reflect.set(manager, "sessions", new Map([["agent-a", { displayName: "Agent A" }]]));
  Reflect.set(manager, "activityChannel", { send: async () => "ok" });
  const handleEvent = Reflect.get(manager, "handleRuntimeEvent") as (
    agentId: string,
    target: typeof managed,
    event: NormalizedExecutionEvent<RuntimeActivity>,
  ) => Promise<void>;

  const turn = { generation: started.turn.generation, turnId: started.turn.turnId };
  await handleEvent.call(manager, "agent-a", managed, {
    type: "output",
    generation: 1,
    turn,
    text: "Decided this message was not for me.",
    final: false,
  });
  await handleEvent.call(manager, "agent-a", managed, {
    type: "terminal",
    generation: 1,
    turn,
    terminal: { status: "completed" },
  });

  assert.equal(fake.inserted.length, 0);
  assert.equal(fake.lookups.length, 0);
});

test("multiple runtime output and completion events persist only the final event once", async () => {
  const fake = fakeMessageClient();
  const manager = bareManager(fake.client);
  const execution = new ExecutionSession<never>();
  const started = execution.submit(undefined as never);
  assert.equal(started.kind, "started");
  if (started.kind !== "started") return;
  const managed = {
    handle: { isRunning: () => true, send: async () => undefined, stop: () => undefined },
    runtimeId: "codex",
    model: "default",
    connectionId: null,
    sessionId: null,
    busy: true,
    activity: "working",
    activityLabel: "Working",
    activityDetail: "",
    heartbeatTimer: null,
    execution,
    executionAdapter: new ExecutionRuntimeAdapter(1),
    activeChannelId: "channel-a",
    pendingOutput: "",
    turnStartSeq: 10,
    eventTail: Promise.resolve(),
    restartAfterTurn: false,
  };
  Reflect.set(manager, "removedAgentIds", new Set<string>());
  Reflect.set(manager, "processes", new Map([["agent-a", managed]]));
  Reflect.set(manager, "sessions", new Map([["agent-a", { displayName: "Agent A" }]]));
  Reflect.set(manager, "activityChannel", { send: async () => "ok" });
  const handleEvent = Reflect.get(manager, "handleRuntimeEvent") as (
    agentId: string,
    target: typeof managed,
    event: NormalizedExecutionEvent<RuntimeActivity>,
  ) => Promise<void>;

  const turn = { generation: started.turn.generation, turnId: started.turn.turnId };
  await handleEvent.call(manager, "agent-a", managed, {
    type: "output",
    generation: 1,
    turn,
    text: "Draft",
    final: false,
  });
  await handleEvent.call(manager, "agent-a", managed, {
    type: "output",
    generation: 1,
    turn,
    text: "Final answer",
    final: false,
  });
  const terminal = {
    type: "terminal" as const,
    generation: 1,
    turn,
    terminal: { status: "completed" as const },
  };
  await handleEvent.call(manager, "agent-a", managed, terminal);
  await handleEvent.call(manager, "agent-a", managed, terminal);

  assert.equal(fake.inserted.length, 1);
  assert.equal(fake.inserted[0]?.content, "Final answer");
  assert.equal(fake.lookups.length, 1);
});

test("a resolved send promise does not complete the execution turn", async () => {
  const manager = bareManager(fakeMessageClient().client);
  const execution = new ExecutionSession<never>();
  const handle = {
    runtimeId: "codex" as const,
    sessionId: null,
    isRunning: () => true,
    send: async () => undefined,
    stop: () => undefined,
  };
  const executionAdapter = new ExecutionRuntimeAdapter(1);
  executionAdapter.attach(handle);
  const managed = {
    handle,
    runtimeId: "codex" as const,
    model: "default",
    connectionId: null,
    thinkingLevel: "medium" as const,
    sessionId: null,
    busy: false,
    activity: "idle" as const,
    activityLabel: "Idle",
    activityDetail: "",
    heartbeatTimer: null,
    execution,
    executionAdapter,
    activeChannelId: null,
    pendingOutput: "",
    turnStartSeq: null,
    eventTail: Promise.resolve(),
    restartAfterTurn: false,
  };
  Reflect.set(manager, "removedAgentIds", new Set<string>());
  Reflect.set(manager, "processes", new Map([ ["agent-a", managed] ]));
  Reflect.set(manager, "sessions", new Map([ ["agent-a", { displayName: "Agent A" }] ]));
  Reflect.set(manager, "activityChannel", { send: async () => "ok" });
  const deliver = Reflect.get(manager, "deliverMessage") as (
    agentId: string,
    target: typeof managed,
    session: { displayName: string },
    message: string,
    channelId: string | null,
  ) => Promise<void>;

  await deliver.call(manager, "agent-a", managed, { displayName: "Agent A" }, "hello", null);

  assert.equal(execution.phase, "running");
  assert.equal(managed.busy, true);
  const turn = execution.activeTurn;
  assert.ok(turn);
  const terminal = executionAdapter.normalize({ type: "turn-complete" });
  assert.ok(terminal);
  const handleEvent = Reflect.get(manager, "handleRuntimeEvent") as (
    agentId: string,
    target: typeof managed,
    event: NormalizedExecutionEvent<RuntimeActivity>,
  ) => Promise<void>;
  await handleEvent.call(manager, "agent-a", managed, terminal);
  assert.equal(execution.phase, "idle");
  assert.equal(managed.busy, false);
});

test("unsupported cancellation fences the turn, clears the queue, and stops the backend", async () => {
  const manager = bareManager(fakeMessageClient().client);
  const execution = new ExecutionSession<{
    userMessage: string;
    channelId: string | null;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  let stopped = 0;
  const handle = {
    runtimeId: "codex" as const,
    sessionId: null,
    isRunning: () => true,
    send: async () => undefined,
    stop: () => { stopped += 1; },
  };
  const executionAdapter = new ExecutionRuntimeAdapter(1);
  executionAdapter.attach(handle);
  const started = execution.submit({
    userMessage: "active",
    channelId: null,
    resolve: () => undefined,
    reject: () => undefined,
  });
  assert.equal(started.kind, "started");
  if (started.kind !== "started") return;
  executionAdapter.bindTurn(started.turn);
  let rejectQueued!: (error: Error) => void;
  const queuedResult = new Promise<void>((resolve, reject) => {
    rejectQueued = reject;
  }).then(
    () => null,
    (error: unknown) => error,
  );
  execution.enqueue({
    userMessage: "queued",
    channelId: null,
    resolve: () => undefined,
    reject: rejectQueued,
  });
  const managed = {
    handle,
    runtimeId: "codex" as const,
    model: "default",
    connectionId: null,
    thinkingLevel: "medium" as const,
    sessionId: null,
    busy: true,
    activity: "working" as const,
    activityLabel: "Working",
    activityDetail: "",
    heartbeatTimer: null,
    execution,
    executionAdapter,
    activeChannelId: null,
    pendingOutput: "",
    turnStartSeq: null,
    eventTail: Promise.resolve(),
    restartAfterTurn: false,
  };
  const processes = new Map([ ["agent-a", managed] ]);
  Reflect.set(manager, "processes", processes);
  Reflect.set(manager, "activityChannel", { send: async () => "ok" });

  assert.equal(await manager.cancelAgentTurn("agent-a", "test stop"), true);
  const queuedError = await queuedResult;
  assert.ok(queuedError instanceof Error);
  assert.match(queuedError.message, /test stop/);
  assert.equal(execution.phase, "disposed");
  assert.equal(processes.has("agent-a"), false);
  assert.equal(stopped, 1);
});

test("a failed busy turn restarts its rotated runtime before draining queued work", async () => {
  const fake = fakeMessageClient();
  const manager = bareManager(fake.client);
  const order: string[] = [];
  const execution = new ExecutionSession<{
    userMessage: string;
    channelId: string | null;
    resolve: () => void;
    reject: () => void;
  }>();
  const started = execution.submit({
    userMessage: "active",
    channelId: "channel-a",
    resolve: () => undefined,
    reject: () => undefined,
  });
  assert.equal(started.kind, "started");
  if (started.kind !== "started") return;
  execution.enqueue({
    userMessage: "queued",
    channelId: "channel-a",
    resolve: () => undefined,
    reject: () => undefined,
  });
  const managed = {
    handle: { isRunning: () => true, send: async () => undefined, stop: () => undefined },
    runtimeId: "codex",
    model: "default",
    connectionId: null,
    sessionId: null,
    busy: true,
    activity: "working",
    activityLabel: "Working",
    activityDetail: "",
    heartbeatTimer: null,
    execution,
    executionAdapter: new ExecutionRuntimeAdapter(1),
    activeChannelId: null,
    pendingOutput: "",
    turnStartSeq: null,
    eventTail: Promise.resolve(),
    restartAfterTurn: true,
  };
  Reflect.set(manager, "removedAgentIds", new Set<string>());
  Reflect.set(manager, "processes", new Map([["agent-a", managed]]));
  Reflect.set(manager, "sessions", new Map([["agent-a", { displayName: "Agent A" }]]));
  Reflect.set(manager, "activityChannel", { send: async () => "ok" });
  Reflect.set(manager, "restartRuntime", async () => {
    order.push("restart");
    managed.restartAfterTurn = false;
    return managed;
  });
  Reflect.set(manager, "drainQueue", () => { order.push("drain"); });
  const handleEvent = Reflect.get(manager, "handleRuntimeEvent") as (
    agentId: string,
    target: typeof managed,
    event: NormalizedExecutionEvent<RuntimeActivity>,
  ) => Promise<void>;

  await handleEvent.call(manager, "agent-a", managed, {
    type: "terminal",
    generation: 1,
    turn: { generation: 1, turnId: started.turn.turnId },
    terminal: { status: "failed", message: "fake failure" },
  });

  assert.deepEqual(order, ["restart", "drain"]);
});

test("a failed replacement rejects every queued turn and removes the stopped handle", async () => {
  const manager = Object.create(AgentManager.prototype) as AgentManager;
  let stopped = 0;
  let rejectQueued!: (error: Error) => void;
  const queuedResult = new Promise<void>((resolve, reject) => {
    rejectQueued = reject;
  }).then(
    () => null,
    (error: unknown) => error,
  );
  const managed = {
    heartbeatTimer: null,
    handle: {
      stop: () => { stopped += 1; },
    },
    execution: new ExecutionSession<{
      userMessage: string;
      channelId: string | null;
      resolve: () => void;
      reject: (error: Error) => void;
    }>(),
  };
  managed.execution.enqueue({
    userMessage: "queued",
    channelId: "channel-a",
    resolve: () => undefined,
    reject: rejectQueued,
  });
  const processes = new Map<string, unknown>([["agent-a", managed]]);
  Reflect.set(manager, "processes", processes);
  Reflect.set(manager, "sessions", new Map([["agent-a", { id: "agent-a" }]]));
  Reflect.set(manager, "removedAgentIds", new Set<string>());
  Reflect.set(manager, "supabase", {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { id: "agent-a" }, error: null }),
        }),
      }),
    }),
  });
  Reflect.set(manager, "startManagedRuntime", async () => {
    throw new Error("replacement failed");
  });
  const restartRuntime = Reflect.get(manager, "restartRuntime") as (
    agentId: string,
    previous: typeof managed,
  ) => Promise<void>;

  await assert.rejects(
    restartRuntime.call(manager, "agent-a", managed),
    /replacement failed/,
  );

  const queuedError = await queuedResult;
  assert.ok(queuedError instanceof Error);
  assert.match(queuedError.message, /replacement failed/);
  assert.equal(stopped, 1);
  assert.equal(processes.has("agent-a"), false);
  assert.equal(managed.execution.queueLength, 0);
});

test("a token rotation racing replacement is carried onto the new runtime", async () => {
  const manager = Object.create(AgentManager.prototype) as AgentManager;
  let stopped = 0;
  const previous = {
    heartbeatTimer: null,
    handle: { stop: () => { stopped += 1; } },
    execution: new ExecutionSession<never>(),
    restartAfterTurn: true,
  };
  const replacement = {
    ...previous,
    handle: { stop: () => undefined },
    restartAfterTurn: false,
  };
  const processes = new Map<string, unknown>([["agent-a", previous]]);
  Reflect.set(manager, "processes", processes);
  Reflect.set(manager, "sessions", new Map([["agent-a", { id: "agent-a" }]]));
  Reflect.set(manager, "removedAgentIds", new Set<string>());
  Reflect.set(manager, "supabase", {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { id: "agent-a" }, error: null }),
        }),
      }),
    }),
  });
  Reflect.set(manager, "startManagedRuntime", async () => {
    previous.restartAfterTurn = true;
    return replacement;
  });
  const restartRuntime = Reflect.get(manager, "restartRuntime") as (
    agentId: string,
    target: typeof previous,
  ) => Promise<typeof replacement>;

  const started = await restartRuntime.call(manager, "agent-a", previous);

  assert.equal(started, replacement);
  assert.equal(replacement.restartAfterTurn, true);
  assert.equal(processes.get("agent-a"), replacement);
  assert.equal(stopped, 1);
});

test("a hung dispatch times out once, rebuilds the backend, and drains queued work", async (t) => {
  const inserted: InsertedMessage[] = [];
  const client = {
    channel() {
      return {
        subscribe() {
          return this;
        },
        send() {
          return Promise.resolve("ok");
        },
      };
    },
    removeChannel() {
      return Promise.resolve("ok");
    },
    from(table: string) {
      if (table === "messages") {
        return {
          async insert(message: InsertedMessage) {
            inserted.push(message);
            return { data: null, error: null };
          },
        };
      }
      assert.equal(table, "agents");
      return {
        select() {
          return {
            eq() {
              return {
                async single() {
                  return { data: { id: "agent-a" }, error: null };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  const manager = new AgentManager(
    process.cwd(),
    client,
    "https://example.supabase.co",
    "anon-key",
    "controller-token",
    "",
    "server-a",
    "",
    {},
    undefined,
    { turnTimeoutMs: 15 },
  );
  t.after(() => manager.stopAll());
  const execution = new ExecutionSession<{
    userMessage: string;
    channelId: string | null;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  let stopped = 0;
  let rebuilds = 0;
  const handle = {
    runtimeId: "codex" as const,
    sessionId: null,
    isRunning: () => true,
    send: () => new Promise<void>(() => undefined),
    stop: () => { stopped += 1; },
  };
  const executionAdapter = new ExecutionRuntimeAdapter(1);
  executionAdapter.attach(handle);
  const managed = {
    handle,
    runtimeId: "codex" as const,
    model: "default",
    connectionId: null,
    thinkingLevel: "medium" as const,
    sessionId: null,
    busy: false,
    activity: "idle" as const,
    activityLabel: "Idle",
    activityDetail: "",
    heartbeatTimer: null,
    execution,
    executionAdapter,
    activeChannelId: null as string | null,
    pendingOutput: "",
    turnStartSeq: null,
    eventTail: Promise.resolve(),
    restartAfterTurn: false,
  };
  const processes = new Map<string, typeof managed>([["agent-a", managed]]);
  Reflect.set(manager, "processes", processes);
  Reflect.set(manager, "sessions", new Map([[
    "agent-a",
    { id: "agent-a", name: "agent-a", displayName: "Agent A", workDir: process.cwd() },
  ]]));
  Reflect.set(manager, "removedAgentIds", new Set<string>());
  Reflect.set(manager, "activityChannel", { send: async () => "ok" });
  Reflect.set(manager, "loadLatestMessageSeq", async () => 12);

  const dispatched: string[] = [];
  Reflect.set(manager, "sendToAgentNow", async (
    _agentId: string,
    message: string,
  ) => {
    dispatched.push(message);
  });
  Reflect.set(manager, "startManagedRuntime", async (
    _agentId: string,
    _session: unknown,
    _agent: unknown,
    reusedExecution: typeof execution,
  ) => {
    rebuilds += 1;
    const replacementHandle = {
      ...handle,
      send: async () => undefined,
      stop: () => undefined,
    };
    const replacementAdapter = new ExecutionRuntimeAdapter(reusedExecution.generation);
    replacementAdapter.attach(replacementHandle);
    return {
      ...managed,
      handle: replacementHandle,
      busy: false,
      execution: reusedExecution,
      executionAdapter: replacementAdapter,
      eventTail: Promise.resolve(),
      restartAfterTurn: false,
    };
  });

  const deliver = Reflect.get(manager, "deliverMessage") as (
    agentId: string,
    target: typeof managed,
    session: { displayName: string },
    message: string,
    channelId: string | null,
  ) => Promise<void>;
  await Promise.race([
    deliver.call(manager, "agent-a", managed, { displayName: "Agent A" }, "hung", "channel-a"),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("dispatch promise was treated as a turn terminal")), 100);
    }),
  ]);
  const timedOutTurn = execution.activeTurn;
  assert.ok(timedOutTurn);

  const resolved: string[] = [];
  for (const message of ["queued-1", "queued-2"]) {
    execution.enqueue({
      userMessage: message,
      channelId: "channel-a",
      resolve: () => resolved.push(message),
      reject: () => undefined,
    });
  }

  const deadline = Date.now() + 1_000;
  while ((inserted.length < 1 || dispatched.length < 1) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(stopped, 1);
  assert.equal(rebuilds, 1);
  assert.equal(execution.generation, 2);
  // Same-channel queued messages merge into one dispatched turn.
  assert.deepEqual(dispatched, ["queued-1\n\nqueued-2"]);
  assert.deepEqual(resolved, ["queued-1", "queued-2"]);
  assert.equal(execution.queueLength, 0);
  assert.equal(inserted.length, 1);
  assert.match(inserted[0]?.content || "", /AI response timed out/);
  assert.match(inserted[0]?.content || "", /check the model connection|choose another model/);

  const handleEvent = Reflect.get(manager, "handleRuntimeEvent") as (
    agentId: string,
    target: typeof managed,
    event: NormalizedExecutionEvent<RuntimeActivity>,
  ) => Promise<void>;
  await handleEvent.call(manager, "agent-a", managed, {
    type: "terminal",
    generation: timedOutTurn.generation,
    turn: timedOutTurn,
    terminal: { status: "completed" },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(inserted.length, 1);
  assert.equal(rebuilds, 1);
});
