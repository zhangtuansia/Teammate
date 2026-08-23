#!/usr/bin/env node

/**
 * Teammate CLI — The command-line tool agents use to communicate with Teammate.
 *
 * Talks directly to Supabase. Auth via environment variables:
 *   TEAMMATE_AGENT_ID      — UUID of the agent
 *   TEAMMATE_SUPABASE_URL  — Supabase project URL
 *   TEAMMATE_SUPABASE_KEY  — Supabase anon/service key
 *   TEAMMATE_AUTH_TOKEN    — Hosted JWT bound to TEAMMATE_AGENT_ID
 *
 * Usage:
 *   teammate message send --target "#general" <<'EOF'
 *   Hello everyone!
 *   EOF
 *   teammate message check
 *   teammate message read --channel "#general"
 *   teammate message search --query "keyword"
 *   teammate message claim --message-id 1a2b3c4d --channel "#general"
 *   teammate server info
 *   teammate task list --channel "#general"
 *   teammate task create --channel "#general" --title "Fix the bug" [--parent 2] [--assignee @alice]
 *   teammate task assign --number 3 --assignee @alice
 *   teammate task claim --number 3
 *   teammate task unclaim --number 3
 *   teammate task update --number 3 --status done
 *   teammate task edit --number 3 --title "Updated title" --description "Details"
 *   teammate task archive --number 3
 *   teammate task restore --number 3
 *   teammate task delete --number 3
 *   teammate document list [--id 1a2b3c4d]
 *   teammate document create --title "Release notes" <<'EOF'
 *   teammate document update --id 1a2b3c4d --updated-at "2026-08-21T10:00:00.000Z" --content-stdin <<'EOF'
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createLocalClient } from "@teammate/local-client";
import { documentLinkMarkdown } from "@teammate/shared";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { readFile } from "fs/promises";
import { basename, join, resolve as resolvePath } from "path";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const CONFIGURED_AGENT_ID = process.env.TEAMMATE_AGENT_ID;
const SUPABASE_URL = process.env.TEAMMATE_SUPABASE_URL;
const SUPABASE_KEY = process.env.TEAMMATE_SUPABASE_KEY;
const AUTH_TOKEN = process.env.TEAMMATE_AUTH_TOKEN;
const LOCAL_SERVER_URL = process.env.TEAMMATE_LOCAL_SERVER_URL;
const configuredRpcTimeout = Number(process.env.TEAMMATE_CLI_RPC_TIMEOUT_MS || "15000");
const CLI_RPC_TIMEOUT_MS = Number.isFinite(configuredRpcTimeout) && configuredRpcTimeout > 0
  ? Math.min(configuredRpcTimeout, 120_000)
  : 15_000;

function fail(code: string, message: string): never {
  process.stderr.write(JSON.stringify({ ok: false, code, message }) + "\n");
  process.exit(1);
}

if (!LOCAL_SERVER_URL && !SUPABASE_URL) {
  fail("MISSING_SUPABASE_URL", "TEAMMATE_SUPABASE_URL is not set");
}
if (!LOCAL_SERVER_URL && !SUPABASE_KEY) {
  fail("MISSING_SUPABASE_KEY", "TEAMMATE_SUPABASE_KEY is not set");
}

if (!AUTH_TOKEN) {
  fail("MISSING_AUTH_TOKEN", "TEAMMATE_AUTH_TOKEN is not set");
}
const AGENT_ID = LOCAL_SERVER_URL
  ? readLocalAgentIdClaim(AUTH_TOKEN)
  : readHostedAgentIdClaim(AUTH_TOKEN);
if (!AGENT_ID) {
  fail("INVALID_AGENT_CREDENTIAL", "TEAMMATE_AUTH_TOKEN is not a scoped agent credential");
}
if (CONFIGURED_AGENT_ID && CONFIGURED_AGENT_ID !== AGENT_ID) {
  fail(
    "AGENT_IDENTITY_MISMATCH",
    "TEAMMATE_AGENT_ID does not match the scoped runtime credential",
  );
}

const supabase: SupabaseClient = LOCAL_SERVER_URL
  ? (createLocalClient(LOCAL_SERVER_URL, AUTH_TOKEN) as unknown as SupabaseClient)
  : createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
      ...(AUTH_TOKEN
        ? { global: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } } }
        : {}),
    });

function readHostedAgentIdClaim(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8")) as {
      sub?: unknown;
      teammate_agent?: unknown;
      teammate_agent_id?: unknown;
      teammate_token_version?: unknown;
    };
    if (
      payload.teammate_agent !== true ||
      payload.teammate_token_version !== 2 ||
      typeof payload.sub !== "string" ||
      payload.teammate_agent_id !== payload.sub
    ) {
      return null;
    }
    return payload.sub;
  } catch {
    return null;
  }
}

function readLocalAgentIdClaim(token: string): string | null {
  try {
    const [prefix, encodedClaims, signature, extra] = token.split(".");
    if (prefix !== "tm_local_agent_v1" || !encodedClaims || !signature || extra) {
      return null;
    }
    const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")) as {
      version?: unknown;
      kind?: unknown;
      agent_id?: unknown;
      server_id?: unknown;
      expires_at?: unknown;
    };
    if (
      claims.version !== 1 ||
      claims.kind !== "agent" ||
      typeof claims.agent_id !== "string" ||
      typeof claims.server_id !== "string" ||
      typeof claims.expires_at !== "number" ||
      claims.expires_at <= Date.now()
    ) {
      return null;
    }
    return claims.agent_id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val =
        args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      result[key] = val;
    }
  }
  return result;
}

/** parseArgs keeps one value per flag; attachments are the only flag that may
 * legitimately repeat, so read those straight from argv. */
function repeatedFlagValues(key: string): string[] {
  const args = process.argv.slice(4);
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== `--${key}`) continue;
    const value = args[i + 1];
    if (value && !value.startsWith("--")) {
      values.push(value);
      i += 1;
    }
  }
  return values;
}

const ATTACHMENT_EXTENSION_TYPES: Record<string, string> = {
  csv: "text/csv",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  log: "text/plain",
  markdown: "text/markdown",
  md: "text/markdown",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  wav: "audio/wav",
  webp: "image/webp",
  zip: "application/zip",
};

interface UploadedAttachment {
  url: string;
  display_name: string;
  mime_type: string;
}

function attachmentMarkdown(attachment: UploadedAttachment) {
  const label = attachment.display_name.replace(/[[\]]/g, "");
  return attachment.mime_type.startsWith("image/") &&
    attachment.mime_type !== "image/svg+xml"
    ? `![${label}](${attachment.url})`
    : `[${label}](${attachment.url})`;
}

async function uploadAttachment(path: string): Promise<UploadedAttachment> {
  if (!LOCAL_SERVER_URL) {
    fail("ATTACH_UNSUPPORTED", "Attachments require the local Teammate service");
  }
  const resolved = resolvePath(path);
  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch {
    return fail("ATTACH_FAILED", `Could not read ${resolved}`);
  }
  const name = basename(resolved);
  const extension = name.split(".").pop()?.toLowerCase() || "";
  const mimeType = ATTACHMENT_EXTENSION_TYPES[extension];
  if (!mimeType) {
    fail("ATTACH_UNSUPPORTED", `${name} is not a file type Teammate can attach`);
  }

  const response = await fetch(`${LOCAL_SERVER_URL.replace(/\/+$/, "")}/api/attachments`, {
    body: new Uint8Array(bytes),
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "Content-Type": mimeType,
      "X-Teammate-Filename": encodeURIComponent(name),
    },
    method: "POST",
  });
  const payload = (await response.json().catch(() => null)) as
    | { attachment?: UploadedAttachment; error?: string }
    | null;
  if (!response.ok || !payload?.attachment) {
    return fail("ATTACH_FAILED", payload?.error || `Upload failed with HTTP ${response.status}`);
  }
  return payload.attachment;
}

