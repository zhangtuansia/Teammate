import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dbFile = (name: string) =>
  new URL(`../../../packages/db/src/${name}`, import.meta.url);

function sqlObject(sql: string, marker: string) {
  const start = sql.lastIndexOf(marker);
  assert.notEqual(start, -1, `Missing SQL object: ${marker}`);
  const end = sql.indexOf(";", start);
  assert.notEqual(end, -1, `Unterminated SQL object: ${marker}`);
  return sql.slice(start, end + 1).replace(/\s+/g, " ");
}

function sqlFunction(sql: string, name: string) {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}`;
  const lowerSql = sql.toLowerCase();
  const start = lowerSql.lastIndexOf(marker.toLowerCase());
  assert.notEqual(start, -1, `Missing SQL function: ${name}`);
  const language = lowerSql.indexOf("$$ language", start);
  const end = sql.indexOf(";", language);
  assert.notEqual(end, -1, `Unterminated SQL function: ${name}`);
  return sql.slice(start, end + 1).replace(/\s+/g, " ");
}

test("documented hosted SQL order finishes with the hardened RLS upgrade", async () => {
  const guide = await readFile(
    new URL("../../../docs/SELF_HOSTING.md", import.meta.url),
    "utf8",
  );
  const orderedFiles = [
    "`schema.sql`",
    "`machine-keys.sql`",
    "`onboarding-trigger.sql`",
    "`fix-rls.sql`",
  ];
  let previous = -1;
  for (const file of orderedFiles) {
    const index = guide.indexOf(file);
    assert.ok(index > previous, `${file} must appear after the previous SQL file`);
    previous = index;
  }
});

test("the final upgrade layer creates post-v0 tables and durable inbox invariants", async () => {
  const finalRls = await readFile(dbFile("fix-rls.sql"), "utf8");

  assert.match(finalRls, /ALTER TABLE public\.tasks\s+ADD COLUMN IF NOT EXISTS parent_task_id/i);
  assert.match(finalRls, /CREATE TABLE IF NOT EXISTS public\.documents/i);
  assert.match(finalRls, /CREATE TABLE IF NOT EXISTS public\.message_deliveries/i);
  assert.match(finalRls, /DROP INDEX IF EXISTS public\.idx_messages_channel_seq/i);
  assert.match(finalRls, /CREATE UNIQUE INDEX idx_messages_channel_seq/i);
  assert.match(sqlFunction(finalRls, "assign_message_seq"), /pg_advisory_xact_lock/i);
  assert.match(finalRls, /DROP TRIGGER IF EXISTS trg_enqueue_human_message_deliveries/i);
  assert.match(finalRls, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.message_deliveries/i);
  assert.match(finalRls, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.tasks/i);
  assert.match(finalRls, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.documents/i);
  assert.match(finalRls, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.channels/i);
  assert.match(finalRls, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.server_members/i);
  assert.match(finalRls, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.profiles/i);
  assert.equal(
    (finalRls.match(/WHEN duplicate_object THEN NULL/gi) || []).length >= 6,
    true,
    "each upgrade publication addition must be independently idempotent",
  );
});

test("final channel policies preserve workspace and member boundaries", async () => {
  const finalRls = await readFile(dbFile("fix-rls.sql"), "utf8");

  assert.match(
    finalRls,
    /DROP POLICY IF EXISTS "Authenticated users can create channels" ON public\.channels/i,
  );
  assert.match(
    finalRls,
    /DROP POLICY IF EXISTS "Users can create channels" ON public\.channels/i,
  );
  assert.doesNotMatch(
    finalRls,
    /CREATE POLICY "(?:Authenticated users|Users) can create channels"/i,
  );

  const channelSelect = sqlObject(
    finalRls,
    'CREATE POLICY "Users can view their channels"',
  );
  assert.match(
    channelSelect,
    /type = 'public' AND public\.user_is_server_human_member\(server_id\)/i,
  );
  assert.match(channelSelect, /public\.user_is_channel_member\(id\)/i);
  assert.match(channelSelect, /public\.user_has_agent_in_channel\(id\)/i);

  const addMember = sqlObject(
    finalRls,
    'CREATE POLICY "Users can add channel members"',
  );
  assert.match(
    addMember,
    /channel_member_is_in_server\(channel_id, member_id, member_type\) AND/i,
  );
  assert.match(addMember, /user_can_self_join_public_channel/i);
  assert.doesNotMatch(addMember, /user_can_manage_channel\(channel_id\)/i);

  const removeMember = sqlObject(
    finalRls,
    'CREATE POLICY "Users can remove channel members"',
  );
  assert.match(removeMember, /user_can_self_leave_channel/i);
  assert.doesNotMatch(removeMember, /user_can_manage_channel\(channel_id\)/i);

  const memberScope = sqlFunction(finalRls, "channel_member_is_in_server");
  assert.match(memberScope, /JOIN public\.profiles profile/i);
  assert.match(memberScope, /agent\.server_id = channel\.server_id/i);
  assert.match(memberScope, /member\.member_type = 'agent'/i);

  const selfJoin = sqlFunction(finalRls, "user_can_self_join_public_channel");
  assert.match(selfJoin, /candidate_uuid = auth\.uid\(\)/i);
  assert.match(selfJoin, /candidate_type = 'human'/i);
  assert.match(selfJoin, /channel\.type = 'public'/i);

  assert.match(
    finalRls,
    /DROP POLICY IF EXISTS "Users can update channels" ON public\.channels/i,
  );
  assert.doesNotMatch(
    finalRls,
    /CREATE POLICY "Users can update channels"/i,
  );

  const replaceAgents = sqlFunction(finalRls, "set_channel_agent_members");
  assert.match(replaceAgents, /user_can_manage_channel\(channel_uuid\)/i);
  assert.match(replaceAgents, /FOR UPDATE/i);
  assert.match(
    replaceAgents,
    /target_channel\.name IS DISTINCT FROM expected_channel_name/i,
  );
  assert.match(
    replaceAgents,
    /target_channel\.description IS DISTINCT FROM expected_channel_description/i,
  );
  assert.match(replaceAgents, /current_agent_count <> expected_agent_count/i);
  assert.match(replaceAgents, /UPDATE public\.channels/i);
  assert.match(replaceAgents, /UPDATE public\.tasks/i);
  assert.match(replaceAgents, /DELETE FROM public\.channel_members/i);
  assert.match(
    replaceAgents,
    /NOT \(member\.member_id = ANY\(normalized_agent_ids\)\)/i,
  );
  assert.match(replaceAgents, /INSERT INTO public\.channel_members/i);
  assert.match(replaceAgents, /WHERE NOT EXISTS[\s\S]*existing_member\.member_id = requested\.agent_id/i);
});

test("final bridge and agent policies retain legitimate owner access without global leaks", async () => {
  const [schema, machineKeys, finalRls] = await Promise.all([
    readFile(dbFile("schema.sql"), "utf8"),
    readFile(dbFile("machine-keys.sql"), "utf8"),
    readFile(dbFile("fix-rls.sql"), "utf8"),
  ]);

  for (const sql of [schema, machineKeys, finalRls]) {
    const ownerRead = sqlFunction(sql, "user_has_agent_in_channel");
    assert.match(ownerRead, /agent_membership\.member_type = 'agent'/i);
    assert.match(ownerRead, /owner_membership\.member_type = 'human'/i);
    assert.match(ownerRead, /agent\.owner_id = auth\.uid\(\)|a\.owner_id = auth\.uid\(\)/i);
    assert.match(ownerRead, /teammate_bridge/i);
    assert.match(ownerRead, /teammate_server_id|teammate_(?:agent|bridge)_session_matches_server/i);

    const ownerWrite = sqlFunction(sql, "user_owns_agent_in_channel");
    assert.match(ownerWrite, /agent_membership\.member_type = 'agent'/i);
    assert.match(ownerWrite, /owner_membership\.member_type = 'human'/i);
    assert.match(ownerWrite, /teammate_bridge/i);
    assert.match(ownerWrite, /teammate_server_id|teammate_(?:agent|bridge)_session_matches_server/i);
  }

  const agentSelect = sqlObject(
    finalRls,
    'CREATE POLICY "Workspace members can view agents"',
  );
  assert.doesNotMatch(agentSelect, /USING \(true\)/i);
  assert.match(agentSelect, /owner_id = auth\.uid\(\)/i);
  assert.match(agentSelect, /teammate_is_human_session/i);
  assert.match(agentSelect, /teammate_bridge_session_matches_server/i);
  assert.doesNotMatch(agentSelect, /user_can_create_agent_in_server/i);

  assert.match(
    finalRls,
    /DROP POLICY IF EXISTS "Owner can manage own agents" ON public\.agents/i,
  );
  assert.doesNotMatch(
    finalRls,
    /CREATE POLICY "Owners can create agents in their workspaces"/i,
  );
  assert.doesNotMatch(
    finalRls,
    /CREATE POLICY "Owners can delete own agents"/i,
  );
  assert.match(
    finalRls,
    /DROP POLICY IF EXISTS "Users can create servers" ON public\.servers/i,
  );
  assert.doesNotMatch(finalRls, /CREATE POLICY "Users can create servers"/i);

  const agentUpdate = sqlObject(
    finalRls,
    'CREATE POLICY "Owners can update own agents"',
  );
  assert.match(agentUpdate, /agent_update_is_permitted/i);
  const safeAgentUpdate = sqlFunction(finalRls, "agent_update_is_permitted");
  assert.match(safeAgentUpdate, /agent\.workspace_path IS NOT DISTINCT FROM next_workspace_path/i);
  assert.match(safeAgentUpdate, /agent\.status IS NOT DISTINCT FROM next_status/i);
  assert.match(safeAgentUpdate, /agent\.connection_id IS NOT DISTINCT FROM next_connection_id/i);
  assert.match(safeAgentUpdate, /teammate_bridge/i);

  const serverJoin = sqlObject(
    finalRls,
    'CREATE POLICY "Users can join servers"',
  );
  assert.match(serverJoin, /server_member_matches_server/i);
  assert.match(serverJoin, /user_can_register_owned_agent/i);
  assert.doesNotMatch(
    serverJoin,
    /member_id = auth\.uid\(\) AND member_type = 'human'/i,
  );
  const serverLeave = sqlObject(
    finalRls,
    'CREATE POLICY "Users can leave servers"',
  );
  assert.match(serverLeave, /member_type = 'human'/i);
  assert.match(serverLeave, /server_human_has_no_agents/i);
  assert.doesNotMatch(serverLeave, /user_owns_agent_in_server/i);
  assert.doesNotMatch(
    serverLeave,
    /auth\.uid\(\) = \(SELECT owner_id FROM public\.servers WHERE id = server_id\)/i,
    "owners must use the atomic member-removal RPC",
  );

  for (const helper of [
    "user_is_channel_member",
    "user_has_agent_in_channel",
    "channel_member_is_in_server",
    "channel_identity_is_unchanged",
    "agent_identity_is_unchanged",
    "agent_update_is_permitted",
    "server_human_has_no_agents",
  ]) {
    assert.match(sqlFunction(finalRls, helper), /SET search_path = public, pg_temp/i);
  }
});

test("workspace owner eviction is atomic, human-only, idempotent, and workspace-scoped", async () => {
  const [schema, finalRls, localServer, memberUi] = await Promise.all([
    readFile(dbFile("schema.sql"), "utf8"),
    readFile(dbFile("fix-rls.sql"), "utf8"),
    readFile(new URL("../../local-server/src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../../web/src/components/workspace-members-section.tsx", import.meta.url), "utf8"),
  ]);

  for (const sql of [schema, finalRls]) {
    const directory = sqlFunction(sql, "list_workspace_human_members");
    assert.match(directory, /RETURNS TABLE \( id uuid, display_name text, avatar_url text, role text, joined_at timestamptz, agent_count bigint, is_current_user boolean \)/i);
    assert.match(directory, /teammate_is_human_session\(\)/i);
    assert.match(directory, /viewer_membership\.member_type = 'human'/i);
    assert.match(directory, /count\(agent\.id\)::bigint/i);
    assert.doesNotMatch(directory, /profile\.email/i);
    assert.doesNotMatch(directory, /agent\.(?:system_prompt|runtime|model|workspace_path|session_id|connection_id)/i);

    const eviction = sqlFunction(sql, "remove_server_human_member");
    assert.match(eviction, /requesting_user_id IS NULL OR public\.teammate_is_bridge_session\(\)/i);
    assert.match(eviction, /workspace_owner_id <> requesting_user_id/i);
    assert.match(eviction, /human_uuid = workspace_owner_id/i);
    assert.match(eviction, /FOR UPDATE/i);
    assert.match(eviction, /target_membership\.member_type = 'human' FOR UPDATE/i);
    assert.match(eviction, /LOCK TABLE public\.server_members IN ACCESS EXCLUSIVE MODE/i);
    assert.match(eviction, /agent\.owner_id = human_uuid FOR UPDATE/i);
    assert.match(eviction, /agent\.server_id = server_uuid AND agent\.owner_id = human_uuid/i);
    assert.match(eviction, /delivery\.server_id = server_uuid AND delivery\.agent_id = ANY\(target_agent_ids\)/i);
    assert.match(eviction, /machine_key\.server_id = server_uuid AND machine_key\.user_id = human_uuid/i);
    assert.match(eviction, /member\.server_id = server_uuid AND member\.member_id = human_uuid AND member\.member_type = 'human'/i);
    assert.match(eviction, /'removed', removed_human_membership = 1/i);
    assert.match(eviction, /SECURITY DEFINER SET search_path = public, pg_temp/i);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.remove_server_human_member\(uuid, uuid\) FROM public/i);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.remove_server_human_member\(uuid, uuid\) TO authenticated/i);

    const provisionAgent = sqlFunction(sql, "create_owned_agent_with_dm");
    assert.match(provisionAgent, /FROM public\.servers server WHERE server\.id = server_uuid FOR KEY SHARE/i);
    assert.match(provisionAgent, /member\.member_type = 'human' FOR KEY SHARE/i);

    const serverLeave = sqlObject(
      sql,
      sql.includes('CREATE POLICY "Users can leave servers"')
        ? 'CREATE POLICY "Users can leave servers"'
        : 'create policy "Users can leave servers"',
    );
    assert.match(serverLeave, /member_id = auth\.uid\(\)/i);
    assert.match(serverLeave, /server_human_has_no_agents/i);
    assert.doesNotMatch(serverLeave, /member_id <> auth\.uid\(\)/i);
  }

  assert.match(localServer, /function localRemoveServerHumanMember/);
  assert.match(localServer, /runAtomicMutationTransaction\("membership"/);
  assert.match(localServer, /case "remove_server_human_member"/);
  assert.match(localServer, /case "list_workspace_human_members"/);
  assert.match(memberUi, /\.rpc\("remove_server_human_member"/);
  assert.match(memberUi, /workspaceMembers\.confirmDescription/);
  assert.match(memberUi, /variant="destructive"/);
  assert.match(memberUi, /removeError/);
});

test("workspace agent discovery uses a safe directory RPC instead of shared agent rows", async () => {
  const [schema, finalRls, localServer, createDialog, editDialog] =
    await Promise.all([
      readFile(dbFile("schema.sql"), "utf8"),
      readFile(dbFile("fix-rls.sql"), "utf8"),
      readFile(
        new URL("../../local-server/src/index.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../web/src/components/create-channel-dialog.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../web/src/components/edit-channel-dialog.tsx", import.meta.url),
        "utf8",
      ),
    ]);

  for (const sql of [schema, finalRls]) {
    const directory = sqlFunction(sql, "list_workspace_agent_directory");
    assert.match(
      directory,
      /RETURNS TABLE \( id uuid, name text, display_name text, description text, avatar_url text, status text \)/i,
    );
    assert.match(directory, /teammate_is_human_session\(\)/i);
    assert.match(directory, /viewer_membership\.member_id = auth\.uid\(\)/i);
    assert.match(directory, /viewer_membership\.member_type = 'human'/i);
    assert.match(directory, /agent_membership\.member_type = 'agent'/i);
    assert.match(
      directory,
      /RETURN QUERY SELECT agent\.id, agent\.name, agent\.display_name, agent\.description, agent\.avatar_url, agent\.status FROM public\.agents agent/i,
    );
    assert.doesNotMatch(
      directory,
      /agent\.(?:owner_id|system_prompt|runtime|model|workspace_path|session_id|runtime_session_id|connection_id)/i,
    );
    assert.match(
      directory,
      /SECURITY DEFINER STABLE SET search_path = public, pg_temp/i,
    );
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.list_workspace_agent_directory\(uuid\) FROM public/i,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.list_workspace_agent_directory\(uuid\) TO authenticated/i,
    );
  }

  assert.match(localServer, /case "list_workspace_agent_directory"/);
  assert.match(localServer, /function localListWorkspaceAgentDirectory/);
  assert.match(
    localServer,
    /SELECT\s+agent\.id,\s+agent\.name,\s+agent\.display_name,\s+agent\.description,\s+agent\.avatar_url,\s+agent\.status\s+FROM agents agent/i,
  );

  for (const dialog of [createDialog, editDialog]) {
    assert.match(dialog, /\.rpc\("list_workspace_agent_directory", \{/);
    assert.match(dialog, /server_uuid:/);
    assert.doesNotMatch(dialog, /\.from\("agents"\)/);
    assert.match(dialog, /avatarUrl=\{agent\.avatar_url\}/);
  }
  assert.match(editDialog, /\.from\("channel_members"\)/);
});

test("channel and task consumers use scoped agent directories", async () => {
  const [schema, finalRls, localServer, messageArea, workspaceSection] =
    await Promise.all([
      readFile(dbFile("schema.sql"), "utf8"),
      readFile(dbFile("fix-rls.sql"), "utf8"),
      readFile(
        new URL("../../local-server/src/index.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../web/src/components/message-area.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../desktop/src/workspace-section.tsx", import.meta.url),
        "utf8",
      ),
    ]);

  for (const sql of [schema, finalRls]) {
    const mentions = sqlFunction(sql, "list_channel_agent_mentions");
    for (const field of [
      "id",
      "name",
      "display_name",
      "description",
      "avatar_url",
      "status",
      "is_owner",
    ]) {
      assert.match(mentions, new RegExp(`'${field}'`, "i"));
    }
    assert.doesNotMatch(mentions, /'owner_id'/i);
  }

  const localMentions = localServer.slice(
    localServer.indexOf("function localListChannelAgentMentions"),
    localServer.indexOf("async function handleRpcRequest"),
  );
  assert.match(localMentions, /agent\.description/i);
  assert.match(localMentions, /agent\.avatar_url/i);
  assert.match(localMentions, /agent\.status/i);
  assert.match(localMentions, /is_owner/i);

  assert.match(messageArea, /\.rpc\('list_channel_agent_mentions', \{/);
  assert.doesNotMatch(messageArea, /\.from\(['"]agents['"]\)/);
  assert.match(messageArea, /agentInfo\.is_owner/);

  const loadTasks = workspaceSection.slice(
    workspaceSection.indexOf("const loadTasks = useCallback"),
    workspaceSection.indexOf("const currentTaskSnapshot"),
  );
  assert.match(loadTasks, /\.rpc\("list_workspace_agent_directory", \{ server_uuid: serverId \}\)/);
  assert.doesNotMatch(loadTasks, /\.from\("agents"\)/);
  assert.match(loadTasks, /mentionName: agent\.name/);
  assert.match(loadTasks, /membershipRecords/);

  const loadDocuments = workspaceSection.slice(
    workspaceSection.indexOf("const loadDocuments = useCallback"),
    workspaceSection.indexOf("const scheduleDocumentsRefresh"),
  );
  assert.match(loadDocuments, /list_workspace_agent_directory/g);
  assert.match(loadDocuments, /generatorIdSet/);
  assert.doesNotMatch(workspaceSection, /\.from\("agents"\)/);
});

test("hosted realtime separates browser and bridge session capabilities", async () => {
  const [schema, finalRls] = await Promise.all([
    readFile(dbFile("schema.sql"), "utf8"),
    readFile(dbFile("fix-rls.sql"), "utf8"),
  ]);

  for (const sql of [schema, finalRls]) {
    assert.equal(
      (sql.match(/CREATE OR REPLACE FUNCTION public\.teammate_is_bridge_session\(\)/gi) || []).length,
      1,
      "the human/Bridge role discriminator must have one early source of truth",
    );
    const isBridge = sqlFunction(sql, "teammate_is_bridge_session");
    assert.match(isBridge, /current_setting\('request\.jwt\.claims', true\)/i);
    assert.match(isBridge, /teammate_bridge/i);

    const bridgeScope = sqlFunction(sql, "teammate_bridge_can_access_server");
    assert.match(bridgeScope, /teammate_machine_key_id/i);
    assert.match(bridgeScope, /machine_key\.server_id = server_uuid/i);
    assert.match(bridgeScope, /teammate_bridge/i);
    assert.match(bridgeScope, /teammate_server_id/i);
    assert.match(bridgeScope, /auth\.uid\(\) = owner_uuid/i);
  }

  const activityRead = sqlObject(
    finalRls,
    'CREATE POLICY "Teammate activity subscribers"',
  );
  assert.match(activityRead, /NOT public\.teammate_is_bridge_session\(\)/i);
  assert.match(activityRead, /teammate_user_can_access_server/i);

  const activityWrite = sqlObject(
    finalRls,
    'CREATE POLICY "Teammate activity publishers"',
  );
  assert.match(activityWrite, /teammate_bridge_can_access_server/i);

  const requestRead = sqlObject(
    finalRls,
    'CREATE POLICY "Teammate RPC request subscribers"',
  );
  assert.match(requestRead, /teammate_bridge_can_access_server/i);
  const requestWrite = sqlObject(
    finalRls,
    'CREATE POLICY "Teammate RPC request publishers"',
  );
  assert.match(requestWrite, /NOT public\.teammate_is_bridge_session\(\)/i);
  assert.match(requestWrite, /auth\.uid\(\) = split_part/i);

  const responseRead = sqlObject(
    finalRls,
    'CREATE POLICY "Teammate RPC response subscribers"',
  );
  assert.match(responseRead, /NOT public\.teammate_is_bridge_session\(\)/i);
  const responseWrite = sqlObject(
    finalRls,
    'CREATE POLICY "Teammate RPC response publishers"',
  );
  assert.match(responseWrite, /teammate_bridge_can_access_server/i);
});

test("final message insert policy binds sender ids to sender types", async () => {
  const [schema, machineKeys, finalRls] = await Promise.all([
    readFile(dbFile("schema.sql"), "utf8"),
    readFile(dbFile("machine-keys.sql"), "utf8"),
    readFile(dbFile("fix-rls.sql"), "utf8"),
  ]);

  for (const sql of [schema, machineKeys, finalRls]) {
    const marker = sql.includes('CREATE POLICY "Users can send messages in their channels"')
      ? 'CREATE POLICY "Users can send messages in their channels"'
      : 'create policy "Channel members can send messages"';
    const policy = sqlObject(sql, marker);
    assert.match(policy, /sender_id = auth\.uid\(\)|auth\.uid\(\) = sender_id/i);
    assert.match(policy, /sender_type = 'human'/i);
    assert.doesNotMatch(policy, /sender_type\s+IN\s*\('human',\s*'system'\)/i);
    assert.doesNotMatch(policy, /sender_type = 'system'/i);
    assert.match(policy, /sender_type = 'agent'/i);
    assert.match(policy, /user_owns_agent_in_channel\(sender_id, channel_id\)/i);
  }
});

test("durable inbox rows cannot cross channel workspaces or outlive membership access", async () => {
  const [schema, finalRls] = await Promise.all([
    readFile(dbFile("schema.sql"), "utf8"),
    readFile(dbFile("fix-rls.sql"), "utf8"),
  ]);

  for (const sql of [schema, finalRls]) {
    const validator = sqlFunction(sql, "validate_message_delivery_scope");
    assert.match(validator, /Message delivery identity fields are immutable/i);
    assert.match(validator, /message\.channel_id/i);
    assert.match(validator, /channel\.server_id = (?:NEW|new)\.server_id/i);
    assert.match(validator, /agent\.server_id = channel\.server_id/i);
    assert.match(validator, /workspace_member\.member_type = 'agent'/i);
    assert.match(validator, /SECURITY DEFINER SET search_path = public, pg_temp/i);

    const enqueue = sqlFunction(sql, "enqueue_human_message_deliveries");
    assert.match(enqueue, /workspace_member\.member_type = 'agent'/i);
  }

  const deliveryRead = sqlObject(
    finalRls,
    'CREATE POLICY "Agent owners can view message deliveries"',
  );
  assert.match(deliveryRead, /teammate_bridge_session_matches_server\(server_id\)/i);
  assert.match(deliveryRead, /user_owns_agent_in_server\(server_id, agent_id\)/i);
  assert.doesNotMatch(deliveryRead, /user_can_create_agent_in_server/i);
  const deliveryUpdate = sqlObject(
    finalRls,
    'CREATE POLICY "Agent owners can update message deliveries"',
  );
  assert.match(deliveryUpdate, /teammate_bridge_session_matches_server\(server_id\)/i);
  assert.match(deliveryUpdate, /user_owns_agent_in_server\(server_id, agent_id\)/i);
  assert.doesNotMatch(deliveryUpdate, /user_can_create_agent_in_server/i);
});

test("hosted provisioning and reset APIs delegate multi-table writes to atomic RPCs", async () => {
  const [agentRoute, channelRoute, serverRoute, resetRoute] = await Promise.all([
    readFile(
      new URL("../../../apps/web/src/app/api/agents/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../apps/web/src/app/api/channels/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../apps/web/src/app/api/servers/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../../apps/web/src/app/api/agents/[id]/reset/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  const agentPost = agentRoute.slice(agentRoute.indexOf("export async function POST"));
  assert.match(agentPost, /\.rpc\("create_owned_agent_with_dm", \{/);
  assert.doesNotMatch(agentPost, /\.from\(/);
  assert.doesNotMatch(agentPost, /rollbackProvisioning/);

  const serverPost = serverRoute.slice(serverRoute.indexOf("export async function POST"));
  assert.match(serverPost, /\.rpc\("create_owned_server", \{/);
  assert.doesNotMatch(serverPost, /\.from\(/);

  assert.match(resetRoute, /\.rpc\(\s*"reset_owned_agent"/);
  assert.match(resetRoute, /agent_uuid: id/);
  assert.doesNotMatch(resetRoute, /\.from\(/);

  const channelPost = channelRoute.slice(
    channelRoute.indexOf("export async function POST"),
  );
  assert.match(channelPost, /valid server_id required/);
  assert.match(channelPost, /type !== "public" && type !== "private"/);
  assert.match(channelPost, /parseSelectedMembers\(payload\.selected_members\)/);
  assert.match(channelPost, /\.rpc\("create_channel_with_members", \{/);
  assert.match(channelPost, /server_uuid: serverId/);
  assert.match(channelPost, /channel_name: name/);
  assert.match(channelPost, /channel_type: type/);
  assert.match(channelPost, /selected_members: selectedMembers/);
  assert.doesNotMatch(channelPost, /\.from\(/);
  assert.doesNotMatch(channelPost, /rollback|compensat/i);
  assert.doesNotMatch(channelPost, /\.insert\(|\.delete\(\)/);
});

test("hosted agent deletion is one authorized database transaction", async () => {
  const [schema, finalRls, agentRoute] = await Promise.all([
    readFile(dbFile("schema.sql"), "utf8"),
    readFile(dbFile("fix-rls.sql"), "utf8"),
    readFile(
      new URL("../../../apps/web/src/app/api/agents/[id]/route.ts", import.meta.url),
      "utf8",
    ),
  ]);

  for (const sql of [schema, finalRls]) {
    const teardown = sqlFunction(sql, "delete_owned_agent");
    assert.match(teardown, /RETURNS boolean/i);
    assert.match(teardown, /agent\.owner_id = requesting_user_id/i);
    assert.match(teardown, /server\.owner_id = requesting_user_id/i);
    assert.match(teardown, /member\.member_type = 'human'/i);
    assert.match(teardown, /FOR UPDATE OF agent/i);
    assert.match(
      teardown,
      /LOCK TABLE public\.channel_members IN SHARE ROW EXCLUSIVE MODE/i,
    );
    assert.match(teardown, /DELETE FROM public\.channels channel/i);
    assert.match(teardown, /channel\.server_id = target_server_id/i);
    assert.match(teardown, /channel\.type = 'dm'/i);
    assert.match(teardown, /DELETE FROM public\.channel_members member/i);
    assert.match(teardown, /DELETE FROM public\.server_members member/i);
    assert.match(teardown, /member\.server_id = target_server_id/i);
    assert.match(teardown, /UPDATE public\.tasks task/i);
    assert.match(teardown, /task\.assignee_id = agent_uuid/i);
    assert.match(teardown, /task\.assignee_type = 'agent'/i);
    assert.match(teardown, /DELETE FROM public\.agents agent/i);
    assert.match(teardown, /GET DIAGNOSTICS deleted_agents = ROW_COUNT/i);
    assert.match(teardown, /RETURN false/i);
    assert.match(teardown, /RETURN true/i);
    assert.match(teardown, /SECURITY DEFINER SET search_path = public, pg_temp/i);
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.delete_owned_agent\(uuid\) FROM public/i,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.delete_owned_agent\(uuid\) TO authenticated/i,
    );
  }

  const deleteHandler = agentRoute.slice(
    agentRoute.indexOf("export async function DELETE"),
  );
  assert.match(deleteHandler, /\.rpc\("delete_owned_agent", \{/);
  assert.match(deleteHandler, /agent_uuid: id/);
  assert.match(deleteHandler, /deleted !== true/);
  assert.match(deleteHandler, /status: 404/);
  assert.doesNotMatch(deleteHandler, /\.from\(/);
  assert.doesNotMatch(deleteHandler, /\.delete\(\)/);
});

test("atomic hosted lifecycle functions cover every dependent row", async () => {
  const [schema, finalRls] = await Promise.all([
    readFile(dbFile("schema.sql"), "utf8"),
    readFile(dbFile("fix-rls.sql"), "utf8"),
  ]);

  for (const sql of [schema, finalRls]) {
    assert.doesNotMatch(sql, /CREATE POLICY "Users can create servers"/i);
    assert.doesNotMatch(
      sql,
      /CREATE POLICY "Owners can create agents in their workspaces"/i,
    );
    assert.doesNotMatch(sql, /CREATE POLICY "Owners can delete own agents"/i);

    const createServer = sqlFunction(sql, "create_owned_server");
    assert.match(createServer, /INSERT INTO public\.servers/i);
    assert.match(createServer, /INSERT INTO public\.server_members/i);
    assert.match(createServer, /INSERT INTO public\.machine_keys/i);
    assert.match(createServer, /requesting_user_id uuid := auth\.uid\(\)/i);

    const createAgent = sqlFunction(sql, "create_owned_agent_with_dm");
    assert.match(createAgent, /INSERT INTO public\.agents/i);
    assert.match(createAgent, /INSERT INTO public\.server_members/i);
    assert.match(createAgent, /INSERT INTO public\.channels/i);
    assert.match(createAgent, /INSERT INTO public\.channel_members/i);
    assert.match(createAgent, /member\.member_type = 'human'/i);

    const resetAgent = sqlFunction(sql, "reset_owned_agent");
    assert.match(resetAgent, /FOR UPDATE OF agent/i);
    assert.match(resetAgent, /LOCK TABLE public\.messages/i);
    assert.match(resetAgent, /DELETE FROM public\.messages/i);
    assert.match(resetAgent, /UPDATE public\.agents/i);

    for (const signature of [
      "create_owned_server\\(text, text, text, text, text, text, text\\)",
      "create_owned_agent_with_dm\\(uuid, text, text, text, text, text, text\\)",
      "reset_owned_agent\\(uuid\\)",
    ]) {
      assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature} FROM public`, "i"));
      assert.match(
        sql,
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature} TO authenticated`, "i"),
      );
    }
  }
});

test("atomic hosted channel and task RPCs validate actors, stale state, and dependent writes", async () => {
  const [schema, finalRls] = await Promise.all([
    readFile(dbFile("schema.sql"), "utf8"),
    readFile(dbFile("fix-rls.sql"), "utf8"),
  ]);

  const signatures = [
    "create_channel_with_members\\(uuid, text, text, text, jsonb\\)",
    "set_channel_agent_members\\(uuid, uuid\\[\\], text, text, uuid\\[\\], text, text\\)",
    "create_task_with_message\\(uuid, text, uuid, uuid, text, text, uuid\\)",
    "assign_task_with_notification\\(uuid, uuid, text, text, uuid, timestamptz\\)",
    "update_task_status\\(uuid, text, uuid, timestamptz\\)",
    "claim_task\\(uuid, uuid, timestamptz\\)",
    "unclaim_task\\(uuid, uuid, timestamptz\\)",
  ];

  for (const sql of [schema, finalRls]) {
    const createChannel = sqlFunction(sql, "create_channel_with_members");
    assert.match(createChannel, /requesting_user_id uuid := auth\.uid\(\)/i);
    assert.match(createChannel, /member\.member_type = 'human'/i);
    assert.match(createChannel, /jsonb_typeof\(normalized_members\) <> 'array'/i);
    assert.match(createChannel, /requested_member_count <> unique_member_count/i);
    assert.match(createChannel, /INSERT INTO public\.channels/i);
    assert.match(
      createChannel,
      /VALUES \(created_channel\.id, requesting_user_id, 'human'\)/i,
    );
    assert.match(createChannel, /GET DIAGNOSTICS inserted_member_count = ROW_COUNT/i);
    assert.match(
      createChannel,
      /Every selected member must belong to the channel workspace/i,
    );

    const replaceAgents = sqlFunction(sql, "set_channel_agent_members");
    assert.match(replaceAgents, /user_can_manage_channel\(channel_uuid\)/i);
    assert.match(replaceAgents, /WHERE channel\.id = channel_uuid FOR UPDATE/i);
    assert.match(replaceAgents, /expected_channel_name/i);
    assert.match(replaceAgents, /expected_channel_description/i);
    assert.match(replaceAgents, /expected_agent_count/i);
    assert.match(replaceAgents, /Channel membership changed; refresh and retry/i);
    assert.match(replaceAgents, /UPDATE public\.tasks task/i);
    assert.match(replaceAgents, /task\.assignee_type = 'agent'/i);
    assert.match(replaceAgents, /DELETE FROM public\.channel_members/i);
    assert.match(
      replaceAgents,
      /NOT \(member\.member_id = ANY\(normalized_agent_ids\)\)/i,
    );
    assert.match(replaceAgents, /WHERE NOT EXISTS[\s\S]*existing_member\.member_id = requested\.agent_id/i);
    assert.match(replaceAgents, /agent\.server_id = target_channel\.server_id/i);

    const createTask = sqlFunction(sql, "create_task_with_message");
    assert.match(createTask, /sender_agent_uuid IS NULL/i);
    assert.match(createTask, /user_is_channel_member\(channel_uuid\)/i);
    assert.match(
      createTask,
      /user_owns_agent_in_channel\(sender_agent_uuid, channel_uuid\)/i,
    );
    assert.match(createTask, /canonical_sender_type := 'system'/i);
    assert.match(createTask, /INSERT INTO public\.messages/i);
    assert.match(createTask, /INSERT INTO public\.tasks/i);
    assert.match(createTask, /lower\(candidate\.name\)/i);
    assert.match(createTask, /not exists \(select 1 from stable_matches\)/i);
    assert.match(createTask, /INSERT INTO public\.message_deliveries/i);
    assert.match(createTask, /assignee_uuid/i);

    const assignTask = sqlFunction(sql, "assign_task_with_notification");
    assert.match(assignTask, /expected_updated_at IS NULL/i);
    assert.match(
      assignTask,
      /target_task\.updated_at IS DISTINCT FROM expected_updated_at/i,
    );
    assert.match(assignTask, /assignment_changed :=/i);
    assert.match(assignTask, /IF NOT assignment_changed THEN/i);
    assert.match(
      assignTask,
      /user_owns_agent_in_channel\(sender_agent_uuid, task\.channel_id\)/i,
    );
    assert.match(assignTask, /INSERT INTO public\.message_deliveries/i);
    assert.match(assignTask, /target_task\.archived_at IS NOT NULL/i);
    assert.match(assignTask, /task_title := target_task\.title/i);

    const updateStatus = sqlFunction(sql, "update_task_status");
    assert.match(updateStatus, /expected_updated_at IS NULL/i);
    assert.match(updateStatus, /user_is_channel_member\(task\.channel_id\)/i);
    assert.match(
      updateStatus,
      /user_owns_agent_in_channel\(sender_agent_uuid, task\.channel_id\)/i,
    );
    assert.match(updateStatus, /target_task\.updated_at IS DISTINCT FROM expected_updated_at/i);
    assert.match(updateStatus, /target_task\.archived_at IS NOT NULL/i);

    const claimTask = sqlFunction(sql, "claim_task");
    assert.match(claimTask, /sender_agent_uuid IS NULL/i);
    assert.match(
      claimTask,
      /user_owns_agent_in_channel\(sender_agent_uuid, task\.channel_id\)/i,
    );
    assert.match(claimTask, /target_task\.updated_at IS DISTINCT FROM expected_updated_at/i);
    assert.match(claimTask, /target_task\.archived_at IS NOT NULL/i);
    assert.match(claimTask, /target_task\.status = 'done'/i);
    assert.match(claimTask, /status = 'in_progress'/i);

    const unclaimTask = sqlFunction(sql, "unclaim_task");
    assert.match(
      unclaimTask,
      /user_owns_agent_in_channel\(sender_agent_uuid, task\.channel_id\)/i,
    );
    assert.match(unclaimTask, /target_task\.assignee_id IS DISTINCT FROM sender_agent_uuid/i);
    assert.match(unclaimTask, /target_task\.archived_at IS NOT NULL/i);
    assert.match(unclaimTask, /SET assignee_id = NULL/i);

    for (const signature of signatures) {
      assert.match(
        sql,
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature} FROM public`, "i"),
      );
      assert.match(
        sql,
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature} TO authenticated`, "i"),
      );
    }

    assert.match(
      sql,
      /DROP FUNCTION IF EXISTS public\.set_channel_agent_members\(uuid, uuid\[\], text, text\)/i,
    );
    assert.match(
      sql,
      /DROP FUNCTION IF EXISTS public\.create_task_with_message\(uuid, text, uuid, uuid, text, text\)/i,
    );
    assert.match(
      sql,
      /DROP FUNCTION IF EXISTS public\.assign_task_with_notification\(uuid, uuid, text, text, uuid\)/i,
    );
  }
});

test("hosted channel and task multi-row mutations have no direct write policy", async () => {
  const [schema, finalRls] = await Promise.all([
    readFile(dbFile("schema.sql"), "utf8"),
    readFile(dbFile("fix-rls.sql"), "utf8"),
  ]);

  for (const sql of [schema, finalRls]) {
    assert.doesNotMatch(
      sql,
      /CREATE POLICY\s+"[^"]+"\s+ON public\.channels\s+FOR (?:INSERT|UPDATE)/i,
    );
    assert.doesNotMatch(
      sql,
      /CREATE POLICY\s+"[^"]+"\s+ON public\.tasks\s+FOR (?:INSERT|UPDATE|DELETE)/i,
    );
  }

  assert.match(
    finalRls,
    /DROP POLICY IF EXISTS "Authenticated users can create channels" ON public\.channels/i,
  );
  assert.match(
    finalRls,
    /DROP POLICY IF EXISTS "Users can update channels" ON public\.channels/i,
  );
  assert.match(
    finalRls,
    /DROP POLICY IF EXISTS "Channel members can manage tasks" ON public\.tasks/i,
  );
  assert.match(
    finalRls,
    /DROP POLICY IF EXISTS "Channel members can update tasks" ON public\.tasks/i,
  );
  assert.match(
    finalRls,
    /DROP POLICY IF EXISTS "Channel members can delete tasks" ON public\.tasks/i,
  );
});

test("hosted task lifecycle RPCs preserve chat history, hierarchy, actor identity, and CAS", async () => {
  const [schema, finalRls] = await Promise.all([
    readFile(dbFile("schema.sql"), "utf8"),
    readFile(dbFile("fix-rls.sql"), "utf8"),
  ]);

  assert.match(
    schema,
    /title text not null constraint tasks_title_length\s+check \(char_length\(title\) between 1 and 500\)/i,
  );
  assert.match(schema, /description text default '' not null constraint tasks_description_length/i);
  assert.match(schema, /archived_at timestamptz/i);
  assert.match(schema, /CREATE INDEX idx_tasks_channel_active[\s\S]*WHERE archived_at IS NULL/i);
  assert.match(finalRls, /ADD COLUMN IF NOT EXISTS title text/i);
  assert.match(finalRls, /ADD COLUMN IF NOT EXISTS description text/i);
  assert.match(finalRls, /ADD COLUMN IF NOT EXISTS archived_at timestamptz/i);
  assert.match(finalRls, /regexp_split_to_table[\s\S]*WITH ORDINALITY/i);
  assert.match(finalRls, /left\([\s\S]*'Untitled task'[\s\S]*500/i);
  assert.match(finalRls, /ALTER COLUMN title SET NOT NULL/i);
  assert.match(finalRls, /ALTER COLUMN description SET DEFAULT ''/i);
  assert.match(finalRls, /ALTER COLUMN description SET NOT NULL/i);
  assert.match(
    finalRls,
    /ADD CONSTRAINT tasks_title_length\s+CHECK \(char_length\(title\) BETWEEN 1 AND 500\) NOT VALID/i,
  );
  assert.match(
    finalRls,
    /ADD CONSTRAINT tasks_description_length\s+CHECK \(char_length\(description\) <= 100000\) NOT VALID/i,
  );
  assert.match(finalRls, /VALIDATE CONSTRAINT tasks_title_length/i);
  assert.match(finalRls, /VALIDATE CONSTRAINT tasks_description_length/i);
  assert.match(
    finalRls,
    /CREATE INDEX IF NOT EXISTS idx_tasks_channel_active[\s\S]*WHERE archived_at IS NULL/i,
  );
  assert.ok(
    finalRls.indexOf("ADD COLUMN IF NOT EXISTS title text") <
      finalRls.indexOf("CREATE OR REPLACE FUNCTION public.claim_message_as_task"),
    "upgrade columns must exist before lifecycle functions",
  );
  assert.ok(
    finalRls.indexOf("CREATE OR REPLACE FUNCTION public.teammate_is_agent_session") <
      finalRls.indexOf("CREATE OR REPLACE FUNCTION public.claim_message_as_task"),
    "agent-principal helpers must exist before lifecycle functions",
  );

  for (const sql of [schema, finalRls]) {
    const createTask = sqlFunction(sql, "create_task_with_message");
    assert.match(createTask, /NOT BETWEEN 1 AND 500/i);
    assert.match(
      createTask,
      /INSERT INTO public\.tasks \( message_id, channel_id, title, parent_task_id/i,
    );

    const claimMessage = sqlFunction(sql, "claim_message_as_task");
    assert.match(claimMessage, /auth\.uid\(\) IS DISTINCT FROM sender_agent_uuid/i);
    assert.match(claimMessage, /NOT public\.teammate_is_agent_session\(\)/i);
    assert.match(claimMessage, /teammate_agent_session_matches_server\(target_server_id\)/i);
    assert.match(claimMessage, /lock_channel_member_for_task/i);
    assert.match(
      claimMessage,
      /FROM public\.channels channel WHERE channel\.id = target_channel_id[\s\S]*FOR UPDATE/i,
    );
    assert.match(claimMessage, /target_message\.thread_parent_id IS NOT NULL/i);
    assert.match(claimMessage, /target_message\.sender_type = 'system'/i);
    assert.match(
      claimMessage,
      /target_message\.updated_at IS DISTINCT FROM expected_message_updated_at/i,
    );
    assert.match(claimMessage, /WHERE task\.message_id = target_message\.id FOR UPDATE/i);
    assert.match(claimMessage, /target_task\.archived_at IS NOT NULL/i);
    assert.match(claimMessage, /target_task\.status = 'done'/i);
    assert.match(claimMessage, /'outcome', 'conflict'/i);
    assert.match(claimMessage, /'task', to_jsonb\(target_task\)/i);
    assert.match(claimMessage, /regexp_split_to_table/i);
    assert.match(claimMessage, /INSERT INTO public\.tasks/i);
    assert.doesNotMatch(claimMessage, /UPDATE public\.messages/i);

    const updateDetails = sqlFunction(sql, "update_task_details");
    assert.match(updateDetails, /public\.teammate_is_human_session\(\)/i);
    assert.match(updateDetails, /auth\.uid\(\) IS DISTINCT FROM sender_agent_uuid/i);
    assert.match(updateDetails, /public\.teammate_is_agent_session\(\)/i);
    assert.match(
      updateDetails,
      /FROM public\.channels channel WHERE channel\.id = target_channel_id FOR UPDATE/i,
    );
    assert.match(updateDetails, /FOR KEY SHARE/i);
    assert.match(updateDetails, /target_task\.updated_at IS DISTINCT FROM expected_updated_at/i);
    assert.match(updateDetails, /parent\.channel_id = target_channel_id/i);
    assert.match(updateDetails, /target_task\.archived_at IS NULL AND EXISTS/i);
    assert.match(updateDetails, /WITH RECURSIVE ancestors/i);
    assert.match(updateDetails, /Task hierarchy cannot contain a cycle/i);
    assert.match(updateDetails, /SET title = normalized_title/i);
    assert.match(updateDetails, /description = normalized_description/i);
    assert.doesNotMatch(updateDetails, /UPDATE public\.messages/i);

    const setArchived = sqlFunction(sql, "set_task_archived");
    assert.match(setArchived, /public\.teammate_is_human_session\(\)/i);
    assert.match(setArchived, /public\.teammate_is_agent_session\(\)/i);
    assert.match(
      setArchived,
      /FROM public\.channels channel WHERE channel\.id = target_channel_id FOR UPDATE/i,
    );
    assert.match(setArchived, /target_task\.updated_at IS DISTINCT FROM expected_updated_at/i);
    assert.match(setArchived, /WITH RECURSIVE ancestors/i);
    assert.match(setArchived, /Restore the archived ancestor before restoring this task/i);
    assert.match(setArchived, /WITH RECURSIVE descendants/i);
    assert.match(setArchived, /WHERE task\.id = ANY\(descendant_ids\)/i);
    assert.match(setArchived, /ORDER BY task\.id FOR UPDATE/i);
    assert.match(setArchived, /SET archived_at = CASE WHEN archived THEN now\(\) ELSE NULL END/i);

    const deleteTask = sqlFunction(sql, "delete_archived_task");
    assert.match(deleteTask, /NOT public\.teammate_is_human_session\(\)/i);
    assert.match(deleteTask, /public\.user_can_manage_channel\(target_channel_id\)/i);
    assert.match(deleteTask, /FROM public\.server_members member[\s\S]*FOR KEY SHARE/i);
    assert.match(
      deleteTask,
      /FROM public\.channels channel WHERE channel\.id = target_channel_id[\s\S]*FOR UPDATE/i,
    );
    assert.match(deleteTask, /target_task\.updated_at IS DISTINCT FROM expected_updated_at/i);
    assert.match(deleteTask, /target_task\.archived_at IS NULL/i);
    assert.match(deleteTask, /child\.parent_task_id = target_task\.id/i);
    assert.match(deleteTask, /DELETE FROM public\.tasks/i);
    assert.doesNotMatch(deleteTask, /DELETE FROM public\.messages/i);

    for (const signature of [
      "claim_message_as_task\\(uuid, uuid, timestamptz\\)",
      "update_task_details\\(uuid, text, text, uuid, uuid, timestamptz\\)",
      "set_task_archived\\(uuid, boolean, uuid, timestamptz\\)",
      "delete_archived_task\\(uuid, timestamptz\\)",
    ]) {
      assert.match(
        sql,
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature} FROM public`, "i"),
      );
      assert.match(
        sql,
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature} TO authenticated`, "i"),
      );
    }
  }

  for (const functionName of [
    "claim_message_as_task",
    "update_task_details",
    "set_task_archived",
    "delete_archived_task",
  ]) {
    assert.equal(
      sqlFunction(schema, functionName),
      sqlFunction(finalRls, functionName),
      `${functionName} must stay identical in fresh and upgrade SQL`,
    );
  }
});

test("profile reads are limited to self or humans in a shared workspace", async () => {
  const [schema, finalRls] = await Promise.all([
    readFile(dbFile("schema.sql"), "utf8"),
    readFile(dbFile("fix-rls.sql"), "utf8"),
  ]);

  for (const sql of [schema, finalRls]) {
    const profileScope = sqlFunction(sql, "user_can_view_profile");
    assert.match(profileScope, /profile_uuid = auth\.uid\(\)/i);
    assert.match(profileScope, /FROM public\.server_members viewer/i);
    assert.match(profileScope, /JOIN public\.server_members subject/i);
    assert.match(profileScope, /subject\.server_id = viewer\.server_id/i);
    assert.match(profileScope, /viewer\.member_type = 'human'/i);
    assert.match(profileScope, /subject\.member_type = 'human'/i);
    assert.match(profileScope, /SET search_path = public, pg_temp/i);
  }

  assert.match(
    finalRls,
    /DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public\.profiles/i,
  );
  assert.doesNotMatch(
    finalRls,
    /CREATE POLICY "Profiles are viewable by everyone"/i,
  );
  const profileRead = sqlObject(
    finalRls,
    'CREATE POLICY "Workspace members can view profiles"',
  );
  assert.match(profileRead, /user_can_view_profile\(id\)/i);
  assert.doesNotMatch(profileRead, /USING \(true\)/i);
});

test("workspace membership removal and legacy repair cannot leave hidden channel access", async () => {
  const [schema, finalRls] = await Promise.all([
    readFile(dbFile("schema.sql"), "utf8"),
    readFile(dbFile("fix-rls.sql"), "utf8"),
  ]);

  for (const sql of [schema, finalRls]) {
    const cleanup = sqlFunction(sql, "clear_removed_server_human_channel_memberships");
    assert.match(cleanup, /OLD\.member_type = 'human'/i);
    assert.match(cleanup, /DELETE FROM public\.machine_keys/i);
    assert.match(cleanup, /machine_key\.server_id = OLD\.server_id/i);
    assert.match(cleanup, /machine_key\.user_id = OLD\.member_id/i);
    assert.match(cleanup, /DELETE FROM public\.channel_members/i);
    assert.match(cleanup, /channel\.server_id = OLD\.server_id/i);
    assert.match(cleanup, /channel_member\.member_id = OLD\.member_id/i);
    assert.match(sql, /TRIGGER trg_clear_removed_server_human_channel_memberships/i);

    const memberRead = sqlObject(
      sql,
      sql === schema
        ? 'create policy "Members can view server members"'
        : 'CREATE POLICY "Members can view server members"',
    );
    assert.doesNotMatch(memberRead, /owner_id/i);
  }

  assert.match(finalRls, /LOCK TABLE public\.server_members IN SHARE ROW EXCLUSIVE MODE/i);
  assert.match(finalRls, /LOCK TABLE public\.channel_members IN SHARE ROW EXCLUSIVE MODE/i);
  assert.match(finalRls, /DELETE FROM public\.server_members workspace_member/i);
  assert.match(finalRls, /DELETE FROM public\.channel_members channel_member/i);
  assert.match(finalRls, /agent\.server_id = channel\.server_id/i);
  assert.match(finalRls, /workspace_member\.server_id = channel\.server_id/i);
});

test("final database layer rejects cross-channel task and message identities", async () => {
  const [schema, finalRls] = await Promise.all([
    readFile(dbFile("schema.sql"), "utf8"),
    readFile(dbFile("fix-rls.sql"), "utf8"),
  ]);

  for (const sql of [schema, finalRls]) {
    const messageScope = sqlFunction(sql, "validate_message_scope");
    assert.match(messageScope, /Message identity fields are immutable/i);
    assert.match(messageScope, /parent\.channel_id = new\.channel_id/i);
    assert.match(messageScope, /SECURITY DEFINER SET search_path = public, pg_temp/i);

    const taskScope = sqlFunction(sql, "validate_task_scope");
    assert.match(taskScope, /Task identity fields are immutable/i);
    assert.match(taskScope, /message\.channel_id = new\.channel_id/i);
    assert.match(taskScope, /parent\.channel_id = new\.channel_id/i);
    assert.match(taskScope, /WITH RECURSIVE lineage/i);
    assert.match(taskScope, /channel_member\.member_type = new\.assignee_type/i);
    assert.match(taskScope, /workspace_member\.server_id = channel\.server_id/i);
    assert.match(taskScope, /agent\.server_id = channel\.server_id/i);

    assert.match(sql, /TRIGGER trg_validate_message_scope/i);
    assert.match(sql, /TRIGGER trg_validate_task_scope/i);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.validate_message_scope\(\) FROM public/i);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.validate_task_scope\(\) FROM public/i);
  }
});

test("final workspace-owned records cannot move or orphan their owner", async () => {
  const finalRls = await readFile(dbFile("fix-rls.sql"), "utf8");

  const serverUpdate = sqlObject(finalRls, 'CREATE POLICY "Owner can update server"');
  assert.match(
    serverUpdate,
    /WITH CHECK \(public\.teammate_is_human_session\(\) AND owner_id = auth\.uid\(\)\)/i,
  );

  const serverLeave = sqlObject(finalRls, 'CREATE POLICY "Users can leave servers"');
  assert.match(serverLeave, /auth\.uid\(\) <> \(SELECT owner_id FROM public\.servers/i);
  assert.match(serverLeave, /member_id = auth\.uid\(\)/i);
  assert.doesNotMatch(serverLeave, /member_id <> auth\.uid\(\)/i);

  const documentUpdate = sqlObject(
    finalRls,
    'CREATE POLICY "Server members can update documents"',
  );
  assert.match(documentUpdate, /document_identity_is_unchanged/i);
  const documentIdentity = sqlFunction(finalRls, "document_identity_is_unchanged");
  assert.match(documentIdentity, /document\.server_id = next_server_uuid/i);
  assert.match(documentIdentity, /document\.created_by IS NOT DISTINCT FROM next_creator_uuid/i);

  assert.doesNotMatch(
    finalRls,
    /CREATE POLICY "Users can create own keys"/i,
    "runtime key creation must be confined to its atomic RPC",
  );
  const keyUpdate = sqlObject(finalRls, 'CREATE POLICY "Users can update own keys"');
  assert.match(keyUpdate, /machine_key_identity_is_unchanged/i);
  const keyIdentity = sqlFunction(finalRls, "machine_key_identity_is_unchanged");
  assert.match(keyIdentity, /machine_key\.server_id = next_server_uuid/i);
  assert.match(keyIdentity, /machine_key\.key_hash = next_key_hash/i);
});

test("runtime keys are atomically provisioned, non-recoverable, and fail closed during activation", async () => {
  const [schema, machineKeys, finalRls, keyRoute, connectRoute, localServer] = await Promise.all([
    readFile(dbFile("schema.sql"), "utf8"),
    readFile(dbFile("machine-keys.sql"), "utf8"),
    readFile(dbFile("fix-rls.sql"), "utf8"),
    readFile(
      new URL("../../../apps/web/src/app/api/bridge/keys/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../apps/web/src/app/api/bridge/connect/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../../local-server/src/index.ts", import.meta.url), "utf8"),
  ]);

  for (const sql of [schema, finalRls]) {
    const createServer = sqlFunction(sql, "create_owned_server");
    assert.match(
      createServer,
      /machine_key_prefix,\s*machine_key_hash,\s*null,\s*requesting_user_id/i,
    );
  }
  for (const sql of [schema, machineKeys, finalRls]) {
    const createKey = sqlFunction(sql, "create_current_user_machine_key");
    assert.match(createKey, /requesting_user_id (?:uuid )?:= auth\.uid\(\)/i);
    assert.match(createKey, /requesting_user_id IS NULL OR public\.teammate_is_bridge_session\(\)/i);
    assert.match(createKey, /FROM public\.servers server WHERE server\.id = server_uuid FOR KEY SHARE/i);
    assert.match(createKey, /member\.member_id = requesting_user_id AND member\.member_type = 'human' FOR KEY SHARE/i);
    assert.match(createKey, /INSERT INTO public\.machine_keys/i);
    assert.match(createKey, /machine_key_hash,\s*NULL,\s*requesting_user_id,\s*server_uuid/i);
    assert.match(createKey, /SECURITY DEFINER SET search_path = public, pg_temp/i);
    assert.doesNotMatch(createKey, /machine_key_value/i);
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.create_current_user_machine_key\(uuid, text, text, text\) FROM public/i,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.create_current_user_machine_key\(uuid, text, text, text\) TO authenticated/i,
    );
    assert.doesNotMatch(sql, /CREATE POLICY "Users can create own keys"/i);
  }
  assert.match(machineKeys, /UPDATE public\.machine_keys SET key_value = NULL/i);
  const standaloneKeyUpdate = sqlObject(
    machineKeys,
    'CREATE POLICY "Users can update own keys"',
  );
  assert.match(standaloneKeyUpdate, /machine_key_identity_is_unchanged/i);
  assert.match(
    machineKeys,
    /REVOKE ALL ON FUNCTION public\.machine_key_identity_is_unchanged\(uuid, uuid, uuid, text, text, text\) FROM public/i,
  );
  assert.match(finalRls, /UPDATE public\.machine_keys SET key_value = NULL/i);

  const serverPost = await readFile(
    new URL("../../../apps/web/src/app/api/servers/route.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(serverPost, /machine_key_value:\s*apiKey/i);
  assert.match(serverPost, /machine_key_value:\s*`tm_\$\{"0"\.repeat\(64\)\}`/i);

  const getHandler = keyRoute.slice(
    keyRoute.indexOf("export async function GET"),
    keyRoute.indexOf("export async function POST"),
  );
  assert.doesNotMatch(getHandler, /key_value/);
  const postHandler = keyRoute.slice(
    keyRoute.indexOf("export async function POST"),
    keyRoute.indexOf("export async function PATCH"),
  );
  assert.doesNotMatch(postHandler, /key_value/);
  assert.match(postHandler, /\.rpc\("create_current_user_machine_key", \{/);
  assert.match(postHandler, /server_uuid: serverId/);
  assert.match(postHandler, /machine_key_hash: keyHash/);
  assert.match(postHandler, /error\.code === "42501"/);
  assert.doesNotMatch(postHandler, /membershipError/);
  assert.doesNotMatch(postHandler, /\.from\(/);

  assert.match(localServer, /function localCreateCurrentUserMachineKey/);
  assert.match(localServer, /runAtomicMutationTransaction\("key"/);
  assert.match(localServer, /case "create_current_user_machine_key"/);
  assert.match(localServer, /Create runtime keys through the atomic runtime key API/);

  assert.match(connectRoute, /Runtime key lookup failed/);
  assert.match(connectRoute, /Workspace membership lookup failed/);
  assert.match(connectRoute, /Runtime key activation failed/);
  assert.match(connectRoute, /Agent lookup failed/);
  assert.match(connectRoute, /\^tm_\[0-9a-f\]\{64\}\$/);
});
