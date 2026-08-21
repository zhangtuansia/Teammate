import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalClient, type LocalClient } from "@teammate/local-client";

const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";
const LOCAL_SERVER_ID = "00000000-0000-4000-8000-000000001001";
const LOCAL_AGENT_ID = "00000000-0000-4000-8000-000000002001";
const LOCAL_CHANNEL_ID = "00000000-0000-4000-8000-000000003002";

interface LocalCapabilityHarness {
  baseUrl: string;
  controllerCredential: string;
  controller: LocalClient;
  connect: () => Promise<{
    token: string;
    agentTokens: Record<string, string>;
  }>;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
}

async function unusedPort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
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

async function startHarness(ttlMs = 45 * 60_000): Promise<LocalCapabilityHarness> {
  const directory = await mkdtemp(join(tmpdir(), "teammate-capability-test-"));
  const databasePath = join(directory, "local.db");
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const controllerCredential = randomBytes(32).toString("base64url");
  const source = new URL("../../local-server/src/index.ts", import.meta.url);
  let child: ChildProcess;
  let output = "";

  const launch = async () => {
    child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), source.pathname], {
      cwd: new URL("../../..", import.meta.url).pathname,
      env: {
        ...process.env,
        NODE_ENV: "test",
        TEAMMATE_LOCAL_DB: databasePath,
        TEAMMATE_LOCAL_PORT: String(port),
        TEAMMATE_LOCAL_CONTROLLER_TOKEN: controllerCredential,
        TEAMMATE_LOCAL_AGENT_CAPABILITY_TTL_MS: String(ttlMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Local server exited during startup (${child.exitCode}): ${output}`);
      }
      try {
        const response = await fetch(`${baseUrl}/api/ready`, {
          headers: { Authorization: `Bearer ${controllerCredential}` },
        });
        if (response.ok) return;
      } catch {
        // The isolated local service is still binding.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Local server did not become ready: ${output}`);
  };
  await launch();

  const connect = async () => {
    const response = await fetch(`${baseUrl}/api/bridge/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${controllerCredential}`,
      },
      body: JSON.stringify({ hostname: "capability-test" }),
    });
    const result = await response.json() as {
      token: string;
      agentTokens: Record<string, string>;
      error?: string;
    };
    assert.equal(response.ok, true, result.error || output);
    return result;
  };

  return {
    baseUrl,
    controllerCredential,
    controller: createLocalClient(baseUrl, controllerCredential),
    connect,
    restart: async () => {
      await stopChild(child);
      await launch();
    },
    stop: async () => {
      await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function withHarness(
  run: (harness: LocalCapabilityHarness) => Promise<void>,
  ttlMs?: number,
) {
  const harness = await startHarness(ttlMs);
  try {
    await run(harness);
  } finally {
    await harness.controller.removeAllChannels();
    await harness.stop();
  }
}

function controllerHeaders(harness: LocalCapabilityHarness) {
  return { Authorization: `Bearer ${harness.controllerCredential}` };
}

async function runLocalCli(
  harness: LocalCapabilityHarness,
  capability: string,
  args: string[],
) {
  const cli = new URL("../../../packages/cli/src/index.ts", import.meta.url);
  const child = spawn(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), cli.pathname, ...args],
    {
      cwd: new URL("../../..", import.meta.url).pathname,
      env: {
        ...process.env,
        TEAMMATE_AUTH_TOKEN: capability,
        TEAMMATE_LOCAL_SERVER_URL: harness.baseUrl,
        TEAMMATE_CLI_RPC_TIMEOUT_MS: "5000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([
    once(child, "exit").then(([exitCode]) => exitCode as number | null),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`CLI timed out: ${args.join(" ")}\n${output}`));
      }, 10_000);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  return { code, output };
}