function shortId(uuid: string): string {
  return uuid.replace(/-/g, "").substring(0, 8);
}

function fmtTime(iso: string): string {
  return iso.replace(/\.\d+\+/, "+").replace(/\+00:00$/, "Z");
}

async function runRpcWithTimeout(
  functionName: string,
  args: Record<string, unknown>,
  failureCode: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLI_RPC_TIMEOUT_MS);
  try {
    const { data, error } = await supabase
      .rpc(functionName, args)
      .abortSignal(controller.signal);
    if (controller.signal.aborted) {
      fail(
        "RPC_TIMEOUT",
        `${functionName} timed out after ${CLI_RPC_TIMEOUT_MS}ms`,
      );
    }
    if (error) fail(failureCode, error.message);
    return data;
  } catch (error) {
    if (controller.signal.aborted) {
      fail(
        "RPC_TIMEOUT",
        `${functionName} timed out after ${CLI_RPC_TIMEOUT_MS}ms`,
      );
    }
    fail(
      failureCode,
      error instanceof Error ? error.message : `${functionName} failed`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

interface AgentWorkspaceIdentity {
  serverId: string;
  ownerId: string;
}

interface ChannelAgentIdentity {
  id: string;
  name: string;
  display_name: string;
  description?: string | null;
  status?: string;
}

interface WorkspaceHumanIdentity {
  id: string;
  display_name: string;
  avatar_url?: string | null;
}

interface DocumentSummary {
  id: string;
  title: string;
  generated_by_agent_id: string | null;
  updated_at: string;
}

interface DocumentRecord extends DocumentSummary {
  server_id: string;
  content: string;
  created_by: string;
  created_at: string;
}

let agentWorkspaceIdentity: AgentWorkspaceIdentity | null = null;
let workspaceHumans: WorkspaceHumanIdentity[] | null = null;
let workspaceAgents: ChannelAgentIdentity[] | null = null;

async function listWorkspaceHumanIdentities(): Promise<WorkspaceHumanIdentity[]> {
  if (workspaceHumans) return workspaceHumans;
  const { serverId } = await getAgentWorkspaceIdentity();
  const { data, error } = await supabase.rpc("list_workspace_human_directory", {
    server_uuid: serverId,
  });
  if (error) fail("RESOLVE_FAILED", error.message);
  if (!Array.isArray(data)) fail("RESOLVE_FAILED", "Workspace human directory is invalid");
  workspaceHumans = data as WorkspaceHumanIdentity[];
  return workspaceHumans;
}

async function listWorkspaceAgentIdentities(): Promise<ChannelAgentIdentity[]> {
  if (workspaceAgents) return workspaceAgents;
  const { serverId } = await getAgentWorkspaceIdentity();
  const { data, error } = await supabase.rpc("list_workspace_agent_directory", {
    server_uuid: serverId,
  });
  if (error) fail("RESOLVE_FAILED", error.message);
  if (!Array.isArray(data)) fail("RESOLVE_FAILED", "Workspace agent directory is invalid");
  workspaceAgents = data as ChannelAgentIdentity[];
  return workspaceAgents;
}

async function listChannelAgentIdentities(channelId: string): Promise<ChannelAgentIdentity[]> {
  const { data, error } = await supabase.rpc("list_channel_agent_mentions", {
    channel_uuid: channelId,
  });
  if (error) fail("RESOLVE_FAILED", error.message);
  if (!Array.isArray(data)) fail("RESOLVE_FAILED", "Channel agent directory is invalid");

  const agents: ChannelAgentIdentity[] = [];
  const seen = new Set<string>();
  for (const candidate of data) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.id !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.display_name !== "string" ||
      seen.has(candidate.id)
    ) {
      fail("RESOLVE_FAILED", "Channel agent directory is invalid");
    }
    seen.add(candidate.id);
    agents.push(candidate as ChannelAgentIdentity);
  }
  return agents;
}

async function getAgentWorkspaceIdentity(): Promise<AgentWorkspaceIdentity> {
  if (agentWorkspaceIdentity) return agentWorkspaceIdentity;

  const { data, error } = await supabase
    .from("agents")
    .select("server_id, owner_id")
    .eq("id", AGENT_ID)
    .maybeSingle();

  if (error) fail("WORKSPACE_RESOLVE_FAILED", error.message);
  if (!data?.server_id || !data.owner_id) {
    fail("WORKSPACE_RESOLVE_FAILED", "The current agent has no workspace owner");
  }

  agentWorkspaceIdentity = {
    serverId: data.server_id,
    ownerId: data.owner_id,
  };
  return agentWorkspaceIdentity;
}

// ---------------------------------------------------------------------------
// Target Resolution
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  channelId: string;
  threadParentId: string | null;
}

/**
 * Resolve a target string to a channel_id (and optional thread parent).
 *
 * Formats:
 *   #channel-name           → public/private channel by name
 *   #channel-name:shortid   → thread in that channel
 *   dm:@person-name         → DM channel with that person
 *   dm:@person-name:shortid → thread in DM
 *   raw-uuid                → channel by ID
 */
async function resolveTarget(target: string): Promise<ResolvedTarget> {
  let channelPart: string;
  let threadShortId: string | null = null;

  if (target.startsWith("dm:")) {
    // dm:@person or dm:@person:threadid
    const rest = target.slice(3); // @person or @person:threadid
    const colonIdx = rest.indexOf(":", 1); // skip the @ at index 0
    if (colonIdx > 0) {
      channelPart = "dm:" + rest.substring(0, colonIdx);
      threadShortId = rest.substring(colonIdx + 1);
    } else {
      channelPart = target;
    }
  } else if (target.startsWith("#")) {
    // #channel or #channel:threadid
    const colonIdx = target.indexOf(":");
    if (colonIdx > 0) {
      channelPart = target.substring(0, colonIdx);
      threadShortId = target.substring(colonIdx + 1);
    } else {
      channelPart = target;
    }
  } else {
    // Raw UUID
    return { channelId: target, threadParentId: null };
  }

  // Resolve channel
  let channelId: string;
  if (channelPart.startsWith("dm:@")) {
    const personName = channelPart.slice(4);
    channelId = await resolveDmChannel(personName);
  } else if (channelPart.startsWith("#")) {
    const channelName = channelPart.slice(1);
    channelId = await resolveChannelByName(channelName);
  } else {
    channelId = channelPart;
  }

  // Resolve thread parent if present
  let threadParentId: string | null = null;
  if (threadShortId) {
    threadParentId = await resolveMessageByShortId(channelId, threadShortId);
  }

  return { channelId, threadParentId };
}

async function resolveChannelByName(name: string): Promise<string> {
  const { data, error } = await supabase
    .from("channels")
    .select("id")
    .eq("name", name)
    .single();

  if (error || !data) {
    fail("RESOLVE_FAILED", `Cannot resolve channel #${name}`);
  }
  return data.id;
}

async function resolveDmChannel(personName: string): Promise<string> {
  // Find the person (could be human or agent)
  let personId: string | null = null;

  const normalizedName = personName.toLocaleLowerCase();
  const profile = (await listWorkspaceHumanIdentities()).find(
    (candidate) => candidate.display_name.toLocaleLowerCase() === normalizedName,
  );
  if (profile) personId = profile.id;
  if (!personId) {
    const agent = (await listWorkspaceAgentIdentities()).find(
      (candidate) =>
        candidate.display_name.toLocaleLowerCase() === normalizedName ||
        candidate.name.toLocaleLowerCase() === normalizedName,
    );
    if (agent) personId = agent.id;
  }

  if (!personId) {
    fail("RESOLVE_FAILED", `Cannot find user or agent: ${personName}`);
  }

  // Find DM channel where both agent and person are members
  const { data: agentChannels } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", AGENT_ID);

  const { data: personChannels } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", personId);

  if (!agentChannels || !personChannels) {
    fail("RESOLVE_FAILED", `Cannot find DM channel with ${personName}`);
  }

  const agentSet = new Set(agentChannels.map((c) => c.channel_id));
  const common = personChannels
    .map((c) => c.channel_id)
    .filter((id) => agentSet.has(id));

  // Check which of the common channels is a DM
  for (const chId of common) {
    const { data: ch } = await supabase
      .from("channels")
      .select("id, type")
      .eq("id", chId)
      .eq("type", "dm")
      .single();

    if (ch) return ch.id;
  }

  fail("RESOLVE_FAILED", `No DM channel found with ${personName}`);
}

