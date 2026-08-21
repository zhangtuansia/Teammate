import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createLocalClient, type LocalClient } from "@teammate/local-client";
import { Bridge } from "../src/bridge.js";

const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";
const LOCAL_SERVER_ID = "00000000-0000-4000-8000-000000001001";
const LOCAL_AGENT_ID = "00000000-0000-4000-8000-000000002001";
const LOCAL_DM_ID = "00000000-0000-4000-8000-000000003001";
const LOCAL_CHANNEL_ID = "00000000-0000-4000-8000-000000003002";

interface Delivery {
  message_id: string;
  agent_id: string;
  server_id: string;
  channel_id: string;
  status: "pending" | "processing" | "completed" | "skipped" | "failed";
  attempts: number;
  claim_token: string | null;
  claimed_by: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string;
  last_error: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkspaceHumanMemberForTest {
  id: string;
  display_name: string;
  agent_count: number;
  is_current_user: boolean;
}

interface LocalHarness {
  client: LocalClient;
  baseUrl: string;
  databasePath: string;
  stop: () => Promise<void>;
}

const harnessControllerCredentials = new Map<string, string>();

async function unusedPort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startLocalHarness(
  prepareDatabase?: (databasePath: string) => void | Promise<void>,
): Promise<LocalHarness> {
  const directory = await mkdtemp(join(tmpdir(), "teammate-delivery-test-"));
  const databasePath = join(directory, "local.db");
  await prepareDatabase?.(databasePath);
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const controllerCredential = randomBytes(32).toString("base64url");
  const source = new URL("../../local-server/src/index.ts", import.meta.url);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), source.pathname], {
    cwd: new URL("../../..", import.meta.url).pathname,
    env: {
      ...process.env,
      TEAMMATE_LOCAL_DB: databasePath,
      TEAMMATE_LOCAL_PORT: String(port),
      TEAMMATE_LOCAL_CONTROLLER_TOKEN: controllerCredential,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Local server exited during startup (${child.exitCode}): ${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) break;
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.ok, true, `Local server did not become healthy: ${output}`);
  } catch (error) {
    await stopChild(child);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  harnessControllerCredentials.set(baseUrl, controllerCredential);
  return {
    client: createLocalClient(baseUrl, controllerCredential),
    baseUrl,
    databasePath,
    stop: async () => {
      harnessControllerCredentials.delete(baseUrl);
      await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function withLocalHarness(
  run: (harness: LocalHarness) => Promise<void>,
  prepareDatabase?: (databasePath: string) => void | Promise<void>,
) {
  const harness = await startLocalHarness(prepareDatabase);
  try {
    await run(harness);
  } finally {
    await harness.client.removeAllChannels();
    await harness.stop();
  }
}

function assertQuery(result: { error: { message: string } | null }) {
  assert.equal(result.error, null, result.error?.message);
}

function assertQueryError(
  result: { error: { message: string } | null },
  pattern: RegExp,
) {
  assert.ok(result.error, "Expected the local query to be rejected");
  assert.match(result.error.message, pattern);
}

async function localRpc<T>(
  client: LocalClient,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await client.rpc(name, args);
  assertQuery(result);
  return result.data as T;
}

async function localApi<T>(
  baseUrl: string,
  path: string,
  method: "POST" | "DELETE",
  body?: Record<string, unknown>,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${harnessControllerCredentials.get(baseUrl) || ""}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json() as T & { error?: string };
  assert.equal(response.ok, true, payload.error || `${method} ${path} failed`);
  return payload;
}

async function insertHumanMessage(client: LocalClient, channelId = LOCAL_DM_ID, content = "hello") {
  const result = await client
    .from("messages")
    .insert({
      channel_id: channelId,
      sender_id: LOCAL_USER_ID,
      sender_type: "human",
      content,
    })
    .select("*")
    .single();
  assertQuery(result);
  assert.ok(result.data);
  return result.data as { id: string; seq: number };
}

async function loadDelivery(client: LocalClient, messageId: string) {
  const result = await client
    .from("message_deliveries")
    .select("*")
    .eq("message_id", messageId)
    .eq("agent_id", LOCAL_AGENT_ID)
    .maybeSingle();
  assertQuery(result);
  return result.data as Delivery | null;
}

function deliveryBridge(
  client: LocalClient,
  sendToAgent: (agentId: string, prompt: string, channelId: string | null) => Promise<void>,
) {
  const bridge = Object.create(Bridge.prototype) as Bridge;
  Reflect.set(bridge, "config", {
    userId: LOCAL_USER_ID,
    serverId: LOCAL_SERVER_ID,
    localMode: true,
  });
  Reflect.set(bridge, "supabase", client as unknown as SupabaseClient);
  Reflect.set(bridge, "agentManager", { sendToAgent });
  Reflect.set(bridge, "agentRecords", new Map([[LOCAL_AGENT_ID, {
    id: LOCAL_AGENT_ID,
    name: "local-assistant",
    display_name: "Local Assistant",
    description: null,
    system_prompt: null,
    runtime: "codex",
    model: "default",
    status: "online",
    owner_id: LOCAL_USER_ID,
    server_id: LOCAL_SERVER_ID,
  }]]));
  Reflect.set(bridge, "channelAgents", new Map([
    [LOCAL_DM_ID, new Set([LOCAL_AGENT_ID])],
    [LOCAL_CHANNEL_ID, new Set([LOCAL_AGENT_ID])],
  ]));
  Reflect.set(bridge, "channelTypes", new Map([
    [LOCAL_DM_ID, "dm"],
    [LOCAL_CHANNEL_ID, "public"],
  ]));
  Reflect.set(bridge, "channelNames", new Map([
    [LOCAL_DM_ID, "Local Assistant"],
    [LOCAL_CHANNEL_ID, "general"],
  ]));
  Reflect.set(bridge, "bridgeInstanceId", randomUUID());
  Reflect.set(bridge, "locallyDelivered", new Set<string>());
  Reflect.set(bridge, "stopping", false);
  Reflect.set(bridge, "deliveryPumpRequested", false);
  Reflect.set(bridge, "deliveryPumpPromise", null);
  return bridge;
}

async function drain(bridge: Bridge) {
  const method = Reflect.get(bridge, "drainDeliveryQueue") as () => Promise<void>;
  await method.call(bridge);
}

test("agent mention routing prefers a unique stable handle and fails closed on collisions", () => {
  const bridge = Object.create(Bridge.prototype) as Bridge;
  const parse = Reflect.get(bridge, "parseMentionedAgents") as (
    content: string,
    agents: Map<string, { id: string; name: string; display_name: string }>,
  ) => Set<string>;

  const stableWins = new Map([
    ["agent-a", { id: "agent-a", name: "alpha", display_name: "Bob" }],
    ["agent-b", { id: "agent-b", name: "bob", display_name: "Other" }],
  ]);
  assert.deepEqual(
    [...parse.call(bridge, "@BoB take this", stableWins)],
    ["agent-b"],
    "a display alias must not shadow another agent's stable handle",
  );

  const duplicateDisplay = new Map([
    ["agent-c", { id: "agent-c", name: "charlie", display_name: "Sam" }],
    ["agent-d", { id: "agent-d", name: "delta", display_name: "Sam" }],
  ]);
  assert.deepEqual([...parse.call(bridge, "@Sam take this", duplicateDisplay)], []);

  const duplicateStable = new Map([
    ["agent-e", { id: "agent-e", name: "Echo", display_name: "First" }],
    ["agent-f", { id: "agent-f", name: "echo", display_name: "Second" }],
  ]);
  assert.deepEqual([...parse.call(bridge, "@echo take this", duplicateStable)], []);
});

test("human message insert creates one durable delivery and offline catch-up sends it once", async () => {
  await withLocalHarness(async ({ client }) => {
    const message = await insertHumanMessage(client);
    const queued = await loadDelivery(client, message.id);
    assert.equal(queued?.status, "pending");
    assert.equal(queued?.attempts, 0);

    const sends: string[] = [];
    const bridge = deliveryBridge(client, async (_agentId, prompt) => {
      sends.push(prompt);
    });
    await drain(bridge);
    await drain(bridge);

    assert.equal(sends.length, 1);
    assert.match(sends[0], /hello/);
    assert.equal((await loadDelivery(client, message.id))?.status, "completed");

    const restartedSends: string[] = [];
    const restarted = deliveryBridge(client, async (_agentId, prompt) => {
      restartedSends.push(prompt);
    });
    await drain(restarted);
    assert.equal(restartedSends.length, 0);
  });
});

test("two concurrent claimants produce exactly one winner", async () => {
  await withLocalHarness(async ({ client }) => {
    const message = await insertHumanMessage(client);
    const candidate = await loadDelivery(client, message.id);
    assert.ok(candidate);
    const first = deliveryBridge(client, async () => undefined);
    const second = deliveryBridge(client, async () => undefined);
    const firstClaim = Reflect.get(first, "claimDelivery") as (row: Delivery) => Promise<Delivery | null>;
    const secondClaim = Reflect.get(second, "claimDelivery") as (row: Delivery) => Promise<Delivery | null>;

    const results = await Promise.all([
      firstClaim.call(first, candidate),
      secondClaim.call(second, candidate),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await loadDelivery(client, message.id))?.attempts, 1);
  });
});

test("a lease renewed after candidate load cannot be reclaimed from stale state", async () => {
  await withLocalHarness(async ({ client }) => {
    const message = await insertHumanMessage(client);
    const pending = await loadDelivery(client, message.id);
    assert.ok(pending);
    const incumbent = deliveryBridge(client, async () => undefined);
    const contender = deliveryBridge(client, async () => undefined);
    const claimIncumbent = Reflect.get(incumbent, "claimDelivery") as (
      row: Delivery,
    ) => Promise<Delivery | null>;
    const claimed = await claimIncumbent.call(incumbent, pending);
    assert.ok(claimed);

    const expire = await client
      .from("message_deliveries")
      .update({ lease_expires_at: new Date(0).toISOString() })
      .eq("message_id", message.id)
      .eq("agent_id", LOCAL_AGENT_ID)
      .eq("claim_token", claimed.claim_token);
    assertQuery(expire);
    const staleExpiredCandidate = await loadDelivery(client, message.id);
    assert.ok(staleExpiredCandidate);

    const renew = Reflect.get(incumbent, "renewDeliveryLease") as (
      row: Delivery,
    ) => Promise<boolean>;
    assert.equal(await renew.call(incumbent, claimed), true);

    const reclaim = Reflect.get(contender, "claimDelivery") as (
      row: Delivery,
    ) => Promise<Delivery | null>;
    assert.equal(await reclaim.call(contender, staleExpiredCandidate), null);
    const current = await loadDelivery(client, message.id);
    assert.equal(current?.claim_token, claimed.claim_token);
    assert.equal(current?.attempts, 1);
  });
});

test("same process replay after completion-state loss does not hand the prompt to the runtime twice", async () => {
  await withLocalHarness(async ({ client }) => {
    const message = await insertHumanMessage(client);
    let sends = 0;
    const bridge = deliveryBridge(client, async () => { sends += 1; });
    await drain(bridge);
    assert.equal(sends, 1);

    const reset = await client
      .from("message_deliveries")
      .update({
        status: "pending",
        claim_token: null,
        claimed_by: null,
        lease_expires_at: null,
        next_attempt_at: new Date(0).toISOString(),
      })
      .eq("message_id", message.id)
      .eq("agent_id", LOCAL_AGENT_ID);
    assertQuery(reset);
    await drain(bridge);

    assert.equal(sends, 1);
    assert.equal((await loadDelivery(client, message.id))?.status, "completed");
  });
});

test("channel policy: sole agent and mentions deliver, cold multi-agent rows skip, conversations continue", async () => {
  await withLocalHarness(async ({ client, baseUrl }) => {
    // A channel with one agent behaves like a shared DM: no @ required.
    const soleAgent = await insertHumanMessage(client, LOCAL_CHANNEL_ID, "status update only");
    const assigned = await insertHumanMessage(
      client,
      LOCAL_CHANNEL_ID,
      "@Local Assistant Task #7 assigned to you: verify delivery",
    );
    const prompts: string[] = [];
    const bridge = deliveryBridge(client, async (_agentId, prompt) => {
      prompts.push(prompt);
    });
    await drain(bridge);

    assert.equal((await loadDelivery(client, soleAgent.id))?.status, "completed");
    assert.equal((await loadDelivery(client, assigned.id))?.status, "completed");
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /delivery=unmentioned/);
    assert.match(prompts[0], /status update only/);
    assert.doesNotMatch(prompts[1], /delivery=unmentioned/);
    assert.match(prompts[1], /Task #7 assigned to you/);

    // A second agent joins the channel: cold unmentioned rows now skip.
    const created = await localApi<{ agent: { id: string } }>(
      baseUrl,
      "/api/agents",
      "POST",
      {
        display_name: "Helper",
        server_id: LOCAL_SERVER_ID,
        runtime: "codex",
        model: "default",
      },
    );
    const channelRow = await client
      .from("channels")
      .select("name, description")
      .eq("id", LOCAL_CHANNEL_ID)
      .single();
    assertQuery(channelRow);
    const channelInfo = channelRow.data as { name: string; description: string | null };
    await localRpc(client, "set_channel_agent_members", {
      channel_uuid: LOCAL_CHANNEL_ID,
      agent_ids: [LOCAL_AGENT_ID, created.agent.id],
      channel_name: channelInfo.name,
      channel_description: channelInfo.description,
      expected_agent_ids: [LOCAL_AGENT_ID],
      expected_channel_name: channelInfo.name,
      expected_channel_description: channelInfo.description,
    });

    const cold = await insertHumanMessage(client, LOCAL_CHANNEL_ID, "anyone seen the report?");
    await drain(bridge);
    assert.equal((await loadDelivery(client, cold.id))?.status, "skipped");

    // After the agent speaks in the flow, the human's follow-up continues
    // their conversation without a new mention.
    assertQuery(await client.from("messages").insert({
      channel_id: LOCAL_CHANNEL_ID,
      sender_id: LOCAL_AGENT_ID,
      sender_type: "agent",
      content: "On it — checking the report now.",
    }));
    const followUp = await insertHumanMessage(client, LOCAL_CHANNEL_ID, "great, ping me when done");
    await drain(bridge);
    assert.equal((await loadDelivery(client, followUp.id))?.status, "completed");
    assert.match(prompts.at(-1) || "", /delivery=unmentioned/);
    assert.match(prompts.at(-1) || "", /ping me when done/);

    // Redirecting to the other agent keeps this one out of the exchange.
    const redirected = await insertHumanMessage(client, LOCAL_CHANNEL_ID, "@Helper can you take this?");
    await drain(bridge);
    assert.equal((await loadDelivery(client, redirected.id))?.status, "skipped");

    // When another agent spoke more recently, they own the exchange.
    assertQuery(await client.from("messages").insert({
      channel_id: LOCAL_CHANNEL_ID,
      sender_id: created.agent.id,
      sender_type: "agent",
      content: "Sure, taking it.",
    }));
    const towardHelper = await insertHumanMessage(client, LOCAL_CHANNEL_ID, "thanks, how long will it take?");
    await drain(bridge);
    assert.equal((await loadDelivery(client, towardHelper.id))?.status, "skipped");

    // Agents can @mention each other: the mentioned agent gets the delivery,
    // and the sender never receives its own message.
    const agentMention = await client.from("messages").insert({
      channel_id: LOCAL_CHANNEL_ID,
      sender_id: created.agent.id,
      sender_type: "agent",
      content: "@Local Assistant please review the report draft",
    }).select("id").single();
    assertQuery(agentMention);
    const agentMentionId = (agentMention.data as { id: string }).id;
    await drain(bridge);
    assert.equal((await loadDelivery(client, agentMentionId))?.status, "completed");
    assert.match(prompts.at(-1) || "", /please review the report draft/);
    const senderRow = await client
      .from("message_deliveries")
      .select("agent_id")
      .eq("message_id", agentMentionId)
      .eq("agent_id", created.agent.id)
      .maybeSingle();
    assertQuery(senderRow);
    assert.equal(senderRow.data, null);

    // An unmentioned agent message never triggers other agents.
    const agentChatter = await client.from("messages").insert({
      channel_id: LOCAL_CHANNEL_ID,
      sender_id: created.agent.id,
      sender_type: "agent",
      content: "Draft is coming along nicely.",
    }).select("id").single();
    assertQuery(agentChatter);
    await drain(bridge);
    assert.equal(
      (await loadDelivery(client, (agentChatter.data as { id: string }).id))?.status,
      "skipped",
    );
  });
});

test("runtime hand-off failures retry three times and then become terminal", async () => {
  await withLocalHarness(async ({ client }) => {
    const message = await insertHumanMessage(client);
    let attempts = 0;
    const bridge = deliveryBridge(client, async () => {
      attempts += 1;
      throw new Error("fixture runtime rejected delivery");
    });

    for (let expected = 1; expected <= 3; expected += 1) {
      await drain(bridge);
      const delivery = await loadDelivery(client, message.id);
      assert.equal(delivery?.attempts, expected);
      if (expected < 3) {
        assert.equal(delivery?.status, "pending");
        const ready = await client
          .from("message_deliveries")
          .update({ next_attempt_at: new Date(0).toISOString() })
          .eq("message_id", message.id)
          .eq("agent_id", LOCAL_AGENT_ID);
        assertQuery(ready);
      } else {
        assert.equal(delivery?.status, "failed");
        assert.match(delivery?.last_error || "", /fixture runtime rejected/);
      }
    }
    assert.equal(attempts, 3);
    await drain(bridge);
    assert.equal(attempts, 3);
  });
});

test("editing a channel preserves assignments for retained agent members", async () => {
  await withLocalHarness(async ({ client }) => {
    const channelResult = await client
      .from("channels")
      .select("name, description")
      .eq("id", LOCAL_CHANNEL_ID)
      .single();
    assertQuery(channelResult);
    const channel = channelResult.data as { name: string; description: string | null };
    const createdTask = await localRpc<{ task: { id: string } }>(
      client,
      "create_task_with_message",
      {
        channel_uuid: LOCAL_CHANNEL_ID,
        task_title: "retained assignment",
        parent_task_uuid: null,
        assignee_uuid: LOCAL_AGENT_ID,
        assignee_type: "agent",
        assignee_mention_name: "local-assistant",
        sender_agent_uuid: null,
      },
    );

    await localRpc(client, "set_channel_agent_members", {
      channel_uuid: LOCAL_CHANNEL_ID,
      agent_ids: [LOCAL_AGENT_ID],
      channel_name: `${channel.name}-renamed`,
      channel_description: channel.description,
      expected_agent_ids: [LOCAL_AGENT_ID],
      expected_channel_name: channel.name,
      expected_channel_description: channel.description,
    });

    const taskResult = await client
      .from("tasks")
      .select("assignee_id, assignee_type")
      .eq("id", createdTask.task.id)
      .single();
    assertQuery(taskResult);
    assert.equal((taskResult.data as { assignee_id: string }).assignee_id, LOCAL_AGENT_ID);
    assert.equal((taskResult.data as { assignee_type: string }).assignee_type, "agent");
  });
});

test("membership removal skips queued work and another workspace is never claimed", async () => {
  await withLocalHarness(async ({ client }) => {
    const removedMessage = await insertHumanMessage(client, LOCAL_CHANNEL_ID, "@local-assistant queued");
    const channelResult = await client
      .from("channels")
      .select("name, description")
      .eq("id", LOCAL_CHANNEL_ID)
      .single();
    assertQuery(channelResult);
    const channel = channelResult.data as { name: string; description: string | null };
    await localRpc(client, "set_channel_agent_members", {
      channel_uuid: LOCAL_CHANNEL_ID,
      agent_ids: [],
      channel_name: channel.name,
      channel_description: channel.description,
      expected_agent_ids: [LOCAL_AGENT_ID],
      expected_channel_name: channel.name,
      expected_channel_description: channel.description,
    });
    let sends = 0;
    const bridge = deliveryBridge(client, async () => { sends += 1; });
    await drain(bridge);
    assert.equal(sends, 0);
    assert.equal((await loadDelivery(client, removedMessage.id))?.status, "skipped");

    const directServer = await client.from("servers").insert({
      name: "Other",
      slug: `other-${randomUUID()}`,
      owner_id: LOCAL_USER_ID,
    });
    assertQueryError(directServer, /workspace API/i);
    const forgedMessage = await client.from("messages").insert({
      channel_id: LOCAL_CHANNEL_ID,
      sender_id: LOCAL_USER_ID,
      sender_type: "system",
      content: "@Local Assistant cross server",
    });
    assertQueryError(forgedMessage, /atomic task API/i);
    const forged = await client.from("message_deliveries").insert({
      message_id: removedMessage.id,
      agent_id: LOCAL_AGENT_ID,
      server_id: randomUUID(),
      channel_id: LOCAL_CHANNEL_ID,
    });
    assertQueryError(forged, /task notification API/i);
    await drain(bridge);
    assert.equal(sends, 0);
  });
});

test("local storage rejects cross-workspace identities and cascades message-owned tasks", async () => {
  await withLocalHarness(async ({ client, baseUrl }) => {
    const createdWorkspace = await localApi<{
      server: { id: string };
      channel: { id: string };
    }>(baseUrl, "/api/servers", "POST", {
      name: "Other workspace",
      slug: `other-${randomUUID()}`,
    });
    const otherServerId = createdWorkspace.server.id;
    const otherChannelId = createdWorkspace.channel.id;

    const invalidChannelName = `invalid-${randomUUID()}`;
    const invalidChannel = await client.rpc("create_channel_with_members", {
      server_uuid: otherServerId,
      channel_name: invalidChannelName,
      channel_description: null,
      channel_type: "private",
      selected_members: [{ member_id: LOCAL_AGENT_ID, member_type: "agent" }],
    });
    assertQueryError(invalidChannel, /workspace/i);
    const rolledBackChannel = await client
      .from("channels")
      .select("id")
      .eq("server_id", otherServerId)
      .eq("name", invalidChannelName)
      .maybeSingle();
    assertQuery(rolledBackChannel);
    assert.equal(rolledBackChannel.data, null, "invalid atomic channel creation must roll back fully");

    const otherMessage = await insertHumanMessage(
      client,
      otherChannelId,
      "other workspace message",
    );

    const crossThread = await client.from("messages").insert({
      channel_id: LOCAL_CHANNEL_ID,
      sender_id: LOCAL_USER_ID,
      sender_type: "human",
      content: "cross workspace reply",
      thread_parent_id: otherMessage.id,
    });
    assertQueryError(crossThread, /Thread parent must belong to the same channel/i);

    const forgedAgentMessage = await client.from("messages").insert({
      channel_id: otherChannelId,
      sender_id: LOCAL_AGENT_ID,
      sender_type: "agent",
      content: "cross workspace sender",
    });
    assertQueryError(forgedAgentMessage, /Message sender is not a valid channel member/i);

    const crossDocument = await client.from("documents").insert({
      server_id: otherServerId,
      title: "Cross workspace artifact",
      content: "must fail",
      created_by: LOCAL_USER_ID,
      generated_by_agent_id: LOCAL_AGENT_ID,
    });
    assertQueryError(crossDocument, /Document generator does not belong/i);

    const directTask = await client.from("tasks").insert({
      message_id: otherMessage.id,
      channel_id: otherChannelId,
    });
    assertQueryError(directTask, /atomic task API/i);

    const createdTask = await localRpc<{
      message: { id: string };
      task: { id: string };
    }>(client, "create_task_with_message", {
      channel_uuid: LOCAL_CHANNEL_ID,
      task_title: "task that will be deleted",
      parent_task_uuid: null,
      assignee_uuid: null,
      assignee_type: null,
      assignee_mention_name: null,
      sender_agent_uuid: null,
    });

    const crossTask = await client.rpc("create_task_with_message", {
      channel_uuid: otherChannelId,
      task_title: "cross workspace assignment",
      parent_task_uuid: null,
      assignee_uuid: LOCAL_AGENT_ID,
      assignee_type: "agent",
      assignee_mention_name: "local-assistant",
      sender_agent_uuid: null,
    });
    assertQueryError(crossTask, /channel member|mention/i);

    assertQuery(await client.from("messages").delete().eq("id", createdTask.message.id));
    const deletedTask = await client.from("tasks").select("id").eq("id", createdTask.task.id).maybeSingle();
    assertQuery(deletedTask);
    assert.equal(deletedTask.data, null, "deleting a task message must not leave an orphan task");
  });
});

test("local agent API deletion atomically clears dependent memberships and assignments", async () => {
  await withLocalHarness(async ({ client, baseUrl }) => {
    const provisioned = await localApi<{
      agent: { id: string; name: string };
      channel: { id: string };
    }>(baseUrl, "/api/agents", "POST", {
      display_name: "Temporary agent",
      server_id: LOCAL_SERVER_ID,
      runtime: "codex",
      model: "default",
    });
    const agentId = provisioned.agent.id;
    const dmChannelId = provisioned.channel.id;

    const channelResult = await client
      .from("channels")
      .select("name, description")
      .eq("id", LOCAL_CHANNEL_ID)
      .single();
    assertQuery(channelResult);
    const channel = channelResult.data as { name: string; description: string | null };
    await localRpc(client, "set_channel_agent_members", {
      channel_uuid: LOCAL_CHANNEL_ID,
      agent_ids: [LOCAL_AGENT_ID, agentId],
      channel_name: channel.name,
      channel_description: channel.description,
      expected_agent_ids: [LOCAL_AGENT_ID],
      expected_channel_name: channel.name,
      expected_channel_description: channel.description,
    });
    assertQuery(await client.from("messages").insert({
      channel_id: dmChannelId,
      sender_id: LOCAL_USER_ID,
      sender_type: "human",
      content: "temporary direct message",
    }));

    const createdTask = await localRpc<{ task: { id: string } }>(
      client,
      "create_task_with_message",
      {
        channel_uuid: LOCAL_CHANNEL_ID,
        task_title: "assigned work",
        parent_task_uuid: null,
        assignee_uuid: agentId,
        assignee_type: "agent",
        assignee_mention_name: provisioned.agent.name,
        sender_agent_uuid: null,
      },
    );
    const taskId = createdTask.task.id;

    const documentResult = await client.from("documents").insert({
      server_id: LOCAL_SERVER_ID,
      title: "Temporary output",
      content: "kept after the generator is deleted",
      created_by: LOCAL_USER_ID,
      generated_by_agent_id: agentId,
    }).select("id").single();
    assertQuery(documentResult);
    const documentId = (documentResult.data as { id: string }).id;

    const directDelete = await client.from("agents").delete().eq("id", agentId);
    assertQueryError(directDelete, /agent API/i);
    await localApi<{ success: true }>(baseUrl, `/api/agents/${agentId}`, "DELETE");

    const [agent, dm, serverMembership, channelMembership, task, document] = await Promise.all([
      client.from("agents").select("id").eq("id", agentId).maybeSingle(),
      client.from("channels").select("id").eq("id", dmChannelId).maybeSingle(),
      client.from("server_members").select("member_id").eq("member_id", agentId).maybeSingle(),
      client.from("channel_members").select("member_id").eq("member_id", agentId).maybeSingle(),
      client.from("tasks").select("assignee_id, assignee_type").eq("id", taskId).maybeSingle(),
      client.from("documents").select("generated_by_agent_id").eq("id", documentId).maybeSingle(),
    ]);
    for (const result of [agent, dm, serverMembership, channelMembership, task, document]) {
      assertQuery(result);
    }
    assert.equal(agent.data, null);
    assert.equal(dm.data, null);
    assert.equal(serverMembership.data, null);
    assert.equal(channelMembership.data, null);
    assert.ok(task.data);
    assert.equal((task.data as { assignee_id: string | null }).assignee_id, null);
    assert.equal((task.data as { assignee_type: string | null }).assignee_type, null);
    assert.ok(document.data);
    assert.equal((document.data as { generated_by_agent_id: string | null }).generated_by_agent_id, null);
  });
});

test("local workspace leave clears hidden channel access and cannot orphan a DM", async () => {
  await withLocalHarness(async ({ client, databasePath }) => {
    const serverId = randomUUID();
    const ownerId = randomUUID();
    const channelId = randomUUID();
    const messageId = randomUUID();
    const taskId = randomUUID();
    const keyId = randomUUID();
    const now = new Date().toISOString();
    const raw = new DatabaseSync(databasePath);
    raw.exec("PRAGMA busy_timeout = 5000");
    raw.prepare(
      "INSERT INTO profiles (id, email, display_name, avatar_url, created_at) VALUES (?, ?, ?, NULL, ?)",
    ).run(ownerId, "owner@example.test", "Workspace Owner", now);
    raw.prepare(
      "INSERT INTO servers (id, name, slug, description, owner_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)",
    ).run(serverId, "Shared", `shared-${serverId}`, ownerId, now);
    raw.prepare(
      "INSERT INTO server_members (server_id, member_id, member_type, role, joined_at) VALUES (?, ?, 'human', 'member', ?)",
    ).run(serverId, LOCAL_USER_ID, now);
    raw.prepare(
      "INSERT INTO channels (id, name, description, type, created_by, server_id, created_at) VALUES (?, 'private', NULL, 'private', ?, ?, ?)",
    ).run(channelId, ownerId, serverId, now);
    raw.prepare(
      "INSERT INTO channel_members (channel_id, member_id, member_type, joined_at) VALUES (?, ?, 'human', ?)",
    ).run(channelId, LOCAL_USER_ID, now);
    raw.prepare(
      "INSERT INTO messages (id, channel_id, sender_id, sender_type, content, seq, thread_parent_id, created_at, updated_at) VALUES (?, ?, ?, 'human', 'assigned before leave', 1, NULL, ?, ?)",
    ).run(messageId, channelId, LOCAL_USER_ID, now, now);
    raw.prepare(
      "INSERT INTO tasks (id, message_id, channel_id, task_number, title, status, parent_task_id, assignee_id, assignee_type, created_at, updated_at) VALUES (?, ?, ?, 900001, 'assigned before leave', 'todo', NULL, ?, 'human', ?, ?)",
    ).run(taskId, messageId, channelId, LOCAL_USER_ID, now, now);
    raw.prepare(
      "INSERT INTO machine_keys (id, key_prefix, key_hash, key_value, user_id, server_id, name, created_at, last_used_at) VALUES (?, ?, ?, NULL, ?, ?, 'Leave test', ?, NULL)",
    ).run(
      keyId,
      `tm_${keyId.slice(0, 8)}`,
      keyId.replaceAll("-", "").padEnd(64, "0"),
      LOCAL_USER_ID,
      serverId,
      now,
    );
    raw.close();

    const dmLeave = await client
      .from("channel_members")
      .delete()
      .eq("channel_id", LOCAL_DM_ID)
      .eq("member_id", LOCAL_USER_ID);
    assertQueryError(dmLeave, /agent lifecycle/i);

    assertQuery(
      await client
        .from("server_members")
        .delete()
        .eq("server_id", serverId)
        .eq("member_id", LOCAL_USER_ID),
    );
    const [membership, task] = await Promise.all([
      client.from("channel_members").select("member_id").eq("channel_id", channelId).maybeSingle(),
      client.from("tasks").select("assignee_id, assignee_type").eq("id", taskId).single(),
    ]);
    assertQuery(membership);
    assertQuery(task);
    assert.equal(membership.data, null);
    assert.ok(task.data);
    assert.equal(
      (task.data as { assignee_id: string | null }).assignee_id,
      null,
      "workspace leave must clear task assignment through the channel-member invariant",
    );
    assert.equal((task.data as { assignee_type: string | null }).assignee_type, null);

    const rejoin = new DatabaseSync(databasePath);
    rejoin.exec("PRAGMA busy_timeout = 5000");
    assert.equal(
      Number((rejoin.prepare(
        "SELECT count(*) AS count FROM machine_keys WHERE server_id = ? AND user_id = ?",
      ).get(serverId, LOCAL_USER_ID) as { count: number }).count),
      0,
      "workspace leave must revoke runtime keys in the same transaction",
    );
    rejoin.prepare(
      "INSERT INTO server_members (server_id, member_id, member_type, role, joined_at) VALUES (?, ?, 'human', 'member', ?)",
    ).run(serverId, LOCAL_USER_ID, new Date().toISOString());
    rejoin.close();
    const restored = await client
      .from("channel_members")
      .select("member_id")
      .eq("channel_id", channelId)
      .eq("member_id", LOCAL_USER_ID)
      .maybeSingle();
    assertQuery(restored);
    assert.equal(restored.data, null, "rejoining must not restore prior private-channel access");
    const restoredKey = await client
      .from("machine_keys")
      .select("id")
      .eq("id", keyId)
      .maybeSingle();
    assertQuery(restoredKey);
    assert.equal(restoredKey.data, null, "rejoining must not reactivate a departed member's key");
  });
});

test("workspace owner removal atomically evicts a human and owned agents without crossing workspaces", async () => {
  await withLocalHarness(async ({ client, databasePath }) => {
    const targetHumanId = randomUUID();
    const targetAgentId = randomUUID();
    const targetDmId = randomUUID();
    const targetDmMessageId = randomUUID();
    const sharedHumanTaskMessageId = randomUUID();
    const sharedAgentTaskMessageId = randomUUID();
    const sharedHumanTaskId = randomUUID();
    const sharedAgentTaskId = randomUUID();
    const localDocumentId = randomUUID();
    const localKeyId = randomUUID();
    const otherOwnerId = randomUUID();
    const otherServerId = randomUUID();
    const otherAgentId = randomUUID();
    const otherChannelId = randomUUID();
    const otherMessageId = randomUUID();
    const otherTaskId = randomUUID();
    const otherDocumentId = randomUUID();
    const otherKeyId = randomUUID();
    const now = new Date().toISOString();
    const raw = new DatabaseSync(databasePath);
    raw.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    try {
      const insertProfile = raw.prepare(
        "INSERT INTO profiles (id, email, display_name, avatar_url, created_at) VALUES (?, ?, ?, NULL, ?)",
      );
      insertProfile.run(targetHumanId, "departing@example.test", "Departing member", now);
      insertProfile.run(targetAgentId, "collision-human@example.test", "Collision human", now);
      insertProfile.run(otherOwnerId, "other-owner@example.test", "Other owner", now);
      raw.prepare(
        "INSERT INTO server_members (server_id, member_id, member_type, role, joined_at) VALUES (?, ?, 'human', 'member', ?)",
      ).run(LOCAL_SERVER_ID, targetHumanId, now);
      raw.prepare(
        `INSERT INTO agents
          (id, name, display_name, description, system_prompt, runtime, model, status, owner_id, server_id, workspace_path, session_id, runtime_session_id, runtime_session_runtime, connection_id, avatar_url, created_at)
         VALUES (?, 'departing-agent', 'Departing agent', NULL, NULL, 'codex', 'default', 'online', ?, ?, NULL, 'session', 'runtime-session', 'codex', NULL, NULL, ?)`,
      ).run(targetAgentId, targetHumanId, LOCAL_SERVER_ID, now);
      raw.prepare(
        "INSERT INTO server_members (server_id, member_id, member_type, role, joined_at) VALUES (?, ?, 'agent', 'member', ?)",
      ).run(LOCAL_SERVER_ID, targetAgentId, now);
      raw.prepare(
        "INSERT INTO channel_members (channel_id, member_id, member_type, joined_at) VALUES (?, ?, ?, ?)",
      ).run(LOCAL_CHANNEL_ID, targetHumanId, "human", now);
      raw.prepare(
        "INSERT INTO channel_members (channel_id, member_id, member_type, joined_at) VALUES (?, ?, ?, ?)",
      ).run(LOCAL_CHANNEL_ID, targetAgentId, "agent", now);
      raw.prepare(
        "INSERT INTO channels (id, name, description, type, created_by, server_id, created_at) VALUES (?, 'departing-dm', NULL, 'dm', ?, ?, ?)",
      ).run(targetDmId, targetHumanId, LOCAL_SERVER_ID, now);
      const insertChannelMember = raw.prepare(
        "INSERT INTO channel_members (channel_id, member_id, member_type, joined_at) VALUES (?, ?, ?, ?)",
      );
      insertChannelMember.run(targetDmId, targetHumanId, "human", now);
      insertChannelMember.run(targetDmId, targetAgentId, "agent", now);
      const insertMessage = raw.prepare(
        "INSERT INTO messages (id, channel_id, sender_id, sender_type, content, seq, thread_parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      );
      insertMessage.run(targetDmMessageId, targetDmId, targetHumanId, "human", "private history", 1, now, now);
      insertMessage.run(sharedHumanTaskMessageId, LOCAL_CHANNEL_ID, LOCAL_USER_ID, "human", "human assignment", 900001, now, now);
      insertMessage.run(sharedAgentTaskMessageId, LOCAL_CHANNEL_ID, LOCAL_USER_ID, "human", "agent assignment", 900002, now, now);
      const insertTask = raw.prepare(
        "INSERT INTO tasks (id, message_id, channel_id, task_number, title, status, parent_task_id, assignee_id, assignee_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'todo', NULL, ?, ?, ?, ?)",
      );
      insertTask.run(sharedHumanTaskId, sharedHumanTaskMessageId, LOCAL_CHANNEL_ID, 910001, "human assignment", targetHumanId, "human", now, now);
      insertTask.run(sharedAgentTaskId, sharedAgentTaskMessageId, LOCAL_CHANNEL_ID, 910002, "agent assignment", targetAgentId, "agent", now, now);
      raw.prepare(
        "INSERT INTO documents (id, server_id, title, content, created_by, generated_by_agent_id, created_at, updated_at) VALUES (?, ?, 'Departing output', '', ?, ?, ?, ?)",
      ).run(localDocumentId, LOCAL_SERVER_ID, LOCAL_USER_ID, targetAgentId, now, now);
      raw.prepare(
        "INSERT INTO machine_keys (id, key_prefix, key_hash, key_value, user_id, server_id, name, created_at, last_used_at) VALUES (?, ?, ?, NULL, ?, ?, 'Departing runtime', ?, ?)",
      ).run(localKeyId, `tm_${localKeyId.slice(0, 8)}`, localKeyId.replaceAll("-", "").padEnd(64, "0"), targetHumanId, LOCAL_SERVER_ID, now, now);

      raw.prepare(
        "INSERT INTO servers (id, name, slug, description, owner_id, created_at) VALUES (?, 'Other workspace', ?, NULL, ?, ?)",
      ).run(otherServerId, `other-${otherServerId}`, otherOwnerId, now);
      raw.prepare(
        "INSERT INTO server_members (server_id, member_id, member_type, role, joined_at) VALUES (?, ?, 'human', 'owner', ?)",
      ).run(otherServerId, otherOwnerId, now);
      raw.prepare(
        "INSERT INTO server_members (server_id, member_id, member_type, role, joined_at) VALUES (?, ?, 'human', 'member', ?)",
      ).run(otherServerId, targetHumanId, now);
      raw.prepare(
        "INSERT INTO server_members (server_id, member_id, member_type, role, joined_at) VALUES (?, ?, 'human', 'member', ?)",
      ).run(otherServerId, targetAgentId, now);
      raw.prepare(
        `INSERT INTO agents
          (id, name, display_name, description, system_prompt, runtime, model, status, owner_id, server_id, workspace_path, session_id, runtime_session_id, runtime_session_runtime, connection_id, avatar_url, created_at)
         VALUES (?, 'other-agent', 'Other agent', NULL, NULL, 'codex', 'default', 'online', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      ).run(otherAgentId, targetHumanId, otherServerId, now);
      raw.prepare(
        "INSERT INTO server_members (server_id, member_id, member_type, role, joined_at) VALUES (?, ?, 'agent', 'member', ?)",
      ).run(otherServerId, otherAgentId, now);
      raw.prepare(
        "INSERT INTO channels (id, name, description, type, created_by, server_id, created_at) VALUES (?, 'other-channel', NULL, 'private', ?, ?, ?)",
      ).run(otherChannelId, otherOwnerId, otherServerId, now);
      insertChannelMember.run(otherChannelId, targetHumanId, "human", now);
      insertChannelMember.run(otherChannelId, targetAgentId, "human", now);
      insertChannelMember.run(otherChannelId, otherAgentId, "agent", now);
      insertMessage.run(otherMessageId, otherChannelId, targetHumanId, "human", "other workspace history", 1, now, now);
      insertTask.run(otherTaskId, otherMessageId, otherChannelId, 910003, "other workspace history", otherAgentId, "agent", now, now);
      raw.prepare(
        "INSERT INTO documents (id, server_id, title, content, created_by, generated_by_agent_id, created_at, updated_at) VALUES (?, ?, 'Other output', '', ?, ?, ?, ?)",
      ).run(otherDocumentId, otherServerId, targetHumanId, otherAgentId, now, now);
      raw.prepare(
        "INSERT INTO machine_keys (id, key_prefix, key_hash, key_value, user_id, server_id, name, created_at, last_used_at) VALUES (?, ?, ?, NULL, ?, ?, 'Other runtime', ?, ?)",
      ).run(otherKeyId, `tm_${otherKeyId.slice(0, 8)}`, otherKeyId.replaceAll("-", "").padEnd(64, "0"), targetHumanId, otherServerId, now, now);
      raw.exec("COMMIT");
    } catch (error) {
      raw.exec("ROLLBACK");
      raw.close();
      throw error;
    }
    raw.close();

    const listed = await localRpc<WorkspaceHumanMemberForTest[]>(
      client,
      "list_workspace_human_members",
      { server_uuid: LOCAL_SERVER_ID },
    );
    const departing = listed.find((member) => member.id === targetHumanId);
    assert.equal(departing?.display_name, "Departing member");
    assert.equal(Number(departing?.agent_count), 1);

    const result = await localRpc<{
      removed: boolean;
      agents_removed: number;
      machine_keys_revoked: number;
      dm_channels_removed: number;
      task_assignments_cleared: number;
      deliveries_removed: number;
    }>(client, "remove_server_human_member", {
      server_uuid: LOCAL_SERVER_ID,
      human_uuid: targetHumanId,
    });
    assert.equal(result.removed, true);
    assert.equal(result.agents_removed, 1);
    assert.equal(result.machine_keys_revoked, 1);
    assert.equal(result.dm_channels_removed, 1);
    assert.equal(result.task_assignments_cleared, 2);
    assert.ok(result.deliveries_removed >= 1);

    const localChecks = await Promise.all([
      client.from("server_members").select("member_id").eq("server_id", LOCAL_SERVER_ID).eq("member_id", targetHumanId).maybeSingle(),
      client.from("agents").select("id").eq("id", targetAgentId).maybeSingle(),
      client.from("channels").select("id").eq("id", targetDmId).maybeSingle(),
      client.from("channel_members").select("member_id").eq("channel_id", LOCAL_CHANNEL_ID).eq("member_id", targetHumanId).maybeSingle(),
      client.from("machine_keys").select("id").eq("id", localKeyId).maybeSingle(),
      client.from("tasks").select("assignee_id, assignee_type").eq("id", sharedHumanTaskId).single(),
      client.from("tasks").select("assignee_id, assignee_type").eq("id", sharedAgentTaskId).single(),
      client.from("documents").select("generated_by_agent_id").eq("id", localDocumentId).single(),
      client.from("messages").select("id").eq("id", sharedHumanTaskMessageId).single(),
    ]);
    for (const check of localChecks) assertQuery(check);
    for (const index of [0, 1, 2, 3, 4]) assert.equal(localChecks[index].data, null);
    for (const index of [5, 6]) {
      assert.equal((localChecks[index].data as { assignee_id: string | null }).assignee_id, null);
      assert.equal((localChecks[index].data as { assignee_type: string | null }).assignee_type, null);
    }
    assert.equal(
      (localChecks[7].data as { generated_by_agent_id: string | null }).generated_by_agent_id,
      null,
    );
    assert.ok(localChecks[8].data, "shared channel history must be preserved");

    const otherChecks = await Promise.all([
      client.from("server_members").select("member_id").eq("server_id", otherServerId).eq("member_id", targetHumanId).single(),
      client.from("server_members").select("member_id").eq("server_id", otherServerId).eq("member_id", targetAgentId).eq("member_type", "human").single(),
      client.from("channel_members").select("member_id").eq("channel_id", otherChannelId).eq("member_id", targetAgentId).eq("member_type", "human").single(),
      client.from("agents").select("id").eq("id", otherAgentId).single(),
      client.from("machine_keys").select("id").eq("id", otherKeyId).single(),
      client.from("tasks").select("assignee_id, assignee_type").eq("id", otherTaskId).single(),
      client.from("documents").select("generated_by_agent_id").eq("id", otherDocumentId).single(),
    ]);
    for (const check of otherChecks) {
      assertQuery(check);
      assert.ok(check.data);
    }
    assert.equal((otherChecks[5].data as { assignee_id: string }).assignee_id, otherAgentId);
    assert.equal(
      (otherChecks[6].data as { generated_by_agent_id: string }).generated_by_agent_id,
      otherAgentId,
    );

    const idempotent = await localRpc<{ removed: boolean; agents_removed: number }>(
      client,
      "remove_server_human_member",
      { server_uuid: LOCAL_SERVER_ID, human_uuid: targetHumanId },
    );
    assert.deepEqual(idempotent, {
      removed: false,
      agents_removed: 0,
      machine_keys_revoked: 0,
      dm_channels_removed: 0,
      task_assignments_cleared: 0,
      deliveries_removed: 0,
    });

    const ownerRemoval = await client.rpc("remove_server_human_member", {
      server_uuid: LOCAL_SERVER_ID,
      human_uuid: LOCAL_USER_ID,
    });
    assertQueryError(ownerRemoval, /owner cannot be removed/i);
    const wrongOwner = await client.rpc("remove_server_human_member", {
      server_uuid: otherServerId,
      human_uuid: targetHumanId,
    });
    assertQueryError(wrongOwner, /Only the workspace owner/i);
  });
});

test("local runtime keys use the atomic workspace-membership RPC", async () => {
  await withLocalHarness(async ({ client }) => {
    const keyHash = "a".repeat(64);
    const created = await localRpc<{
      id: string;
      key_prefix: string;
      name: string;
      created_at: string;
    }>(client, "create_current_user_machine_key", {
      server_uuid: LOCAL_SERVER_ID,
      machine_key_prefix: "tm_deadbeef",
      machine_key_hash: keyHash,
      machine_key_name: "  Test runtime  ",
    });
    assert.match(created.id, /^[0-9a-f-]{36}$/i);
    assert.equal(created.key_prefix, "tm_deadbeef");
    assert.equal(created.name, "Test runtime");
    assert.ok(Number.isFinite(Date.parse(created.created_at)));

    const stored = await client
      .from("machine_keys")
      .select("id, key_prefix, key_hash, key_value, user_id, server_id, name")
      .eq("id", created.id)
      .single();
    assertQuery(stored);
    assert.deepEqual(stored.data, {
      id: created.id,
      key_prefix: "tm_deadbeef",
      key_hash: keyHash,
      key_value: null,
      user_id: LOCAL_USER_ID,
      server_id: LOCAL_SERVER_ID,
      name: "Test runtime",
      created_at: created.created_at,
      last_used_at: null,
    });

    const directHash = "b".repeat(64);
    const direct = await client.from("machine_keys").insert({
      id: randomUUID(),
      key_prefix: "tm_cafebabe",
      key_hash: directHash,
      key_value: null,
      user_id: LOCAL_USER_ID,
      server_id: LOCAL_SERVER_ID,
      name: "Bypass attempt",
      created_at: new Date().toISOString(),
      last_used_at: null,
    });
    assertQueryError(direct, /atomic runtime key API/i);
    const bypassed = await client
      .from("machine_keys")
      .select("id")
      .eq("key_hash", directHash)
      .maybeSingle();
    assertQuery(bypassed);
    assert.equal(bypassed.data, null);

    const wrongWorkspace = await client.rpc("create_current_user_machine_key", {
      server_uuid: randomUUID(),
      machine_key_prefix: "tm_01234567",
      machine_key_hash: "c".repeat(64),
      machine_key_name: "No access",
    });
    assertQueryError(wrongWorkspace, /workspace access denied/i);
  });
});

test("concurrent local inserts keep channel sequences unique and hosted schema serializes by channel", async () => {
  const schema = await readFile(
    new URL("../../../packages/db/src/schema.sql", import.meta.url),
    "utf8",
  );
  assert.match(schema, /pg_advisory_xact_lock\(hashtextextended\(new\.channel_id::text, 0\)\)/);
  assert.match(schema, /create unique index idx_messages_channel_seq on public\.messages\(channel_id, seq\)/);

  await withLocalHarness(async ({ client }) => {
    const inserted = await Promise.all(
      Array.from({ length: 20 }, (_, index) => insertHumanMessage(
        client,
        LOCAL_CHANNEL_ID,
        `concurrent ${index}`,
      )),
    );
    const sequences = inserted.map((message) => message.seq);
    assert.equal(new Set(sequences).size, sequences.length);
  });
});

test("local upgrade repairs legacy duplicate channel sequences before adding the unique index", async () => {
  await withLocalHarness(async ({ client }) => {
    const existing = await client
      .from("messages")
      .select("id, seq")
      .eq("channel_id", LOCAL_CHANNEL_ID)
      .order("seq", { ascending: true });
    assertQuery(existing);
    const sequences = (existing.data as Array<{ seq: number }>).map((message) => message.seq);
    assert.deepEqual(sequences, [1, 2]);

    const next = await insertHumanMessage(client, LOCAL_CHANNEL_ID, "after migration");
    assert.equal(next.seq, 3);
  }, (databasePath) => {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        content TEXT NOT NULL,
        seq INTEGER NOT NULL,
        thread_parent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO messages VALUES
        ('legacy-1', '${LOCAL_CHANNEL_ID}', '${LOCAL_USER_ID}', 'human', 'one', 1, NULL, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
        ('legacy-2', '${LOCAL_CHANNEL_ID}', '${LOCAL_USER_ID}', 'human', 'two', 1, NULL, '2025-01-01T00:00:01.000Z', '2025-01-01T00:00:01.000Z');
    `);
    legacy.close();
  });
});

test("local upgrade materializes task title, description, archive state, and active index", async () => {
  const taskId = randomUUID();
  const messageId = randomUUID();
  await withLocalHarness(async ({ client, databasePath }) => {
    const upgraded = await client
      .from("tasks")
      .select("title, description, archived_at")
      .eq("id", taskId)
      .single();
    assertQuery(upgraded);
    assert.ok(upgraded.data);
    assert.equal((upgraded.data as { title: string }).title, "Legacy task title");
    assert.equal((upgraded.data as { description: string }).description, "");
    assert.equal((upgraded.data as { archived_at: string | null }).archived_at, null);

    const raw = new DatabaseSync(databasePath);
    const columns = raw.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "title"));
    assert.ok(columns.some((column) => column.name === "description"));
    assert.ok(columns.some((column) => column.name === "archived_at"));
    const activeIndex = raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_local_tasks_channel_active'",
    ).get() as { sql: string } | undefined;
    assert.match(activeIndex?.sql || "", /where archived_at is null/i);
    raw.close();
  }, (databasePath) => {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        content TEXT NOT NULL,
        seq INTEGER NOT NULL,
        thread_parent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL,
        task_number INTEGER NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'todo',
        parent_task_id TEXT,
        assignee_id TEXT,
        assignee_type TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.prepare(
      `INSERT INTO messages
        (id, channel_id, sender_id, sender_type, content, seq, thread_parent_id, created_at, updated_at)
       VALUES (?, ?, ?, 'human', ?, 1, NULL, ?, ?)`,
    ).run(
      messageId,
      LOCAL_CHANNEL_ID,
      LOCAL_USER_ID,
      "\n  Legacy task title  \nOriginal audit body",
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
    );
    legacy.prepare(
      `INSERT INTO tasks
        (id, message_id, channel_id, task_number, status, parent_task_id, assignee_id, assignee_type, created_at, updated_at)
       VALUES (?, ?, ?, 42, 'todo', NULL, NULL, NULL, ?, ?)`,
    ).run(
      taskId,
      messageId,
      LOCAL_CHANNEL_ID,
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
    );
    legacy.close();
  });
});

test("final hosted RLS keeps agent-owner read access after the documented SQL order", async () => {
  const [schema, machineKeys, finalRls] = await Promise.all([
    readFile(new URL("../../../packages/db/src/schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/db/src/machine-keys.sql", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/db/src/fix-rls.sql", import.meta.url), "utf8"),
  ]);
  for (const sql of [schema, machineKeys, finalRls]) {
    assert.match(sql, /FUNCTION public\.user_has_agent_in_channel/i);
    assert.match(sql, /OR public\.user_has_agent_in_channel\(channel_id\)/i);
  }
  assert.match(
    finalRls,
    /DROP POLICY IF EXISTS "Users can view channel memberships" ON public\.channel_members/i,
  );
  assert.match(
    finalRls,
    /DROP POLICY IF EXISTS "Users can view their channels" ON public\.channels/i,
  );
  assert.match(
    finalRls,
    /DROP POLICY IF EXISTS "Users can view messages in their channels" ON public\.messages/i,
  );
  assert.match(finalRls, /OR public\.user_has_agent_in_channel\(id\)/i);
});
