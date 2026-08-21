import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { signAgentJwt, signBridgeJwt } from "../../web/src/lib/jwt.js";
import { AgentManager } from "../src/agent-manager.js";

function payload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function sqlFunction(sql: string, name: string) {
  const lowerSql = sql.toLowerCase();
  const start = lowerSql.lastIndexOf(`create or replace function public.${name}`);
  assert.notEqual(start, -1, `Missing SQL function: ${name}`);
  const language = lowerSql.indexOf("$$ language", start);
  const end = sql.indexOf(";", language);
  assert.notEqual(end, -1, `Unterminated SQL function: ${name}`);
  return sql.slice(start, end + 1).replace(/\s+/g, " ");
}

test("agent credentials bind a unique short-lived principal instead of reusing the owner", () => {
  const previousSecret = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = "test-secret-with-enough-entropy-for-fixtures";
  try {
    const first = signAgentJwt("agent-a", "owner-a", "server-a", "machine-a");
    const refreshed = signAgentJwt("agent-a", "owner-a", "server-a", "machine-a");
    const otherAgent = signAgentJwt("agent-b", "owner-a", "server-a", "machine-a");
    const controller = signBridgeJwt("owner-a", "server-a", "machine-a");

    const firstClaims = payload(first);
    assert.equal(firstClaims.sub, "agent-a");
    assert.equal(firstClaims.teammate_agent_id, "agent-a");
    assert.equal(firstClaims.teammate_owner_id, "owner-a");
    assert.equal(firstClaims.teammate_server_id, "server-a");
    assert.equal(firstClaims.teammate_machine_key_id, "machine-a");
    assert.equal(firstClaims.teammate_token_version, 2);
    assert.equal(Number(firstClaims.exp) - Number(firstClaims.iat), 60 * 60);
    assert.notEqual(first, refreshed);
    assert.notEqual(firstClaims.jti, payload(refreshed).jti);
    assert.equal(payload(otherAgent).sub, "agent-b");
    assert.equal(payload(controller).sub, "owner-a");
    assert.equal(payload(controller).teammate_agent, undefined);
  } finally {
    if (previousSecret === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = previousSecret;
  }
});

test("hosted runtime protocol never falls back from an agent credential to the controller", async () => {
  const [connectRoute, runtimeIndex, manager, cli] = await Promise.all([
    readFile(new URL("../../web/src/app/api/bridge/connect/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/agent-manager.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/cli/src/index.ts", import.meta.url), "utf8"),
  ]);

  assert.match(connectRoute, /protocolVersion:\s*2/);
  assert.match(connectRoute, /agentTokens/);
  assert.match(connectRoute, /Agent membership lookup failed/);
  assert.match(runtimeIndex, /does not support per-agent runtime credentials/);
  assert.match(manager, /No scoped runtime credential is available for agent/);
  assert.match(manager, /TEAMMATE_AUTH_TOKEN:\s*agentAuthToken/);
  assert.doesNotMatch(manager, /TEAMMATE_AUTH_TOKEN:\s*this\.authToken/);
  assert.match(cli, /AGENT_IDENTITY_MISMATCH/);
  assert.match(cli, /payload\.teammate_agent_id !== payload\.sub/);
});

test("agent manager resolves and rotates only per-agent credentials", async () => {
  const channel = {
    subscribe() {
      return this;
    },
    send() {
      return Promise.resolve("ok");
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
  let refreshes = 0;
  const manager = new AgentManager(
    process.cwd(),
    client,
    "https://example.supabase.co",
    "anon-key",
    "controller-token",
    "",
    "server-a",
    "",
    { "agent-a": "agent-a-token-1" },
    async () => {
      refreshes += 1;
      return { "agent-a": "agent-a-token-2", "agent-b": "agent-b-token-1" };
    },
  );
  const resolveToken = Reflect.get(manager, "resolveAgentAuthToken") as (
    agentId: string,
  ) => Promise<string>;

  try {
    assert.equal(await resolveToken.call(manager, "agent-a"), "agent-a-token-1");
    assert.equal(await resolveToken.call(manager, "agent-b"), "agent-b-token-1");
    assert.equal(refreshes, 1);
    assert.notEqual(await resolveToken.call(manager, "agent-b"), "controller-token");
    manager.updateAgentAuthTokens({ "agent-a": "agent-a-token-3" });
    assert.equal(await resolveToken.call(manager, "agent-a"), "agent-a-token-3");
  } finally {
    manager.stopAll();
  }
});

test("hosted SQL canonicalizes agent writes and revalidates every live identity boundary", async () => {
  const [schema, finalRls] = await Promise.all([
    readFile(new URL("../../../packages/db/src/schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/db/src/fix-rls.sql", import.meta.url), "utf8"),
  ]);

  for (const sql of [schema, finalRls]) {
    const scope = sqlFunction(sql, "teammate_agent_session_matches_server");
    assert.match(scope, /agent\.id = auth\.uid\(\)/i);
    assert.match(scope, /teammate_agent_id/i);
    assert.match(scope, /teammate_owner_id/i);
    assert.match(scope, /teammate_server_id/i);
    assert.match(scope, /teammate_machine_key_id/i);
    assert.match(scope, /teammate_token_version/i);
    assert.match(scope, /agent_membership\.member_type = 'agent'/i);
    assert.match(scope, /owner_membership\.member_type = 'human'/i);
    assert.match(scope, /machine_key\.user_id = agent\.owner_id/i);
    assert.match(scope, /machine_key\.server_id = server_uuid/i);

    const channelActor = sqlFunction(sql, "user_owns_agent_in_channel");
    assert.match(channelActor, /agent_uuid = auth\.uid\(\)/i);
    assert.match(channelActor, /teammate_agent_session_matches_server/i);
    assert.match(channelActor, /teammate_bridge_session_matches_server/i);
    const channelReader = sqlFunction(sql, "user_has_agent_in_channel");
    assert.match(channelReader, /agent\.id = auth\.uid\(\)/i);
    assert.match(channelReader, /member\.channel_id = channel_uuid/i);

    assert.match(
      sql,
      /CREATE POLICY "(?:Users can view messages in their channels|Channel members can view messages)"[\s\S]{0,500}user_has_agent_in_channel\(channel_id\)/i,
    );
    assert.match(
      sql,
      /CREATE POLICY "Channel members can view tasks"[\s\S]{0,500}user_has_agent_in_channel\(channel_id\)/i,
    );

    for (const functionName of [
      "create_task_with_message",
      "assign_task_with_notification",
      "update_task_status",
      "claim_task",
      "unclaim_task",
    ]) {
      assert.match(
        sqlFunction(sql, functionName),
        /user_owns_agent_in_channel\(sender_agent_uuid,/i,
        `${functionName} must bind the compatibility sender argument to the JWT agent`,
      );
    }

    assert.match(sql, /user_owns_agent_in_channel\(sender_id, channel_id\)/i);
    assert.match(sql, /generated_by_agent_id = auth\.uid\(\)/i);
    assert.match(sql, /created_by::text[\s\S]{0,250}teammate_owner_id/i);
    assert.match(sql, /teammate_agent_session_matches_server\(server_id\)/i);

    const heartbeat = sqlFunction(sql, "touch_current_bridge_machine_key");
    assert.match(heartbeat, /teammate_bridge_session_matches_server/i);
    assert.match(
      sql,
      /CREATE POLICY "Agent owners can update message deliveries"[\s\S]{0,700}teammate_bridge_session_matches_server\(server_id\)/i,
    );

    const humanSession = sqlFunction(sql, "teammate_is_human_session");
    assert.match(humanSession, /NOT public\.teammate_is_agent_session\(\)/i);
  }
});