async function resolveMessageByShortId(
  channelId: string,
  shortid: string
): Promise<string> {
  // Short ID is first 8 chars of UUID without dashes
  // Query messages in channel and match
  const { data: messages } = await supabase
    .from("messages")
    .select("id")
    .eq("channel_id", channelId)
    .is("thread_parent_id", null)
    .order("created_at", { ascending: false })
    .limit(100);

  if (messages) {
    for (const m of messages) {
      if (shortId(m.id) === shortid) return m.id;
    }
  }

  fail("RESOLVE_FAILED", `Cannot find message with short ID: ${shortid}`);
}

// ---------------------------------------------------------------------------
// Sender Name Resolution
// ---------------------------------------------------------------------------

const nameCache = new Map<string, string>();

async function resolveSenderName(
  senderId: string,
  senderType: string,
  channelId?: string,
): Promise<string> {
  if (nameCache.has(senderId)) return nameCache.get(senderId)!;

  let name = "Unknown";
  if (senderType === "agent") {
    const channelAgent = channelId
      ? (await listChannelAgentIdentities(channelId)).find((agent) => agent.id === senderId)
      : null;
    if (channelAgent) {
      name = channelAgent.name || channelAgent.display_name;
    } else {
      const { data } = await supabase
        .from("agents")
        .select("display_name, name")
        .eq("id", senderId)
        .single();
      if (data) name = data.name || data.display_name;
    }
  } else if (senderType === "human") {
    const human = (await listWorkspaceHumanIdentities()).find(
      (candidate) => candidate.id === senderId,
    );
    if (human) name = human.display_name;
  } else {
    name = "System";
  }

  nameCache.set(senderId, name);
  return name;
}

// ---------------------------------------------------------------------------
// Channel Name Resolution
// ---------------------------------------------------------------------------

async function resolveChannelDisplay(channelId: string): Promise<string> {
  const { data: ch } = await supabase
    .from("channels")
    .select("name, type")
    .eq("id", channelId)
    .single();

  if (!ch) return channelId;

  if (ch.type === "dm") {
    // Find the other member
    const { data: members } = await supabase
      .from("channel_members")
      .select("member_id, member_type")
      .eq("channel_id", channelId);

    if (members) {
      const other = members.find((m) => m.member_id !== AGENT_ID);
      if (other) {
        const name = await resolveSenderName(other.member_id, other.member_type, channelId);
        return `dm:@${name}`;
      }
    }
    return `dm:${ch.name}`;
  }

  return `#${ch.name}`;
}

// ---------------------------------------------------------------------------
// Message Formatting
// ---------------------------------------------------------------------------

async function formatMessage(msg: {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: string;
  content: string;
  thread_parent_id: string | null;
  created_at: string;
}): Promise<string> {
  const channelDisplay = await resolveChannelDisplay(msg.channel_id);
  const senderName = await resolveSenderName(msg.sender_id, msg.sender_type, msg.channel_id);
  const time = fmtTime(msg.created_at);
  const sid = shortId(msg.id);

  let target = channelDisplay;
  if (msg.thread_parent_id) {
    target += `:${shortId(msg.thread_parent_id)}`;
  }

  return `[target=${target} msg=${sid} time=${time} type=${msg.sender_type}] @${senderName}: ${msg.content}`;
}

// ---------------------------------------------------------------------------
// Last-Checked Tracking
// ---------------------------------------------------------------------------

function getLastCheckedPath(): string {
  return join(process.cwd(), ".teammate", "last-checked");
}

interface MessageCheckCursor {
  channels: Record<string, number>;
  legacyTimestamp?: string;
}

function getLastChecked(): MessageCheckCursor {
  const p = getLastCheckedPath();
  if (existsSync(p)) {
    const raw = readFileSync(p, "utf-8").trim();
    try {
      const parsed = JSON.parse(raw) as Partial<MessageCheckCursor>;
      if (parsed.channels && typeof parsed.channels === "object") {
        return { channels: parsed.channels };
      }
    } catch {
      // Migrate the timestamp-only cursor used by earlier releases.
    }
    if (raw) return { channels: {}, legacyTimestamp: raw };
  }
  return { channels: {} };
}

