// ============================================================
// Teammate — Shared Types
// ============================================================

// --- Users & Agents ---

export interface User {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
}

export type AgentRuntime = "claude-code" | "codex" | "pi";
export type AgentModel = string;
export type AgentStatus = "online" | "sleeping" | "offline";
export type AgentActivity = "idle" | "thinking" | "working" | "error";

export interface AgentActivityEvent {
  agentId: string;
  activity: AgentActivity;
  /** Human-readable label: "Thinking", "Reading file", "Sending message", etc. */
  label?: string;
  /** Specific detail: file path, command, message target, or agent text output */
  detail?: string;
}

export interface Agent {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  system_prompt: string | null;
  runtime: AgentRuntime;
  model: AgentModel;
  connection_id: string | null;
  status: AgentStatus;
  owner_id: string;
  server_id: string;
  avatar_url: string | null;
  created_at: string;
}

// --- Servers ---

export interface Server {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  owner_id: string;
  created_at: string;
}

export interface ServerMember {
  server_id: string;
  member_id: string;
  member_type: "human" | "agent";
  role: "owner" | "admin" | "member";
  joined_at: string;
}

// --- Channels ---

export type ChannelType = "public" | "private" | "dm";

export interface Channel {
  id: string;
  name: string;
  description: string | null;
  type: ChannelType;
  server_id: string;
  created_by: string;
  created_at: string;
}

export interface ChannelMember {
  channel_id: string;
  member_id: string;
  member_type: "human" | "agent";
  joined_at: string;
}

// --- Messages ---

export type SenderType = "human" | "agent" | "system";

export interface Message {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: SenderType;
  content: string;
  seq: number | null;
  thread_parent_id: string | null;
  created_at: string;
  updated_at: string;
}

// --- Tasks ---

export type TaskStatus = "todo" | "in_progress" | "in_review" | "done";

export interface Task {
  id: string;
  message_id: string;
  channel_id: string;
  task_number: number;
  title: string;
  description: string;
  status: TaskStatus;
  parent_task_id: string | null;
  assignee_id: string | null;
  assignee_type: "human" | "agent" | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

// --- Workspace Documents ---

export interface WorkspaceDocument {
  id: string;
  server_id: string;
  title: string;
  content: string;
  created_by: string | null;
  generated_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceTask {
  id: string;
  message_id: string;
  channel_id: string;
  task_number: number;
  title: string;
  description: string;
  status: "todo" | "in_progress" | "in_review" | "done";
  parent_task_id: string | null;
  assignee_id: string | null;
  assignee_type: "human" | "agent" | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

// --- Bridge Protocol (WebSocket messages between Server <-> Bridge) ---

export type ServerToBridgeMessage =
  | { type: "new_message"; agentId: string; message: Message; channel: Channel }
  | { type: "start_agent"; agentConfig: AgentConfig }
  | { type: "stop_agent"; agentId: string }
  | { type: "ping" };

export type BridgeToServerMessage =
  | { type: "agent_response"; agentId: string; channelId: string; content: string; threadParentId?: string }
  | { type: "agent_status"; agentId: string; status: Agent["status"] }
  | { type: "cli_command"; agentId: string; command: CliCommand }
  | { type: "pong" };

export interface AgentConfig {
  id: string;
  name: string;
  display_name: string;
  description: string;
  system_prompt: string;
  work_dir: string;
}

// --- CLI Commands (what agents can invoke) ---

export type CliCommand =
  | { action: "message_send"; target: string; content: string }
  | { action: "message_check" }
  | { action: "message_read"; channel: string; limit?: number; before?: string; after?: string }
  | { action: "task_list"; channel: string }
  | { action: "task_claim"; taskNumber?: number; messageId?: string }
  | { action: "task_update"; taskNumber: number; status: TaskStatus }
  | { action: "server_info" };

/**
 * Documents are referred to across the app — in messages, in other documents,
 * and by teammates writing through the CLI — so they need one way of being
 * named that survives all three.
 *
 * A reference is an ordinary Markdown link with a `teammate:` scheme:
 *
 *     [关于会议场景的一些看法](teammate:document/02ea4fb3)
 *
 * Nothing new to parse. It is already a link everywhere Markdown is rendered,
 * it carries the title as its text so it stays readable if it is ever pasted
 * somewhere that knows nothing about us, and the renderer turns it into an
 * in-app navigation instead of a trip to the browser.
 *
 * An id prefix is enough, which is what the CLI hands agents.
 */
const DOCUMENT_PREFIX = "teammate:document/";

export function documentLinkHref(id: string) {
  return `${DOCUMENT_PREFIX}${id}`;
}

/** The document a link points at, or null when it points somewhere else. */
export function documentIdFromHref(href: string | undefined | null): string | null {
  if (!href || !href.startsWith(DOCUMENT_PREFIX)) return null;
  const id = href.slice(DOCUMENT_PREFIX.length).trim();
  // Ids and their prefixes are hex and dashes; anything else is not one of ours
  // and must not become a link that navigates.
  return /^[0-9a-f-]{4,64}$/i.test(id) ? id : null;
}

/** The Markdown to paste. Titles with brackets would otherwise break the link. */
export function documentLinkMarkdown(id: string, title: string) {
  const safeTitle = title.replace(/[[\]]/g, "").trim() || "Untitled";
  return `[${safeTitle}](${documentLinkHref(id)})`;
}

export {
  describeSchedule,
  nextRunAfter,
  parseCronExpression,
  validateSchedule,
  type CronFields,
} from "./cron";
export { sanitizeUntrustedContent } from "./untrusted-content";
