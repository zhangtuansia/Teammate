import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { ExecutionSession } from "@teammate/execution-core";
import { createLocalClient, LocalRealtimeChannel } from "@teammate/local-client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AgentManager } from "../src/agent-manager.js";
import { Bridge } from "../src/bridge.js";

function bareBridge() {
  return Object.create(Bridge.prototype) as Bridge;
}

test("agent activity uses a private workspace-scoped channel", () => {
  let topic = "";
  let options: unknown;
  let subscribed = false;
  const channel = {
    subscribe() {
      subscribed = true;
      return this;
    },
    send() {
      return Promise.resolve("ok");
    },
  };
  const client = {
    channel(nextTopic: string, nextOptions: unknown) {
      topic = nextTopic;
      options = nextOptions;
      return channel;
    },
    removeChannel() {
      return Promise.resolve("ok");
    },
  } as unknown as SupabaseClient;

  const manager = new AgentManager(
    process.cwd(),
    client,
    "https://example.supabase.co",
    "anon-key",
    "bridge-token",
    "",
    "server-1",
  );

  assert.equal(topic, "agent-activity:server-1");
  assert.deepEqual(options, {
    config: { private: true, broadcast: { ack: true, self: false } },
  });
  assert.equal(subscribed, true);
  manager.stopAll();
});

test("agent activity contains rejected sends and rate-limits logging", async () => {
  const channel = {
    subscribe() {
      return this;
    },
    send() {
      return Promise.reject(new Error("broadcast unavailable"));
    },
  };
  const client = {
    channel() {
      return channel;
    },
    removeChannel() {
      return Promise.resolve("ok");
    },
  } as unknown as SupabaseClient;
  const manager = new AgentManager(
    process.cwd(),
    client,
    "https://example.supabase.co",
    "anon-key",
    "bridge-token",
    "",
    "server-1",
  );
  const sendActivity = Reflect.get(manager, "sendActivity") as (
    agentId: string,
    activity: "idle",
    label: string,
    detail: string,
  ) => void;
  const originalConsoleError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => errors.push(args);

  try {
    sendActivity.call(manager, "agent-1", "idle", "Idle", "");
    sendActivity.call(manager, "agent-1", "idle", "Idle", "");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /Agent activity broadcast failed/);
  } finally {
    console.error = originalConsoleError;
    manager.stopAll();
  }
});