function setLastChecked(cursor: MessageCheckCursor) {
  mkdirSync(join(process.cwd(), ".teammate"), { recursive: true });
  const p = getLastCheckedPath();
  writeFileSync(p, `${JSON.stringify({ channels: cursor.channels }, null, 2)}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdMessageSend(flags: Record<string, string>) {
  const target = flags.target;
  if (!target) fail("INVALID_ARG", "Missing --target");

  const attachments = repeatedFlagValues("attach");
  const content = await readStdin();
  if (!content && attachments.length === 0) {
    fail("INVALID_ARG", "Message content must be provided via stdin");
  }

  const { channelId, threadParentId } = await resolveTarget(target);
  const broadcast = flags.broadcast !== undefined;
  if (broadcast && !threadParentId) {
    fail("INVALID_ARG", "--broadcast only applies to a thread target");
  }
  const attached: string[] = [];
  for (const path of attachments) {
    attached.push(attachmentMarkdown(await uploadAttachment(path)));
  }
  const body = [content, ...attached].filter(Boolean).join("\n\n");

  const { data, error } = await supabase
    .from("messages")
    .insert({
      channel_id: channelId,
      sender_id: AGENT_ID,
      sender_type: "agent",
      content: body,
      thread_parent_id: threadParentId,
      thread_broadcast: broadcast,
    })
    .select("id")
    .single();

  if (error) fail("SEND_FAILED", error.message);

  const sid = shortId(data.id);
  console.log(`Message sent to ${target}. Message ID: ${sid}`);
}

/** "Shown ⇒ seen": reads advance the send-time freshness baseline so a reply
 * composed right after reading is never held against the rows just shown.
 * Best-effort — hosted mode has no such RPC. */
async function recordChannelSeen(channelId: string, seq: number) {
  if (!Number.isFinite(seq) || seq <= 0) return;
  try {
    await supabase.rpc("record_channel_seen", {
      channel_uuid: channelId,
      agent_uuid: AGENT_ID,
      seq,
    });
  } catch {
    // Seen tracking must never block reading.
  }
}

function maxShownSeq(messages: Array<{ seq?: unknown }>) {
  return messages.reduce((max, message) => Math.max(max, Number(message.seq) || 0), 0);
}

async function cmdMessageCheck() {
  // Get channels where this agent is a member
  const { data: memberships } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", AGENT_ID)
    .eq("member_type", "agent");

  if (!memberships || memberships.length === 0) {
    console.log("No new messages.");
    return;
  }

  const cursor = getLastChecked();
  const firstCheckSince = cursor.legacyTimestamp || new Date(Date.now() - 5 * 60 * 1000).toISOString();
  let messageCount = 0;

  for (const membership of memberships) {
    const channelId = membership.channel_id;
    let afterSeq = cursor.channels[channelId];
    let hasMore = true;

    while (hasMore) {
      let query = supabase
        .from("messages")
        .select("*")
        .eq("channel_id", channelId)
        .neq("sender_id", AGENT_ID)
        .order("seq", { ascending: true });

      query = afterSeq !== undefined
        ? query.gt("seq", afterSeq)
        : query.gt("created_at", firstCheckSince);

      const { data: messages, error } = await query.limit(100);
      if (error) fail("CHECK_FAILED", error.message);
      const page = messages || [];
      for (const message of page) {
        console.log(await formatMessage(message));
        messageCount += 1;
        afterSeq = Math.max(afterSeq ?? 0, Number(message.seq) || 0);
      }
      hasMore = page.length === 100;
    }

    if (afterSeq !== undefined) {
      cursor.channels[channelId] = afterSeq;
      await recordChannelSeen(channelId, afterSeq);
    }
  }

  if (messageCount === 0) {
    console.log("No new messages.");
  }

  setLastChecked(cursor);
}

async function cmdMessageRead(flags: Record<string, string>) {
  const channel = flags.channel;
  if (!channel) fail("INVALID_ARG", "Missing --channel");

  const { channelId, threadParentId } = await resolveTarget(channel);
  const limit = flags.limit ? parseInt(flags.limit) : 20;

  let query = supabase
    .from("messages")
    .select("*")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (threadParentId) {
    query = query.eq("thread_parent_id", threadParentId);
  } else {
    query = query.is("thread_parent_id", null);
  }

  // Pagination
  if (flags.before) {
    query = query.lt("created_at", flags.before);
  }
  if (flags.after) {
    query = query.gt("created_at", flags.after);
  }

  // Around: get messages centered around a specific message
  if (flags.around) {
    const targetMsg = await findMessageById(channelId, flags.around);
    if (targetMsg) {
      const half = Math.floor(limit / 2);
      const { data: before } = await supabase
        .from("messages")
        .select("*")
        .eq("channel_id", channelId)
        .lte("created_at", targetMsg.created_at)
        .order("created_at", { ascending: false })
        .limit(half);

      const { data: after } = await supabase
        .from("messages")
        .select("*")
        .eq("channel_id", channelId)
        .gt("created_at", targetMsg.created_at)
        .order("created_at", { ascending: true })
        .limit(half);

      const all = [...(before || []).reverse(), ...(after || [])];
      for (const msg of all) {
        console.log(await formatMessage(msg));
      }
      await recordChannelSeen(channelId, maxShownSeq(all));
      return;
    }
  }

  const { data: messages } = await query;

  if (!messages || messages.length === 0) {
    console.log("No messages found.");
    return;
  }

  // Print in chronological order
  for (const msg of messages.reverse()) {
    console.log(await formatMessage(msg));
  }
  await recordChannelSeen(channelId, maxShownSeq(messages));
}

async function findMessageById(
  channelId: string,
  idOrShort: string
): Promise<{ id: string; created_at: string } | null> {
  // Try as full UUID first
  if (idOrShort.length > 8) {
    const { data } = await supabase
      .from("messages")
      .select("id, created_at")
      .eq("id", idOrShort)
      .single();
    return data;
  }

  // Try as short ID
  const { data: messages } = await supabase
    .from("messages")
    .select("id, created_at")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (messages) {
    for (const m of messages) {
      if (shortId(m.id) === idOrShort) return m;
    }
  }
  return null;
}

async function cmdMessageSearch(flags: Record<string, string>) {
  const query = flags.query;
  if (!query) fail("INVALID_ARG", "Missing --query");

  // Get agent's channels
  const { data: memberships } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", AGENT_ID)
    .eq("member_type", "agent");

  if (!memberships || memberships.length === 0) {
    console.log("No results.");
    return;
  }

  const channelIds = memberships.map((m) => m.channel_id);
  const limit = flags.limit ? parseInt(flags.limit) : 20;

  const { data: messages } = await supabase
    .from("messages")
    .select("*")
    .in("channel_id", channelIds)
    .ilike("content", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!messages || messages.length === 0) {
    console.log("No results.");
    return;
  }

  for (const msg of messages.reverse()) {
    console.log(await formatMessage(msg));
  }
}

async function cmdMessageClaim(flags: Record<string, string>) {
  const idOrShort = flags["message-id"];
  if (!idOrShort) fail("INVALID_ARG", "Missing --message-id");

  let messageId = idOrShort;
  if (idOrShort.length <= 8) {
    if (!flags.channel) {
      fail("INVALID_ARG", "Short message IDs require --channel");
    }
    const { channelId } = await resolveTarget(flags.channel);
    messageId = await resolveMessageByShortId(channelId, idOrShort);
  }

  const { data: message, error } = await supabase
    .from("messages")
    .select("id, channel_id, updated_at, thread_parent_id, sender_type")
    .eq("id", messageId)
    .single();
  if (error || !message) {
    fail("CLAIM_FAILED", error?.message || "Message not found");
  }
  if (message.thread_parent_id) {
    fail("CLAIM_FAILED", "Thread replies cannot become tasks");
  }
  if (message.sender_type === "system") {
    fail("CLAIM_FAILED", "System messages cannot become tasks");
  }
  await requireAgentChannelMembership(message.channel_id, "CLAIM_FAILED");

  const result = await runRpcWithTimeout(
    "claim_message_as_task",
    {
      message_uuid: message.id,
      sender_agent_uuid: AGENT_ID,
      expected_message_updated_at: message.updated_at,
    },
    "CLAIM_FAILED",
  );
  if (!result || typeof result !== "object" || !("task" in result)) {
    fail("CLAIM_FAILED", "Message claim returned an invalid result");
  }
  const claim = result as {
    outcome?: unknown;
    task?: {
      task_number?: unknown;
      assignee_id?: unknown;
      assignee_type?: unknown;
      channel_id?: unknown;
    };
  };
  if (typeof claim.task?.task_number !== "number") {
    fail("CLAIM_FAILED", "Message claim returned an invalid task");
  }
  if (claim.outcome === "conflict") {
    const assignee = typeof claim.task.assignee_id === "string"
      ? await resolveSenderName(
          claim.task.assignee_id,
          typeof claim.task.assignee_type === "string" ? claim.task.assignee_type : "agent",
          typeof claim.task.channel_id === "string" ? claim.task.channel_id : message.channel_id,
        )
      : "another actor";
    fail(
      "CLAIM_CONFLICT",
      `Message is already task #${claim.task.task_number}, assigned to @${assignee}`,
    );
  }
  if (claim.outcome === "already_claimed") {
    console.log(`Message is already claimed by this agent as task #${claim.task.task_number}.`);
    return;
  }
  if (claim.outcome !== "claimed_new" && claim.outcome !== "claimed_existing") {
    fail("CLAIM_FAILED", "Message claim returned an unknown outcome");
  }
  console.log(`Message claimed as task #${claim.task.task_number} and set to in_progress.`);
}

async function cmdServerInfo() {
  // Get agent's channels
  const { data: memberships } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", AGENT_ID)
    .eq("member_type", "agent");

  const myChannelIds = new Set(
    (memberships || []).map((m) => m.channel_id)
  );

  // Get all visible channels
  const { data: channels } = await supabase
    .from("channels")
    .select("id, name, description, type")
    .order("name");

  console.log("## Channels");
  if (channels) {
    for (const ch of channels) {
      if (ch.type === "dm") continue; // Skip DM channels in listing
      const joined = myChannelIds.has(ch.id);
      const desc = ch.description ? ` — ${ch.description}` : "";
      console.log(
        `  #${ch.name} (${ch.type}, joined=${joined})${desc}`
      );
    }
  }

  // Full configuration rows are owner-only; shared identities are resolved
  // through the scoped channel directory when a command has a channel.
  const agents = await listWorkspaceAgentIdentities();

  console.log("\n## Managed agents");
  if (agents) {
    for (const ag of agents) {
      const desc = ag.description ? ` — ${ag.description}` : "";
      console.log(`  @${ag.name} "${ag.display_name}" (${ag.status})${desc}`);
    }
  }

  // Get all humans
  const humans = await listWorkspaceHumanIdentities();

  console.log("\n## Humans");
  if (humans) {
    for (const h of humans) {
      console.log(`  @${h.display_name}`);
    }
  }
}