test("local HTTP entry points fail closed and anonymous health is minimal", async () => {
  await withHarness(async (harness) => {
    const health = await fetch(`${harness.baseUrl}/health`);
    assert.deepEqual(await health.json(), { ok: true, mode: "local" });

    const ready = await fetch(`${harness.baseUrl}/api/ready`, {
      headers: controllerHeaders(harness),
    });
    assert.equal(ready.ok, true);
    assert.deepEqual(await ready.json(), {
      ok: true,
      mode: "local",
      protocolVersion: 2,
    });

    for (const request of [
      fetch(`${harness.baseUrl}/api/ready`),
      fetch(`${harness.baseUrl}/api/query`, { method: "POST", body: "{}" }),
      fetch(`${harness.baseUrl}/api/events`),
      fetch(`${harness.baseUrl}/api/broadcast`, { method: "POST", body: "{}" }),
      fetch(`${harness.baseUrl}/api/settings`),
      fetch(`${harness.baseUrl}/api/avatars/${randomUUID()}.png`),
    ]) {
      const response = await request;
      assert.equal(response.status, 401);
    }

    const invalid = await fetch(`${harness.baseUrl}/api/bridge/connect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${randomBytes(32).toString("base64url")}` },
    });
    assert.equal(invalid.status, 401);
  });
});

test("streamed JSON bodies over 4 MiB return 413 without taking down the service", async () => {
  await withHarness(async (harness) => {
    const oversized = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(`${harness.baseUrl}/api/query`, {
        method: "POST",
        headers: {
          ...controllerHeaders(harness),
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        },
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode || 0, body }));
      });
      request.on("error", reject);
      request.write('{"payload":"');
      for (let index = 0; index < 5; index += 1) {
        request.write(Buffer.alloc(1024 * 1024, 0x61));
      }
      request.end('"}');
    });

    assert.equal(oversized.status, 413);
    assert.match(
      String((JSON.parse(oversized.body) as { error?: { message?: string } }).error?.message),
      /4 MiB or smaller/,
    );
    const readyAfterRejection = await fetch(`${harness.baseUrl}/api/ready`, {
      headers: controllerHeaders(harness),
    });
    assert.equal(readyAfterRejection.ok, true);
  });
});

test("agent capabilities enforce identity, workspace, channel, RPC, event, and table scope", async () => {
  await withHarness(async (harness) => {
    const credentials = await harness.connect();
    assert.equal(credentials.token, harness.controllerCredential);
    const capability = credentials.agentTokens[LOCAL_AGENT_ID];
    assert.ok(capability?.startsWith("tm_local_agent_v1."));
    const agent = createLocalClient(harness.baseUrl, capability);

    const ownAgent = await agent.from("agents").select("id").eq("id", LOCAL_AGENT_ID).single();
    assert.equal(ownAgent.error, null);
    assert.equal((ownAgent.data as { id: string }).id, LOCAL_AGENT_ID);

    const forbiddenKeys = await agent.from("machine_keys").select("id");
    assert.match(forbiddenKeys.error?.message || "", /cannot read this table/i);
    const humanOnlyRpc = await agent.rpc("create_current_user_machine_key", {
      server_uuid: LOCAL_SERVER_ID,
      machine_key_prefix: "tm_deadbeef",
      machine_key_hash: "a".repeat(64),
      machine_key_name: "forged",
    });
    assert.match(humanOnlyRpc.error?.message || "", /human controller/i);

    const forgedSender = await agent.from("messages").insert({
      channel_id: LOCAL_CHANNEL_ID,
      sender_id: LOCAL_USER_ID,
      sender_type: "human",
      content: "forged",
    });
    assert.match(forgedSender.error?.message || "", /identity or channel/i);
    const ownMessage = await agent.from("messages").insert({
      channel_id: LOCAL_CHANNEL_ID,
      sender_id: LOCAL_AGENT_ID,
      sender_type: "agent",
      content: "scoped message",
    }).select("id").single();
    assert.equal(ownMessage.error, null);

    const workspaceResponse = await fetch(`${harness.baseUrl}/api/servers`, {
      method: "POST",
      headers: {
        ...controllerHeaders(harness),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Other workspace",
        slug: `other-${randomUUID()}`,
      }),
    });
    assert.equal(workspaceResponse.ok, true);
    const other = await workspaceResponse.json() as {
      server: { id: string };
      channel: { id: string };
    };
    const otherChannel = await agent
      .from("channels")
      .select("id")
      .eq("id", other.channel.id)
      .maybeSingle();
    assert.equal(otherChannel.error, null);
    assert.equal(otherChannel.data, null);
    const crossWorkspaceMessage = await agent.from("messages").insert({
      channel_id: other.channel.id,
      sender_id: LOCAL_AGENT_ID,
      sender_type: "agent",
      content: "cross workspace",
    });
    assert.match(crossWorkspaceMessage.error?.message || "", /outside this local capability/i);
    const crossWorkspaceDirectory = await agent.rpc("list_workspace_human_directory", {
      server_uuid: other.server.id,
    });
    assert.match(crossWorkspaceDirectory.error?.message || "", /another workspace/i);

    const agentEvents = await fetch(`${harness.baseUrl}/api/events`, {
      headers: { Authorization: `Bearer ${capability}` },
    });
    assert.equal(agentEvents.status, 403);
    await agent.removeAllChannels();
  });
});