test("local broadcast acknowledgements reflect HTTP status", async () => {
  let responseStatus = 204;
  const server = createServer((_request, response) => {
    response.statusCode = responseStatus;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const channel = new LocalRealtimeChannel(
    "bridge-rpc-request:server-1:owner-1",
    {
      baseUrl: `http://127.0.0.1:${address.port}`,
      authorizationHeaders: () => ({ Authorization: "Bearer test-controller" }),
    } as never,
  );
  const message = {
    type: "broadcast",
    event: "rpc:request",
    payload: { serverId: "server-1", ownerId: "owner-1" },
  };

  try {
    assert.equal(await channel.send(message), "ok");
    responseStatus = 403;
    assert.equal(await channel.send(message), "error");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("local channels accept private options and isolate owner-scoped RPC topics", () => {
  const client = createLocalClient("http://127.0.0.1:1");
  const requestTopic = "bridge-rpc-request:server-1:owner-1";
  const requestChannel = client.channel(requestTopic, {
    config: { private: true, broadcast: { ack: true, self: false } },
  });
  const received: Record<string, unknown>[] = [];
  requestChannel.on("broadcast", { event: "rpc:request" }, ({ payload }) => {
    received.push(payload);
  });
  const event = {
    id: 1,
    kind: "broadcast" as const,
    event: "rpc:request",
    table_name: null,
    payload: { serverId: "server-1", ownerId: "owner-1" },
    record: null,
  };

  requestChannel.dispatch({ ...event, topic: "bridge-rpc-response:server-1:owner-1" });
  requestChannel.dispatch({ ...event, topic: "bridge-rpc-request:server-1:owner-2" });
  requestChannel.dispatch({ ...event, topic: requestTopic });

  assert.deepEqual(received, [event.payload]);
});

test("auth rotation removes every retained channel before resubscribing", async () => {
  const bridge = bareBridge();
  const channels = [
    { topic: "messages" },
    { topic: "agents" },
    { topic: "rpc-request" },
    { topic: "rpc-response" },
  ];
  const removed: unknown[] = [];
  let removeAllCalls = 0;
  const previousClient = {
    removeChannel: async (channel: unknown) => {
      removed.push(channel);
    },
    removeAllChannels: async () => {
      removeAllCalls += 1;
    },
  } as unknown as SupabaseClient;
  let managerToken = "";
  let managerClient: SupabaseClient | null = null;
  const resubscribed: string[] = [];

  Reflect.set(bridge, "config", {
    supabaseUrl: "http://127.0.0.1:54321",
    supabaseKey: "test-anon-key",
    authToken: "old-token",
    userId: "user-1",
    serverId: "server-1",
    agentsDir: "/tmp/unused",
    localMode: false,
  });
  Reflect.set(bridge, "supabase", previousClient);
  Reflect.set(bridge, "deliveriesChannel", channels[0]);
  Reflect.set(bridge, "agentChangesChannel", channels[1]);
  Reflect.set(bridge, "workspaceRpcRequestChannel", channels[2]);
  Reflect.set(bridge, "workspaceRpcResponseChannel", channels[3]);
  Reflect.set(bridge, "stopping", false);
  Reflect.set(bridge, "agentManager", {
    updateSupabaseClient(client: SupabaseClient, token: string) {
      managerClient = client;
      managerToken = token;
    },
  });
  Reflect.set(bridge, "subscribeToDeliveries", () => resubscribed.push("deliveries"));
  Reflect.set(bridge, "subscribeToAgentChanges", () => resubscribed.push("agents"));
  Reflect.set(bridge, "subscribeToWorkspaceRpc", () => resubscribed.push("rpc"));

  await bridge.updateAuthToken("new-token");

  assert.deepEqual(removed, channels);
  assert.equal(removeAllCalls, 1);
  assert.equal(managerToken, "new-token");
  assert.equal(managerClient, Reflect.get(bridge, "supabase"));
  assert.notEqual(managerClient, previousClient);
  assert.deepEqual(resubscribed, ["deliveries", "agents", "rpc"]);
  assert.equal(Reflect.get(bridge, "deliveriesChannel"), null);
  assert.equal(Reflect.get(bridge, "agentChangesChannel"), null);
  assert.equal(Reflect.get(bridge, "workspaceRpcRequestChannel"), null);
  assert.equal(Reflect.get(bridge, "workspaceRpcResponseChannel"), null);
});

test("membership removal immediately updates routing and drops empty channel metadata", () => {
  const bridge = bareBridge();
  const channelAgents = new Map([
    ["channel-1", new Set(["agent-1", "agent-2"])],
  ]);
  const channelTypes = new Map([["channel-1", "public"]]);
  const channelNames = new Map([["channel-1", "general"]]);
  Reflect.set(bridge, "channelAgents", channelAgents);
  Reflect.set(bridge, "channelTypes", channelTypes);
  Reflect.set(bridge, "channelNames", channelNames);
  const removeMembership = Reflect.get(bridge, "removeChannelMembership") as (
    channelId: string,
    memberId: string,
  ) => void;

  removeMembership.call(bridge, "channel-1", "agent-1");
  assert.deepEqual(channelAgents.get("channel-1"), new Set(["agent-2"]));
  assert.equal(channelTypes.get("channel-1"), "public");

  removeMembership.call(bridge, "channel-1", "agent-2");
  assert.equal(channelAgents.has("channel-1"), false);
  assert.equal(channelTypes.has("channel-1"), false);
  assert.equal(channelNames.has("channel-1"), false);
});

test("workspace RPC uses private owner-scoped directional channels", async () => {
  const bridge = bareBridge();
  const topics: string[] = [];
  const options: unknown[] = [];
  let requestHandler: ((message: { payload: Record<string, unknown> }) => Promise<void>) | null = null;
  const sent: Array<Record<string, unknown>> = [];
  Reflect.set(bridge, "config", { serverId: "server-1", userId: "owner-1" });
  Reflect.set(bridge, "agentRecords", new Map());
  Reflect.set(bridge, "supabase", {
    channel(nextTopic: string, nextOptions: unknown) {
      topics.push(nextTopic);
      options.push(nextOptions);
      const channel = {
        on(
          _kind: string,
          _filter: Record<string, unknown>,
          handler: (message: { payload: Record<string, unknown> }) => Promise<void>,
        ) {
          requestHandler = handler;
          return this;
        },
        async send(message: Record<string, unknown>) {
          sent.push(message);
          return "ok";
        },
        subscribe(callback?: (status: string) => void) {
          callback?.("SUBSCRIBED");
          return this;
        },
      };
      return channel;
    },
  });

  const subscribe = Reflect.get(bridge, "subscribeToWorkspaceRpc") as () => void;
  subscribe.call(bridge);

  assert.deepEqual(topics, [
    "bridge-rpc-request:server-1:owner-1",
    "bridge-rpc-response:server-1:owner-1",
  ]);
  assert.deepEqual(options, [
    { config: { private: true, broadcast: { ack: true, self: false } } },
    { config: { private: true, broadcast: { ack: true, self: false } } },
  ]);
  assert.ok(requestHandler);
  await requestHandler({
    payload: {
      requestId: "wrong-server",
      serverId: "server-2",
      ownerId: "owner-1",
      action: "read",
    },
  });
  assert.equal(sent.length, 0);

  await requestHandler({
    payload: {
      requestId: "wrong-owner",
      serverId: "server-1",
      ownerId: "owner-2",
      action: "read",
    },
  });
  assert.equal(sent.length, 0);

  await requestHandler({
    payload: {
      requestId: "right",
      serverId: "server-1",
      ownerId: "owner-1",
      action: "read",
    },
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: "broadcast",
    event: "rpc:response",
    payload: {
      requestId: "right",
      serverId: "server-1",
      ownerId: "owner-1",
      error: "Unknown action or agent",
    },
  });
});

test("managed agent deletion clears every route and delegates runtime removal", () => {
  const bridge = bareBridge();
  const agentRecords = new Map([
    ["agent-1", { id: "agent-1", display_name: "Deleted Agent" }],
  ]);
  const channelAgents = new Map([
    ["channel-1", new Set(["agent-1"])],
    ["channel-2", new Set(["agent-1", "agent-2"])],
  ]);
  const channelTypes = new Map([
    ["channel-1", "dm"],
    ["channel-2", "public"],
  ]);
  const channelNames = new Map([
    ["channel-1", "Deleted Agent"],
    ["channel-2", "general"],
  ]);
  const removed: string[] = [];
  Reflect.set(bridge, "agentRecords", agentRecords);
  Reflect.set(bridge, "channelAgents", channelAgents);
  Reflect.set(bridge, "channelTypes", channelTypes);
  Reflect.set(bridge, "channelNames", channelNames);
  Reflect.set(bridge, "agentManager", {
    removeAgent: (agentId: string) => removed.push(agentId),
  });
  const removeManagedAgent = Reflect.get(bridge, "removeManagedAgent") as (
    agentId: string,
  ) => void;

  removeManagedAgent.call(bridge, "agent-1");

  assert.equal(agentRecords.has("agent-1"), false);
  assert.equal(channelAgents.has("channel-1"), false);
  assert.deepEqual(channelAgents.get("channel-2"), new Set(["agent-2"]));
  assert.equal(channelTypes.has("channel-1"), false);
  assert.equal(channelNames.has("channel-1"), false);
  assert.deepEqual(removed, ["agent-1"]);
});

test("agent removal rejects queued work, stops its runtime, and tombstones delivery", async () => {
  const manager = Object.create(AgentManager.prototype) as AgentManager;
  let stopCalls = 0;
  const queued = new Promise<void>((resolve, reject) => {
    const execution = new ExecutionSession<{
      userMessage: string;
      channelId: string | null;
      resolve: () => void;
      reject: (error: Error) => void;
    }>();
    execution.enqueue({ userMessage: "pending", channelId: "channel-1", resolve, reject });
    Reflect.set(manager, "processes", new Map([
      [
        "agent-1",
        {
          heartbeatTimer: null,
          handle: {
            stop: () => {
              stopCalls += 1;
            },
          },
          execution,
        },
      ],
    ]));
  });
  const sessions = new Map([["agent-1", { id: "agent-1" }]]);
  const deliveryTails = new Map([["agent-1", Promise.resolve()]]);
  const removedAgentIds = new Set<string>();
  Reflect.set(manager, "sessions", sessions);
  Reflect.set(manager, "deliveryTails", deliveryTails);
  Reflect.set(manager, "removedAgentIds", removedAgentIds);

  manager.removeAgent("agent-1");

  await assert.rejects(queued, /Agent removed/);
  assert.equal(stopCalls, 1);
  assert.equal(sessions.has("agent-1"), false);
  assert.equal(deliveryTails.has("agent-1"), false);
  assert.equal(removedAgentIds.has("agent-1"), true);
  assert.equal(
    (Reflect.get(manager, "processes") as Map<string, unknown>).has("agent-1"),
    false,
  );
});