async function cmdTaskList(flags: Record<string, string>) {
  const channel = flags.channel;
  const archivedOnly = flags.archived === "true";
  const includeAll = flags.all === "true";
  if (archivedOnly && includeAll) {
    fail("INVALID_ARG", "Use either --archived or --all, not both");
  }

  let query = supabase
    .from("tasks")
    .select(
      "id, task_number, title, description, status, assignee_id, assignee_type, channel_id, message_id, parent_task_id, archived_at, created_at, updated_at"
    )
    .order("task_number", { ascending: true });

  if (channel) {
    const { channelId } = await resolveTarget(channel);
    query = query.eq("channel_id", channelId);
  } else {
    // Only show tasks from agent's channels
    const { data: memberships } = await supabase
      .from("channel_members")
      .select("channel_id")
      .eq("member_id", AGENT_ID)
      .eq("member_type", "agent");

    if (!memberships || memberships.length === 0) {
      console.log("No tasks.");
      return;
    }
    query = query.in(
      "channel_id",
      memberships.map((m) => m.channel_id)
    );
  }

  const { data: taskRows, error } = await query;
  if (error) fail("TASK_LIST_FAILED", error.message);
  const tasks = (taskRows || []).filter((task) =>
    includeAll ? true : archivedOnly ? task.archived_at !== null : task.archived_at === null
  );

  if (!tasks || tasks.length === 0) {
    console.log("No tasks.");
    return;
  }

  const taskNumbersById = new Map(
    tasks.map((task) => [task.id, task.task_number])
  );

  for (const task of tasks) {
    const title = task.title?.substring(0, 80) || "(untitled task)";
    const assignee = task.assignee_id
      ? await resolveSenderName(
          task.assignee_id,
          task.assignee_type || "agent",
          task.channel_id,
        )
      : "unassigned";

    const chDisplay = await resolveChannelDisplay(task.channel_id);
    const parentNumber = task.parent_task_id
      ? taskNumbersById.get(task.parent_task_id)
      : null;
    const parent = parentNumber ? ` subtask-of=#${parentNumber}` : "";
    console.log(
      `  ${parentNumber ? "↳ " : ""}task #${task.task_number} [${task.status}]${task.archived_at ? " [archived]" : ""}${parent} ${chDisplay} — ${title} (${assignee})`
    );
  }
}

async function resolveTaskAssignee(value: string, channelId: string): Promise<{
  id: string;
  type: "agent" | "human";
  name: string;
  mentionName: string | null;
}> {
  const handle = value.replace(/^@/, "").trim();
  if (!handle) fail("INVALID_ARG", "Assignee cannot be empty");

  const { data: memberships, error: membershipError } = await supabase
    .from("channel_members")
    .select("member_id, member_type")
    .eq("channel_id", channelId);
  if (membershipError) fail("RESOLVE_FAILED", membershipError.message);
  const humanIds = (memberships || [])
    .filter((membership) => membership.member_type === "human")
    .map((membership) => membership.member_id);

  const channelAgents = await listChannelAgentIdentities(channelId);
  const agentIds = channelAgents.map((agent) => agent.id);

  if (handle === "me") {
    if (!agentIds.includes(AGENT_ID!)) {
      fail("RESOLVE_FAILED", "This agent is not a member of the target channel");
    }
    const currentAgent = channelAgents.find((agent) => agent.id === AGENT_ID);
    if (!currentAgent) fail("RESOLVE_FAILED", "Cannot resolve this agent");
    return {
      id: AGENT_ID!,
      type: "agent",
      name: currentAgent.display_name || currentAgent.name || "me",
      mentionName: currentAgent.name,
    };
  }

  const normalizedHandle = handle.toLocaleLowerCase();
  const stableMatches = channelAgents.filter(
    (agent) => agent.name.toLocaleLowerCase() === normalizedHandle,
  );
  const matchingAgents = stableMatches.length > 0
    ? stableMatches
    : channelAgents.filter(
        (agent) => agent.display_name.toLocaleLowerCase() === normalizedHandle,
      );
  if (matchingAgents.length > 1) {
    fail("RESOLVE_FAILED", `Assignee @${handle} is ambiguous in this channel`);
  }
  if (matchingAgents.length === 1) {
    const agent = matchingAgents[0];
    return {
      id: agent.id,
      type: "agent",
      name: agent.display_name || agent.name,
      mentionName: agent.name,
    };
  }

  const { data: channelHumans, error: humansError } = humanIds.length > 0
    ? await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", humanIds)
    : { data: [], error: null };
  if (humansError) fail("RESOLVE_FAILED", humansError.message);
  const matchingHumans = (channelHumans || []).filter(
    (human) => human.display_name === handle,
  );
  if (matchingHumans.length > 1) {
    fail("RESOLVE_FAILED", `Assignee @${handle} is ambiguous in this channel`);
  }
  if (matchingHumans.length === 1) {
    const human = matchingHumans[0];
    return {
      id: human.id,
      type: "human",
      name: human.display_name,
      mentionName: null,
    };
  }

  fail("RESOLVE_FAILED", `Cannot find assignee: @${handle}`);
}

async function requireAgentChannelMembership(channelId: string, failureCode: string) {
  const { data, error } = await supabase
    .from("channel_members")
    .select("member_id")
    .eq("channel_id", channelId)
    .eq("member_id", AGENT_ID)
    .eq("member_type", "agent")
    .maybeSingle();
  if (error) fail(failureCode, error.message);
  if (!data) fail(failureCode, "This agent is not a member of the task channel");
}

async function cmdTaskCreate(flags: Record<string, string>) {
  const channel = flags.channel;
  const title = flags.title;
  const parentNumber = flags.parent ? parseInt(flags.parent) : null;
  const requestedAssignee = flags.assignee;
  if (!channel) fail("INVALID_ARG", "Missing --channel");
  if (!title) fail("INVALID_ARG", "Missing --title");
  if (flags.parent && (!parentNumber || parentNumber < 1)) {
    fail("INVALID_ARG", "--parent must be a valid task number");
  }

  const { channelId } = await resolveTarget(channel);
  await requireAgentChannelMembership(channelId, "CREATE_FAILED");
  let parentTaskId: string | null = null;
  if (parentNumber) {
    const { data: parentTask } = await supabase
      .from("tasks")
      .select("id, channel_id")
      .eq("task_number", parentNumber)
      .single();
    if (!parentTask) fail("CREATE_FAILED", `Parent task #${parentNumber} not found`);
    if (parentTask.channel_id !== channelId) {
      fail("CREATE_FAILED", "A subtask must use the same channel as its parent");
    }
    parentTaskId = parentTask.id;
  }
  const assignee = requestedAssignee
    ? await resolveTaskAssignee(requestedAssignee, channelId)
    : null;

  const { data: result, error: taskError } = await supabase.rpc(
    "create_task_with_message",
    {
      channel_uuid: channelId,
      task_title: title,
      parent_task_uuid: parentTaskId,
      assignee_uuid: assignee?.id || null,
      assignee_type: assignee?.type || null,
      assignee_mention_name: assignee?.mentionName || null,
      sender_agent_uuid: AGENT_ID,
    },
  );
  const task = result && typeof result === "object" && "task" in result
    ? result.task as { task_number?: number }
    : null;
  if (taskError || !task?.task_number) {
    fail("CREATE_FAILED", taskError?.message || "Task creation failed");
  }

  const parentText = parentNumber ? ` as a subtask of #${parentNumber}` : "";
  const assigneeText = assignee ? ` and assigned to @${assignee.name}` : "";
  console.log(`Task #${task.task_number} created in ${channel}${parentText}${assigneeText}.`);
}