test("local task lifecycle RPCs preserve messages and enforce CAS, hierarchy, archive, and actor scope", async () => {
  await withHarness(async (harness) => {
    const createCompetitor = await fetch(`${harness.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...controllerHeaders(harness),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        display_name: "Task competitor",
        server_id: LOCAL_SERVER_ID,
        runtime: "codex",
        model: "default",
      }),
    });
    assert.equal(createCompetitor.ok, true);
    const competitorId = (await createCompetitor.json() as { agent: { id: string } }).agent.id;
    const channelResult = await harness.controller
      .from("channels")
      .select("name, description")
      .eq("id", LOCAL_CHANNEL_ID)
      .single();
    assert.equal(channelResult.error, null, channelResult.error?.message);
    const channel = channelResult.data as { name: string; description: string | null };
    const addCompetitor = await harness.controller.rpc("set_channel_agent_members", {
      channel_uuid: LOCAL_CHANNEL_ID,
      agent_ids: [LOCAL_AGENT_ID, competitorId],
      channel_name: channel.name,
      channel_description: channel.description,
      expected_agent_ids: [LOCAL_AGENT_ID],
      expected_channel_name: channel.name,
      expected_channel_description: channel.description,
    });
    assert.equal(addCompetitor.error, null, addCompetitor.error?.message);

    const credentials = await harness.connect();
    const capability = credentials.agentTokens[LOCAL_AGENT_ID];
    const competitorCapability = credentials.agentTokens[competitorId];
    assert.ok(capability);
    assert.ok(competitorCapability);
    const agent = createLocalClient(harness.baseUrl, capability);
    const competitor = createLocalClient(harness.baseUrl, competitorCapability);

    const sourceContent = "\n  Ship lifecycle parity  \nkeep this audit text";
    const sourceMessageResult = await harness.controller
      .from("messages")
      .insert({
        channel_id: LOCAL_CHANNEL_ID,
        sender_id: LOCAL_USER_ID,
        sender_type: "human",
        content: sourceContent,
      })
      .select("*")
      .single();
    assert.equal(sourceMessageResult.error, null, sourceMessageResult.error?.message);
    const sourceMessage = sourceMessageResult.data as {
      id: string;
      updated_at: string;
    };

    const claimArgs = {
      message_uuid: sourceMessage.id,
      sender_agent_uuid: LOCAL_AGENT_ID,
      expected_message_updated_at: sourceMessage.updated_at,
    };
    const [firstClaim, secondClaim] = await Promise.all([
      agent.rpc("claim_message_as_task", claimArgs),
      competitor.rpc("claim_message_as_task", {
        ...claimArgs,
        sender_agent_uuid: competitorId,
      }),
    ]);
    assert.equal(firstClaim.error, null, firstClaim.error?.message);
    assert.equal(secondClaim.error, null, secondClaim.error?.message);
    const claims = [firstClaim.data, secondClaim.data] as Array<{
      outcome: string;
      task: {
        id: string;
        task_number: number;
        title: string;
        description: string;
        updated_at: string;
      };
    }>;
    assert.deepEqual(
      claims.map((claim) => claim.outcome).sort(),
      ["claimed_new", "conflict"],
    );
    const parentTask = claims.find((claim) => claim.outcome === "claimed_new")!.task;
    assert.ok(claims.every((claim) => claim.task.id === parentTask.id));
    assert.equal(parentTask.title, "Ship lifecycle parity");
    assert.equal(parentTask.description, "");

    const controllerClaim = await harness.controller.rpc("claim_message_as_task", claimArgs);
    assert.match(controllerClaim.error?.message || "", /agent authentication required/i);
    const forgedDetails = await agent.rpc("update_task_details", {
      task_uuid: parentTask.id,
      task_title: parentTask.title,
      task_description: "",
      parent_task_uuid: null,
      sender_agent_uuid: null,
      expected_updated_at: parentTask.updated_at,
    });
    assert.match(forgedDetails.error?.message || "", /identity.*capability/i);
    const directUpdate = await harness.controller
      .from("tasks")
      .update({ title: "bypass" })
      .eq("id", parentTask.id);
    assert.match(directUpdate.error?.message || "", /actor-scoped task api/i);

    const details = await agent.rpc("update_task_details", {
      task_uuid: parentTask.id,
      task_title: "Lifecycle parent",
      task_description: "Preserve the original chat message.",
      parent_task_uuid: null,
      sender_agent_uuid: LOCAL_AGENT_ID,
      expected_updated_at: parentTask.updated_at,
    });
    assert.equal(details.error, null, details.error?.message);
    const detailedTask = (details.data as { task: {
      id: string;
      updated_at: string;
      title: string;
      description: string;
    } }).task;
    assert.ok(Date.parse(detailedTask.updated_at) > Date.parse(parentTask.updated_at));
    assert.equal(detailedTask.title, "Lifecycle parent");
    assert.equal(detailedTask.description, "Preserve the original chat message.");
    const preservedSource = await harness.controller
      .from("messages")
      .select("content, updated_at")
      .eq("id", sourceMessage.id)
      .single();
    assert.equal(preservedSource.error, null, preservedSource.error?.message);
    assert.equal((preservedSource.data as { content: string }).content, sourceContent);
    assert.equal(
      (preservedSource.data as { updated_at: string }).updated_at,
      sourceMessage.updated_at,
    );

    const staleArchive = await agent.rpc("set_task_archived", {
      task_uuid: parentTask.id,
      archived: true,
      sender_agent_uuid: LOCAL_AGENT_ID,
      expected_updated_at: parentTask.updated_at,
    });
    assert.match(staleArchive.error?.message || "", /changed; refresh and retry/i);

    const childCreate = await agent.rpc("create_task_with_message", {
      channel_uuid: LOCAL_CHANNEL_ID,
      task_title: "Lifecycle child",
      parent_task_uuid: parentTask.id,
      assignee_uuid: null,
      assignee_type: null,
      assignee_mention_name: null,
      sender_agent_uuid: LOCAL_AGENT_ID,
    });
    assert.equal(childCreate.error, null, childCreate.error?.message);
    const childResult = childCreate.data as {
      message: { id: string; content: string };
      task: { id: string; updated_at: string };
    };

    const cycle = await agent.rpc("update_task_details", {
      task_uuid: parentTask.id,
      task_title: detailedTask.title,
      task_description: detailedTask.description,
      parent_task_uuid: childResult.task.id,
      sender_agent_uuid: LOCAL_AGENT_ID,
      expected_updated_at: detailedTask.updated_at,
    });
    assert.match(cycle.error?.message || "", /cycle/i);

    const archived = await agent.rpc("set_task_archived", {
      task_uuid: parentTask.id,
      archived: true,
      sender_agent_uuid: LOCAL_AGENT_ID,
      expected_updated_at: detailedTask.updated_at,
    });
    assert.equal(archived.error, null, archived.error?.message);
    const archiveResult = archived.data as {
      task: { id: string; updated_at: string; archived_at: string };
      tasks: Array<{ id: string; updated_at: string; archived_at: string }>;
      affected_count: number;
    };
    assert.equal(archiveResult.affected_count, 2);
    assert.equal(archiveResult.tasks.length, 2);
    assert.ok(archiveResult.tasks.every((task) => task.archived_at));
    assert.ok(archiveResult.tasks.every(
      (task) => task.updated_at === archiveResult.task.updated_at,
    ));

    const directDelete = await harness.controller
      .from("tasks")
      .delete()
      .eq("id", childResult.task.id);
    assert.match(directDelete.error?.message || "", /safe archived task api/i);
    const agentDelete = await agent.rpc("delete_archived_task", {
      task_uuid: childResult.task.id,
      expected_updated_at: archiveResult.tasks.find(
        (task) => task.id === childResult.task.id,
      )!.updated_at,
    });
    assert.match(agentDelete.error?.message || "", /human controller/i);
    const parentDeleteWithChild = await harness.controller.rpc("delete_archived_task", {
      task_uuid: parentTask.id,
      expected_updated_at: archiveResult.task.updated_at,
    });
    assert.match(parentDeleteWithChild.error?.message || "", /child tasks/i);

    const archivedChild = archiveResult.tasks.find((task) => task.id === childResult.task.id)!;
    const prematureChildRestore = await agent.rpc("set_task_archived", {
      task_uuid: childResult.task.id,
      archived: false,
      sender_agent_uuid: LOCAL_AGENT_ID,
      expected_updated_at: archivedChild.updated_at,
    });
    assert.match(prematureChildRestore.error?.message || "", /archived ancestor/i);

    const restored = await agent.rpc("set_task_archived", {
      task_uuid: parentTask.id,
      archived: false,
      sender_agent_uuid: LOCAL_AGENT_ID,
      expected_updated_at: archiveResult.task.updated_at,
    });
    assert.equal(restored.error, null, restored.error?.message);
    const restoreResult = restored.data as {
      task: { updated_at: string; archived_at: null };
      tasks: Array<{ id: string; updated_at: string; archived_at: null }>;
      affected_count: number;
    };
    assert.equal(restoreResult.affected_count, 2);
    assert.equal(restoreResult.task.archived_at, null);

    const restoredChild = restoreResult.tasks.find((task) => task.id === childResult.task.id)!;
    const rearchiveChild = await agent.rpc("set_task_archived", {
      task_uuid: childResult.task.id,
      archived: true,
      sender_agent_uuid: LOCAL_AGENT_ID,
      expected_updated_at: restoredChild.updated_at,
    });
    assert.equal(rearchiveChild.error, null, rearchiveChild.error?.message);
    const rearchivedChild = (rearchiveChild.data as {
      task: { updated_at: string };
    }).task;
    const safeDelete = await harness.controller.rpc("delete_archived_task", {
      task_uuid: childResult.task.id,
      expected_updated_at: rearchivedChild.updated_at,
    });
    assert.equal(safeDelete.error, null, safeDelete.error?.message);
    assert.equal((safeDelete.data as { deleted: boolean }).deleted, true);
    const preservedChildMessage = await harness.controller
      .from("messages")
      .select("id, content")
      .eq("id", childResult.message.id)
      .single();
    assert.equal(preservedChildMessage.error, null, preservedChildMessage.error?.message);
    assert.equal(
      (preservedChildMessage.data as { content: string }).content,
      childResult.message.content,
    );

    const activeParentDelete = await harness.controller.rpc("delete_archived_task", {
      task_uuid: parentTask.id,
      expected_updated_at: restoreResult.task.updated_at,
    });
    assert.match(activeParentDelete.error?.message || "", /archive the task/i);
  });
});

test("rotation keeps one previous capability for a busy turn and retires older replay", async () => {
  await withHarness(async (harness) => {
    const first = (await harness.connect()).agentTokens[LOCAL_AGENT_ID];
    const second = (await harness.connect()).agentTokens[LOCAL_AGENT_ID];
    assert.notEqual(first, second);

    const busyTurn = await createLocalClient(harness.baseUrl, first)
      .from("agents")
      .select("id")
      .maybeSingle();
    assert.equal(busyTurn.error, null);

    const third = (await harness.connect()).agentTokens[LOCAL_AGENT_ID];
    const retiredReplay = await createLocalClient(harness.baseUrl, first)
      .from("agents")
      .select("id")
      .maybeSingle();
    assert.match(retiredReplay.error?.message || "", /expired or retired/i);
    const previous = await createLocalClient(harness.baseUrl, second)
      .from("agents")
      .select("id")
      .maybeSingle();
    const current = await createLocalClient(harness.baseUrl, third)
      .from("agents")
      .select("id")
      .maybeSingle();
    assert.equal(previous.error, null);
    assert.equal(current.error, null);
  });
});

test("capability signing and current/previous rotation survive a local service restart", async () => {
  await withHarness(async (harness) => {
    const first = (await harness.connect()).agentTokens[LOCAL_AGENT_ID];
    const second = (await harness.connect()).agentTokens[LOCAL_AGENT_ID];

    await harness.restart();

    for (const capability of [first, second]) {
      const live = await createLocalClient(harness.baseUrl, capability)
        .from("agents")
        .select("id")
        .maybeSingle();
      assert.equal(live.error, null);
    }

    const third = (await harness.connect()).agentTokens[LOCAL_AGENT_ID];
    const retired = await createLocalClient(harness.baseUrl, first)
      .from("agents")
      .select("id")
      .maybeSingle();
    assert.match(retired.error?.message || "", /expired or retired/i);
    for (const capability of [second, third]) {
      const live = await createLocalClient(harness.baseUrl, capability)
        .from("agents")
        .select("id")
        .maybeSingle();
      assert.equal(live.error, null);
    }
  });
});

test("a second local service fails fast when its port is already occupied", async () => {
  const blocker = createServer((_request, response) => response.end("occupied"));
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const address = blocker.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "teammate-port-conflict-test-"));
  const source = new URL("../../local-server/src/index.ts", import.meta.url);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), source.pathname], {
    cwd: new URL("../../..", import.meta.url).pathname,
    env: {
      ...process.env,
      NODE_ENV: "test",
      TEAMMATE_LOCAL_DB: join(directory, "local.db"),
      TEAMMATE_LOCAL_PORT: String(address.port),
      TEAMMATE_LOCAL_CONTROLLER_TOKEN: randomBytes(32).toString("base64url"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });

  try {
    const [code] = await Promise.race([
      once(child, "exit") as Promise<[number | null]>,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`conflicting local service did not exit: ${output}`)), 5_000);
      }),
    ]);
    assert.notEqual(code, 0);
    assert.match(output, /could not listen|EADDRINUSE/i);
  } finally {
    await stopChild(child);
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => error ? reject(error) : resolve());
    });
    await rm(directory, { recursive: true, force: true });
  }
});

test("the previous capability expires while the rotated current capability stays live", async () => {
  await withHarness(async (harness) => {
    const first = (await harness.connect()).agentTokens[LOCAL_AGENT_ID];
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = (await harness.connect()).agentTokens[LOCAL_AGENT_ID];
    await new Promise((resolve) => setTimeout(resolve, 200));

    const expiredPrevious = await createLocalClient(harness.baseUrl, first)
      .from("agents")
      .select("id")
      .maybeSingle();
    assert.match(expiredPrevious.error?.message || "", /expired or retired/i);
    const liveCurrent = await createLocalClient(harness.baseUrl, second)
      .from("agents")
      .select("id")
      .maybeSingle();
    assert.equal(liveCurrent.error, null);
  }, 400);
});

test("deleting an agent immediately revokes every issued local capability", async () => {
  await withHarness(async (harness) => {
    const createAgent = await fetch(`${harness.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...controllerHeaders(harness),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        display_name: "Revoked agent",
        server_id: LOCAL_SERVER_ID,
        runtime: "codex",
        model: "default",
      }),
    });
    assert.equal(createAgent.ok, true);
    const created = await createAgent.json() as { agent: { id: string } };
    const issued = (await harness.connect()).agentTokens[created.agent.id];
    assert.ok(issued);
    const removed = await fetch(`${harness.baseUrl}/api/agents/${created.agent.id}`, {
      method: "DELETE",
      headers: controllerHeaders(harness),
    });
    assert.equal(removed.ok, true);
    const revoked = await createLocalClient(harness.baseUrl, issued)
      .from("agents")
      .select("id")
      .maybeSingle();
    assert.match(revoked.error?.message || "", /revoked|retired/i);
  });
});

