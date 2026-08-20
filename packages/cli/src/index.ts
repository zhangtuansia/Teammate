#!/usr/bin/env node

/**
 * Zano CLI — The command-line tool agents use to communicate with Zano.
 *
 * Talks directly to Supabase. Auth via environment variables:
 *   ZANO_AGENT_ID      — UUID of the agent
 *   ZANO_SUPABASE_URL  — Supabase project URL
 *   ZANO_SUPABASE_KEY  — Supabase anon/service key
 *
 * Usage:
 *   zano message send --target "#general" <<'EOF'
 *   Hello everyone!
 *   EOF
 *   zano message check
 *   zano message read --channel "#general"
 *   zano message search --query "keyword"
 *   zano server info
 *   zano task list --channel "#general"
 *   zano task create --channel "#general" --title "Fix the bug"
 *   zano task claim --number 3
 *   zano task unclaim --number 3
 *   zano task update --number 3 --status done
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createLocalClient } from "@zano/local-client";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const AGENT_ID = process.env.ZANO_AGENT_ID;
const SUPABASE_URL = process.env.ZANO_SUPABASE_URL;
const SUPABASE_KEY = process.env.ZANO_SUPABASE_KEY;
const AUTH_TOKEN = process.env.ZANO_AUTH_TOKEN;
const LOCAL_SERVER_URL = process.env.ZANO_LOCAL_SERVER_URL;

function fail(code: string, message: string): never {
  process.stderr.write(JSON.stringify({ ok: false, code, message }) + "\n");
  process.exit(1);
}

if (!AGENT_ID) fail("MISSING_AGENT_ID", "ZANO_AGENT_ID is not set");
if (!LOCAL_SERVER_URL && !SUPABASE_URL) {
  fail("MISSING_SUPABASE_URL", "ZANO_SUPABASE_URL is not set");
}
if (!LOCAL_SERVER_URL && !SUPABASE_KEY) {
  fail("MISSING_SUPABASE_KEY", "ZANO_SUPABASE_KEY is not set");
}

const supabase: SupabaseClient = LOCAL_SERVER_URL
  ? (createLocalClient(LOCAL_SERVER_URL) as unknown as SupabaseClient)
  : createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
      ...(AUTH_TOKEN
        ? { global: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } } }
        : {}),
    });

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

function shortId(uuid: string): string {
  return uuid.replace(/-/g, "").substring(0, 8);
}

function fmtTime(iso: string): string {
  return iso.replace(/\.\d+\+/, "+").replace(/\+00:00$/, "Z");
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

  // Try profiles first
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("display_name", personName)
    .single();

  if (profile) {
    personId = profile.id;
  } else {
    // Try agents
    const { data: agent } = await supabase
      .from("agents")
      .select("id")
      .or(`display_name.eq.${personName},name.eq.${personName}`)
      .single();

    if (agent) {
      personId = agent.id;
    }
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
  senderType: string
): Promise<string> {
  if (nameCache.has(senderId)) return nameCache.get(senderId)!;

  let name = "Unknown";
  if (senderType === "agent") {
    const { data } = await supabase
      .from("agents")
      .select("display_name, name")
      .eq("id", senderId)
      .single();
    if (data) name = data.name || data.display_name;
  } else if (senderType === "human") {
    const { data } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", senderId)
      .single();
    if (data) name = data.display_name;
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
        const name = await resolveSenderName(other.member_id, other.member_type);
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
  const senderName = await resolveSenderName(msg.sender_id, msg.sender_type);
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
  return join(process.cwd(), ".zano", "last-checked");
}

function getLastChecked(): string | null {
  const p = getLastCheckedPath();
  if (existsSync(p)) {
    return readFileSync(p, "utf-8").trim();
  }
  return null;
}

function setLastChecked(ts: string) {
  const p = getLastCheckedPath();
  writeFileSync(p, ts, "utf-8");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdMessageSend(flags: Record<string, string>) {
  const target = flags.target;
  if (!target) fail("INVALID_ARG", "Missing --target");

  const content = await readStdin();
  if (!content) fail("INVALID_ARG", "Message content must be provided via stdin");

  const { channelId, threadParentId } = await resolveTarget(target);

  const { data, error } = await supabase
    .from("messages")
    .insert({
      channel_id: channelId,
      sender_id: AGENT_ID,
      sender_type: "agent",
      content,
      thread_parent_id: threadParentId,
    })
    .select("id")
    .single();

  if (error) fail("SEND_FAILED", error.message);

  const sid = shortId(data.id);
  console.log(`Message sent to ${target}. Message ID: ${sid}`);
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

  const channelIds = memberships.map((m) => m.channel_id);

  // Get messages since last check
  const lastChecked = getLastChecked();
  let query = supabase
    .from("messages")
    .select("*")
    .in("channel_id", channelIds)
    .neq("sender_id", AGENT_ID)
    .order("created_at", { ascending: true });

  if (lastChecked) {
    query = query.gt("created_at", lastChecked);
  } else {
    // First check — only get last 5 minutes
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    query = query.gt("created_at", fiveMinAgo);
  }

  const { data: messages } = await query.limit(50);

  if (!messages || messages.length === 0) {
    console.log("No new messages.");
  } else {
    for (const msg of messages) {
      console.log(await formatMessage(msg));
    }
  }

  // Update last-checked timestamp
  setLastChecked(new Date().toISOString());
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

  // Get all agents
  const { data: agents } = await supabase
    .from("agents")
    .select("name, display_name, status, description")
    .order("name");

  console.log("\n## Agents");
  if (agents) {
    for (const ag of agents) {
      const desc = ag.description ? ` — ${ag.description}` : "";
      console.log(`  @${ag.name} "${ag.display_name}" (${ag.status})${desc}`);
    }
  }

  // Get all humans
  const { data: humans } = await supabase
    .from("profiles")
    .select("display_name, email")
    .order("display_name");

  console.log("\n## Humans");
  if (humans) {
    for (const h of humans) {
      console.log(`  @${h.display_name}`);
    }
  }
}

async function cmdTaskList(flags: Record<string, string>) {
  const channel = flags.channel;

  let query = supabase
    .from("tasks")
    .select(
      "id, task_number, status, assignee_id, assignee_type, channel_id, message_id, created_at"
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

  const { data: tasks } = await query;

  if (!tasks || tasks.length === 0) {
    console.log("No tasks.");
    return;
  }

  for (const task of tasks) {
    // Get the message content for the task title
    const { data: msg } = await supabase
      .from("messages")
      .select("content")
      .eq("id", task.message_id)
      .single();

    const title = msg?.content?.substring(0, 80) || "(no content)";
    const assignee = task.assignee_id
      ? await resolveSenderName(
          task.assignee_id,
          task.assignee_type || "agent"
        )
      : "unassigned";

    const chDisplay = await resolveChannelDisplay(task.channel_id);
    console.log(
      `  task #${task.task_number} [${task.status}] ${chDisplay} — ${title} (${assignee})`
    );
  }
}

async function cmdTaskCreate(flags: Record<string, string>) {
  const channel = flags.channel;
  const title = flags.title;
  if (!channel) fail("INVALID_ARG", "Missing --channel");
  if (!title) fail("INVALID_ARG", "Missing --title");

  const { channelId } = await resolveTarget(channel);

  // Create a message first
  const { data: msg, error: msgError } = await supabase
    .from("messages")
    .insert({
      channel_id: channelId,
      sender_id: AGENT_ID,
      sender_type: "agent",
      content: title,
    })
    .select("id")
    .single();

  if (msgError) fail("CREATE_FAILED", msgError.message);

  // Create the task linked to the message
  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .insert({
      message_id: msg.id,
      channel_id: channelId,
    })
    .select("task_number")
    .single();

  if (taskError) fail("CREATE_FAILED", taskError.message);

  console.log(`Task #${task.task_number} created in ${channel}.`);
}

async function cmdTaskClaim(flags: Record<string, string>) {
  const taskNumber = flags.number ? parseInt(flags.number) : null;
  const messageId = flags["message-id"];

  if (!taskNumber && !messageId) {
    fail("INVALID_ARG", "Provide --number or --message-id");
  }

  let query = supabase.from("tasks").select("id, task_number, assignee_id");

  if (taskNumber) {
    query = query.eq("task_number", taskNumber);
  } else if (messageId) {
    query = query.eq("message_id", messageId);
  }

  const { data: task } = await query.single();

  if (!task) fail("CLAIM_FAILED", "Task not found");

  if (task.assignee_id && task.assignee_id !== AGENT_ID) {
    const owner = await resolveSenderName(task.assignee_id, "agent");
    fail(
      "CLAIM_FAILED",
      `Task #${task.task_number} is already claimed by @${owner}`
    );
  }

  const { error } = await supabase
    .from("tasks")
    .update({
      assignee_id: AGENT_ID,
      assignee_type: "agent",
      status: "in_progress",
    })
    .eq("id", task.id);

  if (error) fail("CLAIM_FAILED", error.message);

  console.log(`Task #${task.task_number} claimed and set to in_progress.`);
}

async function cmdTaskUnclaim(flags: Record<string, string>) {
  const taskNumber = flags.number ? parseInt(flags.number) : null;
  if (!taskNumber) fail("INVALID_ARG", "Missing --number");

  const { data: task } = await supabase
    .from("tasks")
    .select("id, task_number, assignee_id")
    .eq("task_number", taskNumber)
    .single();

  if (!task) fail("UNCLAIM_FAILED", "Task not found");

  if (task.assignee_id !== AGENT_ID) {
    fail("UNCLAIM_FAILED", "You are not the assignee of this task");
  }

  const { error } = await supabase
    .from("tasks")
    .update({
      assignee_id: null,
      assignee_type: null,
    })
    .eq("id", task.id);

  if (error) fail("UNCLAIM_FAILED", error.message);

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
    .select("id")
    .eq("task_number", taskNumber)
    .single();

  if (!task) fail("UPDATE_FAILED", "Task not found");

  const { error } = await supabase
    .from("tasks")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", task.id);

  if (error) fail("UPDATE_FAILED", error.message);

  console.log(`Task #${taskNumber} updated to ${status}.`);
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

    case "server info":
      return cmdServerInfo();

    case "task list":
      return cmdTaskList(flags);

    case "task create":
      return cmdTaskCreate(flags);

    case "task claim":
      return cmdTaskClaim(flags);

    case "task unclaim":
      return cmdTaskUnclaim(flags);

    case "task update":
      return cmdTaskUpdate(flags);

    default:
      console.log(`Zano CLI v0.1.0

Usage:
  zano message send --target "#channel"    Send a message (content via stdin)
  zano message check                       Check for new messages
  zano message read --channel "#channel"   Read channel history
  zano message search --query "keyword"    Search messages
  zano server info                         Show server info
  zano task list [--channel "#channel"]    List tasks
  zano task create --channel "#ch" --title "T"  Create a task
  zano task claim --number N               Claim a task
  zano task unclaim --number N             Release a task
  zano task update --number N --status S   Update task status

Environment:
  ZANO_AGENT_ID        Agent UUID
  ZANO_SUPABASE_URL    Supabase project URL
  ZANO_SUPABASE_KEY    Supabase anon key`);
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