async function cmdTaskAssign(flags: Record<string, string>) {
  const taskNumber = flags.number ? parseInt(flags.number) : null;
  const requestedAssignee = flags.assignee;
  const clearAssignee = flags.unassigned === "true";

  if (!taskNumber) fail("INVALID_ARG", "Missing --number");
  if (!requestedAssignee && !clearAssignee) {
    fail("INVALID_ARG", "Provide --assignee @name or --unassigned");
  }
  if (requestedAssignee && clearAssignee) {
    fail("INVALID_ARG", "Use either --assignee or --unassigned, not both");
  }

  const { data: task } = await supabase
    .from("tasks")
    .select("id, channel_id, updated_at")
    .eq("task_number", taskNumber)
    .single();
  if (!task) fail("ASSIGN_FAILED", "Task not found");
  await requireAgentChannelMembership(task.channel_id, "ASSIGN_FAILED");

  const assignee = requestedAssignee
    ? await resolveTaskAssignee(requestedAssignee, task.channel_id)
    : null;
  const { data: result, error } = await supabase.rpc(
    "assign_task_with_notification",
    {
      task_uuid: task.id,
      assignee_uuid: assignee?.id || null,
      assignee_type: assignee?.type || null,
      assignee_mention_name: assignee?.mentionName || null,
      sender_agent_uuid: AGENT_ID,
      expected_updated_at: task.updated_at,
    },
  );
  if (error) fail("ASSIGN_FAILED", error.message);
  if (!result || typeof result !== "object" || !("task" in result)) {
    fail("ASSIGN_FAILED", "Task assignment was not applied");
  }

  console.log(
    assignee
      ? `Task #${taskNumber} assigned to @${assignee.name}.`
      : `Task #${taskNumber} is now unassigned.`
  );
}

async function cmdTaskClaim(flags: Record<string, string>) {
  const taskNumber = flags.number ? parseInt(flags.number) : null;
  const messageId = flags["message-id"];

  if (!taskNumber && !messageId) {
    fail("INVALID_ARG", "Provide --number or --message-id");
  }

  let query = supabase.from("tasks").select("id, task_number, assignee_id, channel_id, updated_at");

  if (taskNumber) {
    query = query.eq("task_number", taskNumber);
  } else if (messageId) {
    query = query.eq("message_id", messageId);
  }

  const { data: task } = await query.single();

  if (!task) fail("CLAIM_FAILED", "Task not found");
  await requireAgentChannelMembership(task.channel_id, "CLAIM_FAILED");

  if (task.assignee_id && task.assignee_id !== AGENT_ID) {
    const owner = await resolveSenderName(task.assignee_id, "agent", task.channel_id);
    fail(
      "CLAIM_FAILED",
      `Task #${task.task_number} is already claimed by @${owner}`
    );
  }

  const { data: claimResult, error } = await supabase.rpc("claim_task", {
    task_uuid: task.id,
    sender_agent_uuid: AGENT_ID,
    expected_updated_at: task.updated_at,
  });
  if (error) fail("CLAIM_FAILED", error.message);
  if (!claimResult || typeof claimResult !== "object" || !("task" in claimResult)) {
    fail("CLAIM_FAILED", "Task claim was not applied");
  }

  console.log(`Task #${task.task_number} claimed and set to in_progress.`);
}

async function cmdTaskUnclaim(flags: Record<string, string>) {
  const taskNumber = flags.number ? parseInt(flags.number) : null;
  if (!taskNumber) fail("INVALID_ARG", "Missing --number");

  const { data: task } = await supabase
    .from("tasks")
    .select("id, task_number, assignee_id, channel_id, updated_at")
    .eq("task_number", taskNumber)
    .single();

  if (!task) fail("UNCLAIM_FAILED", "Task not found");
  await requireAgentChannelMembership(task.channel_id, "UNCLAIM_FAILED");

  if (task.assignee_id !== AGENT_ID) {
    fail("UNCLAIM_FAILED", "You are not the assignee of this task");
  }

  const { data: unclaimResult, error } = await supabase.rpc("unclaim_task", {
    task_uuid: task.id,
    sender_agent_uuid: AGENT_ID,
    expected_updated_at: task.updated_at,
  });
  if (error) fail("UNCLAIM_FAILED", error.message);
  if (!unclaimResult || typeof unclaimResult !== "object" || !("task" in unclaimResult)) {
    fail("UNCLAIM_FAILED", "Task unclaim was not applied");
  }

  console.log(`Task #${task.task_number} unclaimed.`);
}

async function cmdTaskUpdate(flags: Record<string, string>) {
  const taskNumber = flags.number ? parseInt(flags.number) : null;
  const status = flags.status;

  if (!taskNumber) fail("INVALID_ARG", "Missing --number");
  if (!status) fail("INVALID_ARG", "Missing --status");

  const validStatuses = ["todo", "in_progress", "in_review", "done"];
  if (!validStatuses.includes(status)) {
    fail(
      "INVALID_ARG",
      `Invalid status: ${status}. Valid: ${validStatuses.join(", ")}`
    );
  }

  const { data: task } = await supabase
    .from("tasks")
    .select("id, channel_id, updated_at")
    .eq("task_number", taskNumber)
    .single();

  if (!task) fail("UPDATE_FAILED", "Task not found");
  await requireAgentChannelMembership(task.channel_id, "UPDATE_FAILED");

  const { data: updateResult, error } = await supabase.rpc("update_task_status", {
    task_uuid: task.id,
    task_status: status,
    sender_agent_uuid: AGENT_ID,
    expected_updated_at: task.updated_at,
  });

  if (error) fail("UPDATE_FAILED", error.message);
  if (!updateResult || typeof updateResult !== "object" || !("task" in updateResult)) {
    fail("UPDATE_FAILED", "Task status update was not applied");
  }

  console.log(`Task #${taskNumber} updated to ${status}.`);
}

function parseRequiredTaskNumber(value: string | undefined) {
  const taskNumber = value ? Number(value) : NaN;
  if (!Number.isSafeInteger(taskNumber) || taskNumber < 1) {
    fail("INVALID_ARG", "--number must be a valid task number");
  }
  return taskNumber;
}

async function cmdTaskEdit(flags: Record<string, string>) {
  const taskNumber = parseRequiredTaskNumber(flags.number);
  const hasTitle = flags.title !== undefined;
  const hasDescription = flags.description !== undefined;
  const descriptionFromStdin = flags["description-stdin"] === "true";
  const clearDescription = flags["clear-description"] === "true";
  const hasParent = flags.parent !== undefined;
  const clearParent = flags["no-parent"] === "true";
  if (!hasTitle && !hasDescription && !descriptionFromStdin && !clearDescription && !hasParent && !clearParent) {
    fail(
      "INVALID_ARG",
      "Provide --title, --description, --description-stdin, --clear-description, --parent, or --no-parent",
    );
  }
  if ([hasDescription, descriptionFromStdin, clearDescription].filter(Boolean).length > 1) {
    fail(
      "INVALID_ARG",
      "Use only one of --description, --description-stdin, or --clear-description",
    );
  }
  if (hasParent && clearParent) {
    fail("INVALID_ARG", "Use either --parent or --no-parent, not both");
  }

  const { data: task, error } = await supabase
    .from("tasks")
    .select("id, task_number, title, description, parent_task_id, channel_id, updated_at")
    .eq("task_number", taskNumber)
    .single();
  if (error || !task) fail("EDIT_FAILED", error?.message || "Task not found");
  await requireAgentChannelMembership(task.channel_id, "EDIT_FAILED");

  let title = task.title;
  if (hasTitle) title = flags.title.trim();
  if (!title) fail("INVALID_ARG", "Task title cannot be empty");

  let description = task.description || "";
  if (hasDescription) description = flags.description;
  if (descriptionFromStdin) description = await readStdin();
  if (clearDescription) description = "";

  let parentTaskId: string | null = task.parent_task_id || null;
  let parentNumber: number | null = null;
  if (hasParent) {
    parentNumber = Number(flags.parent);
    if (!Number.isSafeInteger(parentNumber) || parentNumber < 1) {
      fail("INVALID_ARG", "--parent must be a valid task number");
    }
    const { data: parent, error: parentError } = await supabase
      .from("tasks")
      .select("id, channel_id")
      .eq("task_number", parentNumber)
      .single();
    if (parentError || !parent) {
      fail("EDIT_FAILED", parentError?.message || `Parent task #${parentNumber} not found`);
    }
    if (parent.channel_id !== task.channel_id) {
      fail("EDIT_FAILED", "Parent task must belong to the same channel");
    }
    parentTaskId = parent.id;
  } else if (clearParent) {
    parentTaskId = null;
  }

  const result = await runRpcWithTimeout(
    "update_task_details",
    {
      task_uuid: task.id,
      task_title: title,
      task_description: description,
      parent_task_uuid: parentTaskId,
      sender_agent_uuid: AGENT_ID,
      expected_updated_at: task.updated_at,
    },
    "EDIT_FAILED",
  );
  if (!result || typeof result !== "object" || !("task" in result)) {
    fail("EDIT_FAILED", "Task detail update returned an invalid result");
  }
  const parentText = hasParent
    ? ` Parent: #${parentNumber}.`
    : clearParent
      ? " Parent cleared."
      : "";
  console.log(`Task #${taskNumber} details updated.${parentText}`);
}