test("CLI derives local identity from the capability instead of TEAMMATE_AGENT_ID", async () => {
  await withHarness(async (harness) => {
    const capability = (await harness.connect()).agentTokens[LOCAL_AGENT_ID];
    const cli = new URL("../../../packages/cli/src/index.ts", import.meta.url);
    const child = spawn(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), cli.pathname, "server", "info"],
      {
        cwd: new URL("../../..", import.meta.url).pathname,
        env: {
          ...process.env,
          TEAMMATE_AGENT_ID: randomUUID(),
          TEAMMATE_AUTH_TOKEN: capability,
          TEAMMATE_LOCAL_SERVER_URL: harness.baseUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    const [code] = await once(child, "exit") as [number | null];
    assert.equal(code, 1);
    assert.match(output, /AGENT_IDENTITY_MISMATCH/);
  });
});

test("CLI claims messages and edits, archives, restores, and safely rejects agent deletion", async () => {
  await withHarness(async (harness) => {
    const capability = (await harness.connect()).agentTokens[LOCAL_AGENT_ID];
    assert.ok(capability);
    const message = await harness.controller
      .from("messages")
      .insert({
        channel_id: LOCAL_CHANNEL_ID,
        sender_id: LOCAL_USER_ID,
        sender_type: "human",
        content: "CLI lifecycle task",
      })
      .select("id")
      .single();
    assert.equal(message.error, null, message.error?.message);
    const messageId = (message.data as { id: string }).id;

    const claim = await runLocalCli(
      harness,
      capability,
      ["message", "claim", "--message-id", messageId],
    );
    assert.equal(claim.code, 0, claim.output);
    assert.match(claim.output, /claimed as task/i);
    const taskResult = await harness.controller
      .from("tasks")
      .select("id, task_number, title, description, archived_at")
      .eq("message_id", messageId)
      .single();
    assert.equal(taskResult.error, null, taskResult.error?.message);
    const task = taskResult.data as {
      id: string;
      task_number: number;
      title: string;
      description: string;
      archived_at: string | null;
    };

    const edit = await runLocalCli(harness, capability, [
      "task",
      "edit",
      "--number",
      String(task.task_number),
      "--title",
      "CLI edited title",
      "--description",
      "CLI edited description",
    ]);
    assert.equal(edit.code, 0, edit.output);
    assert.match(edit.output, /details updated/i);
    const edited = await harness.controller
      .from("tasks")
      .select("title, description")
      .eq("id", task.id)
      .single();
    assert.equal(edited.error, null, edited.error?.message);
    assert.equal((edited.data as { title: string }).title, "CLI edited title");
    assert.equal(
      (edited.data as { description: string }).description,
      "CLI edited description",
    );

    const archive = await runLocalCli(
      harness,
      capability,
      ["task", "archive", "--number", String(task.task_number)],
    );
    assert.equal(archive.code, 0, archive.output);
    assert.match(archive.output, /archived with 1 task/i);
    const archivedList = await runLocalCli(
      harness,
      capability,
      ["task", "list", "--archived"],
    );
    assert.equal(archivedList.code, 0, archivedList.output);
    assert.match(archivedList.output, /CLI edited title/);
    assert.match(archivedList.output, /\[archived\]/);

    const restore = await runLocalCli(
      harness,
      capability,
      ["task", "restore", "--number", String(task.task_number)],
    );
    assert.equal(restore.code, 0, restore.output);
    assert.match(restore.output, /restored with 1 task/i);

    const deniedDelete = await runLocalCli(
      harness,
      capability,
      ["task", "delete", "--number", String(task.task_number)],
    );
    assert.equal(deniedDelete.code, 1, deniedDelete.output);
    assert.match(deniedDelete.output, /DELETE_REQUIRES_HUMAN/);
    assert.match(deniedDelete.output, /human/i);
  });
});