async function cmdTaskSetArchived(
  flags: Record<string, string>,
  archived: boolean,
) {
  const taskNumber = parseRequiredTaskNumber(flags.number);
  const failureCode = archived ? "ARCHIVE_FAILED" : "RESTORE_FAILED";
  const { data: task, error } = await supabase
    .from("tasks")
    .select("id, channel_id, updated_at")
    .eq("task_number", taskNumber)
    .single();
  if (error || !task) fail(failureCode, error?.message || "Task not found");
  await requireAgentChannelMembership(task.channel_id, failureCode);

  const result = await runRpcWithTimeout(
    "set_task_archived",
    {
      task_uuid: task.id,
      archived,
      sender_agent_uuid: AGENT_ID,
      expected_updated_at: task.updated_at,
    },
    failureCode,
  );
  if (
    !result ||
    typeof result !== "object" ||
    !("task" in result) ||
    !("affected_count" in result) ||
    typeof result.affected_count !== "number"
  ) {
    fail(failureCode, "Task archive update returned an invalid result");
  }
  console.log(
    `Task #${taskNumber} ${archived ? "archived" : "restored"} with ${result.affected_count} task(s) affected.`,
  );
}

async function cmdTaskDelete(flags: Record<string, string>) {
  const taskNumber = parseRequiredTaskNumber(flags.number);
  const { data: task, error } = await supabase
    .from("tasks")
    .select("id, updated_at")
    .eq("task_number", taskNumber)
    .single();
  if (error || !task) fail("DELETE_FAILED", error?.message || "Task not found");

  const result = await runRpcWithTimeout(
    "delete_archived_task",
    {
      task_uuid: task.id,
      expected_updated_at: task.updated_at,
    },
    "DELETE_REQUIRES_HUMAN",
  );
  if (
    !result ||
    typeof result !== "object" ||
    !("deleted" in result) ||
    result.deleted !== true
  ) {
    fail("DELETE_FAILED", "Safe task deletion returned an invalid result");
  }
  console.log(`Archived task #${taskNumber} deleted; its source message was preserved.`);
}

async function listWorkspaceDocuments(
  serverId: string,
  limit: number
): Promise<DocumentSummary[]> {
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, generated_by_agent_id, updated_at")
    .eq("server_id", serverId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) fail("DOCUMENT_LIST_FAILED", error.message);
  return (data || []) as DocumentSummary[];
}

function uuidFromCompact(value: string): string {
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join("-");
}

function nextHexPrefix(value: string): string | null {
  const digits = value.split("");
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const current = Number.parseInt(digits[index], 16);
    if (current < 15) {
      digits[index] = (current + 1).toString(16);
      return digits.join("");
    }
    digits[index] = "0";
  }
  return null;
}

async function resolveWorkspaceDocument(
  serverId: string,
  idOrPrefix: string
): Promise<DocumentRecord> {
  const compactPrefix = idOrPrefix.trim().toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{8,32}$/.test(compactPrefix)) {
    fail(
      "INVALID_ARG",
      "--id must be a UUID or an unambiguous hexadecimal prefix of at least 8 characters"
    );
  }

  let query = supabase
    .from("documents")
    .select(
      "id, server_id, title, content, created_by, generated_by_agent_id, created_at, updated_at"
    )
    .eq("server_id", serverId);

  if (compactPrefix.length === 32) {
    query = query.eq("id", uuidFromCompact(compactPrefix));
  } else {
    const lowerId = uuidFromCompact(compactPrefix.padEnd(32, "0"));
    const upperPrefix = nextHexPrefix(compactPrefix);
    query = query.gte("id", lowerId);
    if (upperPrefix) {
      query = query.lt("id", uuidFromCompact(upperPrefix.padEnd(32, "0")));
    }
    query = query.limit(2);
  }

  const { data, error } = await query;

  if (error) fail("DOCUMENT_RESOLVE_FAILED", error.message);

  const matches = ((data || []) as DocumentRecord[]).filter((document) =>
    document.id.replace(/-/g, "").toLowerCase().startsWith(compactPrefix)
  );
  if (matches.length === 0) {
    fail("DOCUMENT_NOT_FOUND", `No document matches ID: ${idOrPrefix}`);
  }
  if (matches.length > 1) {
    fail(
      "DOCUMENT_ID_AMBIGUOUS",
      `Document ID prefix ${idOrPrefix} matches multiple documents; use a longer prefix`
    );
  }
  return matches[0];
}

async function cmdDocumentList(flags: Record<string, string>) {
  const { serverId } = await getAgentWorkspaceIdentity();

  if (flags.id) {
    const document = await resolveWorkspaceDocument(serverId, flags.id);
    console.log(`[document=${shortId(document.id)} updated_at=${document.updated_at}] ${document.title}`);
    console.log(`ID: ${document.id}`);
    console.log(`Created at: ${document.created_at}`);
    console.log(`Created by: ${document.created_by}`);
    if (document.generated_by_agent_id) {
      console.log(`Generated by agent: ${document.generated_by_agent_id}`);
    }
    // Reading a document is the usual way of coming to mention one, so the
    // reference is printed here too — not only when it is written.
    console.log(`Link to it in chat as: ${documentLinkMarkdown(shortId(document.id), document.title)}`);
    console.log("\n" + document.content);
    return;
  }

  const limit = flags.limit ? Number.parseInt(flags.limit, 10) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    fail("INVALID_ARG", "--limit must be an integer between 1 and 200");
  }

  const documents = await listWorkspaceDocuments(serverId, limit);
  if (documents.length === 0) {
    console.log("No documents.");
    return;
  }

  for (const document of documents) {
    const generator = document.generated_by_agent_id
      ? ` generated_by=${shortId(document.generated_by_agent_id)}`
      : "";
    console.log(
      `[document=${shortId(document.id)} updated_at=${document.updated_at}${generator}] ${document.title}`
    );
    console.log(`  link: ${documentLinkMarkdown(shortId(document.id), document.title)}`);
  }
}

async function cmdDocumentCreate(flags: Record<string, string>) {
  const title = flags.title?.trim();
  if (!title) fail("INVALID_ARG", "Missing --title");

  const content = await readStdin();
  if (!content) {
    fail("INVALID_ARG", "Document content must be provided via stdin");
  }

  const { serverId, ownerId } = await getAgentWorkspaceIdentity();
  const { data, error } = await supabase
    .from("documents")
    .insert({
      server_id: serverId,
      title,
      content,
      created_by: ownerId,
      generated_by_agent_id: AGENT_ID,
    })
    .select("id, title, updated_at")
    .single();

  if (error) fail("DOCUMENT_CREATE_FAILED", error.message);
  if (!data) fail("DOCUMENT_CREATE_FAILED", "Document was not created");

  console.log(
    `Document ${shortId(data.id)} created: ${data.title}. updated_at=${data.updated_at}`
  );
  // Telling someone where a document is only helps if they can get to it, and
  // an id in prose is not a way to get anywhere. This is the line to paste.
  console.log(`Link to it in chat as: ${documentLinkMarkdown(shortId(data.id), data.title)}`);
}

async function cmdDocumentUpdate(flags: Record<string, string>) {
  const idOrPrefix = flags.id;
  const expectedUpdatedAt = flags["updated-at"];
  const title = flags.title?.trim();
  const contentFromStdin = flags["content-stdin"] === "true";

  if (!idOrPrefix) fail("INVALID_ARG", "Missing --id");
  if (!expectedUpdatedAt) fail("INVALID_ARG", "Missing --updated-at");
  if (!Number.isFinite(Date.parse(expectedUpdatedAt))) {
    fail("INVALID_ARG", "--updated-at must be a valid timestamp from document list");
  }
  if (flags["content-stdin"] && !contentFromStdin) {
    fail("INVALID_ARG", "--content-stdin does not take a value");
  }
  if (!title && !contentFromStdin) {
    fail("INVALID_ARG", "Provide --title and/or --content-stdin");
  }

  const content = contentFromStdin ? await readStdin() : null;
  if (contentFromStdin && !content) {
    fail("INVALID_ARG", "Updated document content must be provided via stdin");
  }

  const { serverId } = await getAgentWorkspaceIdentity();
  const document = await resolveWorkspaceDocument(serverId, idOrPrefix);
  const expectedTime = Date.parse(expectedUpdatedAt);
  const nextUpdatedAt = new Date(
    Math.max(Date.now(), expectedTime + 1)
  ).toISOString();
  const changes: Record<string, string> = { updated_at: nextUpdatedAt };
  if (title) changes.title = title;
  if (content !== null) changes.content = content;

  const { data, error } = await supabase
    .from("documents")
    .update(changes)
    .eq("id", document.id)
    .eq("server_id", serverId)
    .eq("updated_at", expectedUpdatedAt)
    .select("id, title, updated_at")
    .maybeSingle();

  if (error) fail("DOCUMENT_UPDATE_FAILED", error.message);
  if (!data) {
    fail(
      "DOCUMENT_CONFLICT",
      "The document changed since it was read. List it again and retry with its current updated_at."
    );
  }

  console.log(
    `Document ${shortId(data.id)} updated: ${data.title}. updated_at=${data.updated_at}`
  );
  console.log(`Link to it in chat as: ${documentLinkMarkdown(shortId(data.id), data.title)}`);
}

/**
 * Reacting is the cheap way to answer. A teammate who has seen a message and
 * has nothing to add can say so without spending a line in the channel.
 */
async function cmdMessageReact(flags: Record<string, string>) {
  const idOrShort = flags["message-id"];
  if (!idOrShort) fail("INVALID_ARG", "Missing --message-id");
  const emoji = flags.emoji;
  if (!emoji) fail("INVALID_ARG", "Missing --emoji");
  if (emoji.length > 16 || /\s/.test(emoji)) {
    fail("INVALID_ARG", "An emoji must be a single short token with no spaces");
  }

  let messageId = idOrShort;
  if (idOrShort.length <= 8) {
    if (!flags.channel) {
      fail("INVALID_ARG", "Short message IDs require --channel");
    }
    const { channelId } = await resolveTarget(flags.channel);
    messageId = await resolveMessageByShortId(channelId, idOrShort);
  }

  const { data: message, error } = await supabase
    .from("messages")
    .select("id, channel_id")
    .eq("id", messageId)
    .single();
  if (error || !message) {
    fail("REACT_FAILED", error?.message || "Message not found");
  }
  await requireAgentChannelMembership(message.channel_id, "REACT_FAILED");

  if (flags.remove !== undefined) {
    const removal = await supabase
      .from("message_reactions")
      .delete()
      .eq("message_id", message.id)
      .eq("actor_id", AGENT_ID)
      .eq("emoji", emoji);
    if (removal.error) fail("REACT_FAILED", removal.error.message);
    console.log(`Removed ${emoji} from ${shortId(message.id)}.`);
    return;
  }

  const { error: insertError } = await supabase.from("message_reactions").insert({
    actor_id: AGENT_ID,
    actor_type: "agent",
    emoji,
    message_id: message.id,
  });
  // Reacting twice is not an error — the reaction is already there.
  if (insertError && !/duplicate|unique|constraint/i.test(insertError.message)) {
    fail("REACT_FAILED", insertError.message);
  }
  console.log(`Reacted ${emoji} to ${shortId(message.id)}.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const [group, action] = args;
  const flags = parseArgs(args.slice(2));

  switch (`${group} ${action}`) {
    case "message send":
      return cmdMessageSend(flags);

    case "message check":
      return cmdMessageCheck();

    case "message read":
      return cmdMessageRead(flags);

    case "message search":
      return cmdMessageSearch(flags);

    case "message claim":
      return cmdMessageClaim(flags);

    case "message react":
      return cmdMessageReact(flags);

    case "server info":
      return cmdServerInfo();

    case "task list":
      return cmdTaskList(flags);

    case "task create":
      return cmdTaskCreate(flags);

    case "task assign":
      return cmdTaskAssign(flags);

    case "task claim":
      return cmdTaskClaim(flags);

    case "task unclaim":
      return cmdTaskUnclaim(flags);

    case "task update":
      return cmdTaskUpdate(flags);

    case "task edit":
      return cmdTaskEdit(flags);

    case "task archive":
      return cmdTaskSetArchived(flags, true);

    case "task restore":
      return cmdTaskSetArchived(flags, false);

    case "task delete":
      return cmdTaskDelete(flags);

    case "document list":
      return cmdDocumentList(flags);

    case "document create":
      return cmdDocumentCreate(flags);

    case "document update":
      return cmdDocumentUpdate(flags);

    default:
      console.log(`Teammate CLI v0.1.0

Usage:
  teammate message send --target "#channel"    Send a message (content via stdin)
  teammate message send --target "#ch:shortid" --broadcast
                                               Reply in a thread and show it in the channel
  teammate message check                       Check for new messages
  teammate message read --channel "#channel"   Read channel history
  teammate message search --query "keyword"    Search messages
  teammate message claim --message-id ID [--channel "#channel"]
                                               Claim a top-level message as a task
  teammate message react --message-id ID --emoji 👀 [--channel "#ch"] [--remove]
                                               React to a message instead of replying
  teammate server info                         Show server info
  teammate task list [--channel "#channel"] [--archived|--all]
                                               List active, archived, or all tasks
  teammate task create --channel "#ch" --title "T" [--parent N] [--assignee @name]
  teammate task assign --number N --assignee @name   Assign a task
  teammate task assign --number N --unassigned       Clear task assignment
  teammate task claim --number N               Claim a task
  teammate task unclaim --number N             Release a task
  teammate task update --number N --status S   Update task status
  teammate task edit --number N [--title "T"] [--description "D"] [--parent N|--no-parent]
                                               Edit task details or hierarchy
  teammate task archive --number N             Archive a task subtree
  teammate task restore --number N             Restore a task subtree
  teammate task delete --number N              Safe-delete an archived leaf (human-only)
  teammate document list [--id ID]             List documents or read one
  teammate document create --title "T"          Create a document (content via stdin)
  teammate document update --id ID --updated-at TIME [--title "T"] [--content-stdin]

Environment:
  TEAMMATE_AGENT_ID        Agent UUID
  TEAMMATE_SUPABASE_URL    Supabase project URL
  TEAMMATE_SUPABASE_KEY    Supabase anon key
  TEAMMATE_CLI_RPC_TIMEOUT_MS  RPC timeout in milliseconds (default: 15000)`);
      break;
  }
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({ ok: false, code: "CLI_ERROR", message: err.message }) +
      "\n"
  );
  process.exit(1);
});
