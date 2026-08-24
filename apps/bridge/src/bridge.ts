import { createClient, SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { createLocalClient } from "@teammate/local-client";
import { randomUUID } from "node:crypto";
import { readdir, readFile, realpath, lstat } from "fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { homedir } from "os";
import { AgentManager } from "./agent-manager.js";

const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;
const BINARY_SAMPLE_BYTES = 8192;
const DELIVERY_BATCH_SIZE = 50;
const DELIVERY_MAX_ATTEMPTS = 3;
const DELIVERY_LEASE_MS = 5 * 60_000;
const DELIVERY_LEASE_RENEW_MS = 30_000;
const DELIVERY_POLL_MS = 2_000;
const MAX_LOCAL_DELIVERY_GUARDS = 10_000;
// Loop floors for agent-to-agent mention chains (see agentLoopGuardReason).
// These have to stay mechanical: prompt etiquette alone cannot bound a loop.
const AGENT_LOOP_UNCLAIMED_CAP = 8;
const AGENT_LOOP_HARD_CAP = 20;
// How long a teammate's last message keeps an exchange "theirs". Past this the
// channel is quiet again and a new message belongs to the whole room.
const EXCHANGE_ACTIVE_MS = 10 * 60_000;
/**
 * A short pleasantry with no question in it — "morning", "你好呀～", "thanks".
 * Deliberately narrow: it only has to catch the greeting a teammate posts back
 * to the room, and anything longer or containing a question is treated as real
 * content that a teammate may need to see.
 */
function isSocialAcknowledgement(content: string) {
  const text = content.trim();
  if (text.length > 40 || /[?？]/.test(text)) return false;
  const stripped = text
    .replace(/@[^\s,.:!?，。！？、；]+/g, "")
    .replace(/[\s~～!！.。,，、;；:：\-—()（）]/g, "")
    // Chinese greetings routinely carry a trailing particle ("你好呀", "早啊").
    .replace(/[呀啊哈呐哦嗯的了吧么呢啦咯喽噢欸]+$/g, "");
  if (!stripped) return true;
  return /^(你好|您好|哈喽|嗨|早|早安|早上好|中午好|下午好|晚上好|晚安|辛苦|收到|好|谢谢|多谢|不客气|hi|hey|hello|morning|thanks?|thankyou|welcome|ok|okay|yo|sup)+$/i
    .test(stripped);
}
// A message to the room reaches everyone, but not all at once: the teammates
// most recently present answer first, and the rest are only pulled in if the
// room stays silent. Two agents behave exactly as before; twenty do not each
// burn a turn on "morning". Scales without anyone configuring a number.
const ROOM_FANOUT_WIDTH = 3;
const ROOM_FANOUT_INTERVAL_MS = 25_000;
// Proactive owed-work nudges: an assigned task nobody started is the one
// unambiguous "this is your job" signal in the workspace, so it needs no
// classifier. The cooldown and cap bound the cost of an agent that keeps
// declining; a task that moves earns a fresh budget.
const OWED_TASK_SCAN_MS = 60_000;
const OWED_TASK_STALL_MS = 5 * 60_000;
const OWED_TASK_NUDGE_COOLDOWN_MS = 30 * 60_000;
const OWED_TASK_NUDGE_CAP = 3;
const OWED_TASK_NUDGE_BATCH = 3;

function hasHiddenPathSegment(filePath: string) {
  return filePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => segment.startsWith("."));
}

function isWithinRoot(rootPath: string, candidatePath: string) {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  );
}

function isLikelyBinary(content: Buffer) {
  const sample = content.subarray(0, BINARY_SAMPLE_BYTES);
  if (sample.includes(0)) return true;

  let controlBytes = 0;
  for (const byte of sample) {
    if ((byte < 32 && byte !== 8 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) || byte === 127) {
      controlBytes += 1;
    }
  }
  return sample.length > 0 && controlBytes / sample.length > 0.1;
}

function decodeWorkspaceText(content: Buffer) {
  if (isLikelyBinary(content)) throw new Error("Binary files are not supported");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error("Binary files are not supported");
  }
}

interface BridgeConfig {
  supabaseUrl: string;
  supabaseKey: string;    // anon key
  authToken: string;       // JWT for authenticated Supabase operations
  agentAuthTokens?: Record<string, string>;
  userId: string;
  serverId: string;
  agentsDir: string;
  hostname?: string;
  platform?: string;
  arch?: string;
  localMode?: boolean;
  localServerUrl?: string;
  attachmentsDir?: string;
  apiKey?: string;
  refreshAgentAuthTokens?: () => Promise<Record<string, string>>;
}

interface DbMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: "human" | "agent" | "system";
  content: string;
  seq: number;
  thread_parent_id: string | null;
  thread_broadcast?: boolean | number | null;
  created_at: string;
}

interface DbAgent {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  system_prompt: string | null;
  runtime?: string | null;
  model: string;
  status: string;
  owner_id?: string;
  server_id?: string;
}

interface DbChannelMember {
  channel_id: string;
  member_id: string;
  member_type: string;
}

type DeliveryStatus = "pending" | "processing" | "completed" | "skipped" | "failed";

interface DbMessageDelivery {
  message_id: string;
  agent_id: string;
  server_id: string;
  channel_id: string;
  status: DeliveryStatus;
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

export class Bridge {
  private supabase: SupabaseClient;
  private agentManager: AgentManager;
  private config: BridgeConfig;
  // Maps channel_id -> Set of agent_ids in that channel
  private channelAgents = new Map<string, Set<string>>();
  // Maps channel_id -> channel type ('dm' | 'public' | 'private')
  private channelTypes = new Map<string, string>();
  // Maps channel_id -> channel name
  private channelNames = new Map<string, string>();
  // Maps agent_id -> agent DB record
  private agentRecords = new Map<string, DbAgent>();
  // Core database subscriptions are retained so client rotation can replace them atomically.
  private deliveriesChannel: RealtimeChannel | null = null;
  private agentChangesChannel: RealtimeChannel | null = null;
  // Directional private channels for workspace file RPC (web UI ↔ runtime).
  private workspaceRpcRequestChannel: RealtimeChannel | null = null;
  private workspaceRpcResponseChannel: RealtimeChannel | null = null;
  // Heartbeat timer for machine_keys.last_used_at (polling fallback for online status)
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatErrorLogAt = 0;
  private deliveryPollInterval: ReturnType<typeof setInterval> | null = null;
  private owedWorkInterval: ReturnType<typeof setInterval> | null = null;
  private owedWorkScanning = false;
  private deliveryPumpPromise: Promise<void> | null = null;
  private deliveryPumpRequested = false;
  private readonly bridgeInstanceId = randomUUID();
  private readonly locallyDelivered = new Set<string>();
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.supabase = config.localMode
      ? (createLocalClient(
          config.localServerUrl,
          config.authToken,
        ) as unknown as SupabaseClient)
      : createClient(config.supabaseUrl, config.supabaseKey, {
          auth: { autoRefreshToken: false, persistSession: false },
          global: {
            headers: { Authorization: `Bearer ${config.authToken}` },
          },
        });
    // Set auth token for Realtime WebSocket (global headers only cover REST)
    this.supabase.realtime.setAuth(config.authToken);
    this.agentManager = new AgentManager(
      config.agentsDir,
      this.supabase,
      config.supabaseUrl,
      config.supabaseKey,
      config.authToken,
      config.localServerUrl,
      config.serverId,
      config.apiKey || "",
      config.agentAuthTokens ?? {},
      config.refreshAgentAuthTokens,
      { ...(config.attachmentsDir ? { attachmentsDir: config.attachmentsDir } : {}) },
    );
  }

  /** Update the auth token (called on periodic refresh). */
  async updateAuthToken(token: string, agentAuthTokens: Record<string, string> = {}) {
    if (this.stopping) return;
    this.config.authToken = token;
    this.config.agentAuthTokens = agentAuthTokens;
    if (this.config.localMode) {
      this.supabase.realtime.setAuth(token);
      this.agentManager.updateAgentAuthTokens(agentAuthTokens);
      return;
    }

    const previousClient = this.supabase;
    await this.removeBridgeChannels(previousClient);
    if (this.stopping) {
      await previousClient.removeAllChannels();
      return;
    }

    const nextClient = createClient(this.config.supabaseUrl, this.config.supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    nextClient.realtime.setAuth(token);
    this.supabase = nextClient;
    this.agentManager.updateSupabaseClient(nextClient, token, agentAuthTokens);
    await previousClient.removeAllChannels();

    if (this.stopping) {
      await nextClient.removeAllChannels();
      return;
    }
    this.subscribeBridgeChannels();
  }

  async start() {
    // 1. Load this user's agents from DB
    await this.loadAgents();

    // 2. Load channel memberships for these agents
    await this.loadChannelMemberships();

    // 3. Initialize agent workspaces
    for (const [agentId, agent] of this.agentRecords) {
      await this.agentManager.initAgent(agentId, agent);
    }

    // 4. Update agent statuses to 'online' (best-effort DB backup)
    const agentIds = Array.from(this.agentRecords.keys());
    if (agentIds.length > 0) {
      await this.supabase
        .from("agents")
        .update({ status: "online" })
        .in("id", agentIds);
    }

    // 5. Subscribe to durable deliveries, membership changes, and workspace RPC.
    this.subscribeBridgeChannels();

    // 6. Catch up work created while this Bridge was offline. Realtime is only
    // a low-latency wake-up; polling also recovers missed events and expired leases.
    this.startDeliveryPoll();

    // 7. Start heartbeat (updates machine_keys.last_used_at every 30s for polling-based status)
    this.startHeartbeat();

    console.log(
      `  Agent runtime ready. Listening for messages across ${this.channelAgents.size} channel(s).`
    );
    console.log(
      `  Managing ${this.agentRecords.size} agent(s): ${Array.from(this.agentRecords.values()).map((a) => a.display_name).join(", ")}`
    );
  }

  private async loadAgents() {
    const { data: agents, error } = await this.supabase
      .from("agents")
      .select("*")
      .eq("owner_id", this.config.userId)
      .eq("server_id", this.config.serverId);

    if (error) {
      console.error("  Failed to load agents:", error.message);
      return;
    }

    for (const agent of agents || []) {
      if (
        !this.config.agentAuthTokens?.[agent.id]
      ) {
        continue;
      }
      this.agentRecords.set(agent.id, agent as DbAgent);
    }

    console.log(`  Loaded ${this.agentRecords.size} agent(s) from database.`);
  }

  private async loadChannelMemberships() {
    const agentIds = Array.from(this.agentRecords.keys());
    if (agentIds.length === 0) return;

    const { data: memberships, error } = await this.supabase
      .from("channel_members")
      .select("channel_id, member_id")
      .eq("member_type", "agent")
      .in("member_id", agentIds);

    if (error) {
      console.error("  Failed to load memberships:", error.message);
      return;
    }

    const channelIds = new Set<string>();
    for (const m of memberships || []) {
      const mem = m as DbChannelMember;
      if (!this.channelAgents.has(mem.channel_id)) {
        this.channelAgents.set(mem.channel_id, new Set());
      }
      this.channelAgents.get(mem.channel_id)!.add(mem.member_id);
      channelIds.add(mem.channel_id);
    }

    // Load channel types and names
    if (channelIds.size > 0) {
      const { data: channels } = await this.supabase
        .from("channels")
        .select("id, name, type")
        .in("id", Array.from(channelIds));

      for (const ch of channels || []) {
        this.channelTypes.set(ch.id, ch.type);
        this.channelNames.set(ch.id, ch.name);
      }
    }
  }

  private subscribeBridgeChannels() {
    this.subscribeToDeliveries();
    this.subscribeToAgentChanges();
    this.subscribeToWorkspaceRpc();
  }

  private async removeBridgeChannels(client: SupabaseClient) {
    const channels = [
      this.deliveriesChannel,
      this.agentChangesChannel,
      this.workspaceRpcRequestChannel,
      this.workspaceRpcResponseChannel,
    ].filter((channel): channel is RealtimeChannel => channel !== null);

    this.deliveriesChannel = null;
    this.agentChangesChannel = null;
    this.workspaceRpcRequestChannel = null;
    this.workspaceRpcResponseChannel = null;

    await Promise.allSettled(channels.map((channel) => client.removeChannel(channel)));
  }

  private subscribeToDeliveries() {
    this.deliveriesChannel = this.supabase
      .channel(`bridge-deliveries:${this.config.serverId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "message_deliveries",
          filter: `server_id=eq.${this.config.serverId}`,
        },
        (payload) => {
          const delivery = payload.new as DbMessageDelivery;
          if (
            delivery.server_id === this.config.serverId &&
            this.agentRecords.has(delivery.agent_id)
          ) {
            void this.requestDeliveryPump();
          }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log("  Subscribed to durable agent deliveries.");
          void this.requestDeliveryPump();
        } else if (status === "CHANNEL_ERROR") {
          console.error("  Agent delivery subscription error; polling remains active.");
        }
      });
  }

  /**
   * Parse @mentions from message content.
   * Stable handles win; display names are compatibility aliases only when
   * unique across the complete, current channel membership.
   */
  private parseMentionedAgents(
    content: string,
    channelAgents: Map<string, Pick<DbAgent, "id" | "name" | "display_name">>,
  ): Set<string> {
    const mentioned = new Set<string>();
    const stableNameOwners = new Map<string, Set<string>>();
    const displayNameCounts = new Map<string, number>();
    for (const [agentId, agent] of channelAgents) {
      const stableKey = agent.name.toLocaleLowerCase();
      const stableOwners = stableNameOwners.get(stableKey) || new Set<string>();
      stableOwners.add(agentId);
      stableNameOwners.set(stableKey, stableOwners);
      const displayKey = agent.display_name.toLocaleLowerCase();
      displayNameCounts.set(displayKey, (displayNameCounts.get(displayKey) || 0) + 1);
    }
    const hasMention = (name: string) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`@${escaped}(?=[\\s,.:!?，。！？、；]|$)`, "i").test(content);
    };
    for (const [agentId, agent] of channelAgents) {
      const stableOwners = stableNameOwners.get(agent.name.toLocaleLowerCase());
      if (stableOwners?.size === 1 && hasMention(agent.name)) {
        mentioned.add(agentId);
        continue;
      }
      const displayKey = agent.display_name.toLocaleLowerCase();
      const displayStableOwners = stableNameOwners.get(displayKey);
      if (
        displayNameCounts.get(displayKey) === 1 &&
        (!displayStableOwners ||
          (displayStableOwners.size === 1 && displayStableOwners.has(agentId))) &&
        hasMention(agent.display_name)
      ) {
        mentioned.add(agentId);
      }
    }
    return mentioned;
  }

  private async loadCurrentChannelMentionAgents(channelId: string) {
    const { data, error } = await this.supabase.rpc("list_channel_agent_mentions", {
      channel_uuid: channelId,
    });
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) throw new Error("Channel mention directory is invalid");
    const mentions = new Map<string, Pick<DbAgent, "id" | "name" | "display_name">>();
    for (const candidate of data) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        typeof candidate.id !== "string" ||
        typeof candidate.name !== "string" ||
        typeof candidate.display_name !== "string" ||
        mentions.has(candidate.id)
      ) {
        throw new Error("Channel mention directory is invalid");
      }
      mentions.set(candidate.id, {
        id: candidate.id,
        name: candidate.name,
        display_name: candidate.display_name,
      });
    }
    return mentions;
  }

  /**
   * Channels behave like Slack: teammates handle their own conversations
   * without being re-mentioned every message. A human message reaches an
   * unmentioned agent when it is plainly part of that agent's conversation —
   * the agent is the only one in the channel, the message continues a thread
   * the agent is part of, or the agent spoke in the immediately preceding
   * flow. Mentioning a different agent always redirects the message instead.
   */
  private async implicitConversationReason(
    delivery: DbMessageDelivery,
    msg: DbMessage,
    channelAgents: Map<string, Pick<DbAgent, "id" | "name" | "display_name">>,
  ): Promise<string | null> {
    if (channelAgents.size === 1 && channelAgents.has(delivery.agent_id)) {
      return "only agent";
    }
    if (this.parseMentionedAgents(msg.content, channelAgents).size > 0) return null;

    if (this.threadScoped(msg)) {
      const [parentResult, replyResult] = await Promise.all([
        this.supabase
          .from("messages")
          .select("sender_id, sender_type")
          .eq("id", msg.thread_parent_id)
          .maybeSingle(),
        this.supabase
          .from("messages")
          .select("id")
          .eq("channel_id", msg.channel_id)
          .eq("thread_parent_id", msg.thread_parent_id)
          .eq("sender_id", delivery.agent_id)
          .eq("sender_type", "agent")
          .limit(1),
      ]);
      if (parentResult.error) throw new Error(parentResult.error.message);
      if (replyResult.error) throw new Error(replyResult.error.message);
      const parent = parentResult.data as { sender_id: string; sender_type: string } | null;
      if (parent?.sender_type === "agent" && parent.sender_id === delivery.agent_id) {
        return "their thread";
      }
      if (((replyResult.data || []) as unknown[]).length > 0) return "thread participant";
      return null;
    }

    // Conversational continuation: within the last two main-flow messages, the
    // most recent agent speaker owns the exchange. Requiring "most recent"
    // keeps two recently active agents from both answering the same human.
    const { data, error } = await this.supabase
      .from("messages")
      .select("sender_id, sender_type, created_at")
      .eq("channel_id", msg.channel_id)
      .is("thread_parent_id", null)
      .lt("seq", msg.seq)
      .order("seq", { ascending: false })
      .limit(2);
    if (error) throw new Error(error.message);
    const recent = (data || []) as Array<{
      created_at: string;
      sender_id: string;
      sender_type: string;
    }>;
    const cutoff = Date.parse(msg.created_at) - EXCHANGE_ACTIVE_MS;
    const lastAgentSpeaker = recent.find(
      (row) => row.sender_type === "agent" && Date.parse(row.created_at) >= cutoff,
    );
    if (lastAgentSpeaker?.sender_id === delivery.agent_id) {
      return "conversation continuation";
    }
    return null;
  }

  /**
   * Which wave of the room fan-out this teammate belongs to. Whoever spoke in
   * the channel most recently is treated as most present and goes first; those
   * who have never spoken here are asked last.
   */
  private async roomFanoutWave(
    delivery: DbMessageDelivery,
    msg: DbMessage,
    channelAgents: Map<string, Pick<DbAgent, "id" | "name" | "display_name">>,
  ) {
    if (channelAgents.size <= ROOM_FANOUT_WIDTH) return 0;
    const { data, error } = await this.supabase
      .from("messages")
      .select("sender_id, seq")
      .eq("channel_id", msg.channel_id)
      .eq("sender_type", "agent")
      .lt("seq", msg.seq)
      .order("seq", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    const lastSpoke = new Map<string, number>();
    for (const row of (data || []) as Array<{ sender_id: string; seq: number }>) {
      if (!lastSpoke.has(row.sender_id)) lastSpoke.set(row.sender_id, Number(row.seq));
    }
    const ordered = [...channelAgents.keys()].sort((left, right) => {
      const difference = (lastSpoke.get(right) ?? -1) - (lastSpoke.get(left) ?? -1);
      // Ties (nobody has spoken) fall back to a stable order so every bridge
      // process and restart computes the same waves.
      return difference !== 0 ? difference : left.localeCompare(right);
    });
    const position = ordered.indexOf(delivery.agent_id);
    return position < 0 ? 0 : Math.floor(position / ROOM_FANOUT_WIDTH);
  }

  /**
   * A reply the author also sent to the channel is addressed to the room, so
   * every rule below treats it as if it had been posted at the top level.
   */
  private threadScoped(msg: DbMessage) {
    if (!msg.thread_parent_id) return false;
    return !(msg.thread_broadcast === true || msg.thread_broadcast === 1);
  }

  /**
   * True when a thread already belongs to some teammate — its root is theirs,
   * or one of them has spoken in it. Those threads are private conversations
   * and stay that way. A thread nobody has joined is still just a room.
   */
  private async threadHasTeammate(msg: DbMessage) {
    if (!this.threadScoped(msg)) return false;
    const [parentResult, replyResult] = await Promise.all([
      this.supabase
        .from("messages")
        .select("sender_type")
        .eq("id", msg.thread_parent_id)
        .maybeSingle(),
      this.supabase
        .from("messages")
        .select("id")
        .eq("channel_id", msg.channel_id)
        .eq("thread_parent_id", msg.thread_parent_id)
        .eq("sender_type", "agent")
        .limit(1),
    ]);
    if (parentResult.error) throw new Error(parentResult.error.message);
    if (replyResult.error) throw new Error(replyResult.error.message);
    const parent = parentResult.data as { sender_type: string } | null;
    if (parent?.sender_type === "agent") return true;
    return ((replyResult.data || []) as unknown[]).length > 0;
  }

  /**
   * True while another teammate is still working on this very message.
   *
   * `someoneAnswered` only sees an answer once it has been posted, so on its
   * own it would let a teammate waiting behind a slow one start a second reply
   * to the same question — the exchange's owner thinking for longer than a
   * wave interval is normal, not a failure. Their delivery row says so
   * directly: still pending or processing means still theirs.
   */
  private async anotherTeammateIsWorkingOn(delivery: DbMessageDelivery, msg: DbMessage) {
    const { data, error } = await this.supabase
      .from("message_deliveries")
      .select("agent_id, status")
      .eq("message_id", msg.id)
      .in("status", ["pending", "processing"]);
    if (error) throw new Error(error.message);
    return ((data || []) as Array<{ agent_id: string; status: string }>).some(
      (row) => row.agent_id !== delivery.agent_id && row.status === "processing",
    );
  }

  /** True once any agent has spoken after this message. */
  private async someoneAnswered(msg: DbMessage) {
    const { data, error } = await this.supabase
      .from("messages")
      .select("id")
      .eq("channel_id", msg.channel_id)
      .eq("sender_type", "agent")
      .gt("seq", msg.seq)
      .limit(1);
    if (error) throw new Error(error.message);
    return ((data || []) as unknown[]).length > 0;
  }

  /**
   * Hand a claimed delivery back for a later wave. Waiting is not a failed
   * attempt, so the retry budget the claim consumed is returned — otherwise a
   * teammate in the third wave would exhaust it before ever being asked.
   */
  private async deferDelivery(delivery: DbMessageDelivery, readyAtMs: number) {
    const { error } = await this.supabase
      .from("message_deliveries")
      .update({
        status: "pending",
        attempts: Math.max(0, delivery.attempts - 1),
        claim_token: null,
        claimed_by: null,
        lease_expires_at: null,
        next_attempt_at: new Date(readyAtMs).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("message_id", delivery.message_id)
      .eq("agent_id", delivery.agent_id)
      .eq("server_id", this.config.serverId)
      .eq("claim_token", delivery.claim_token);
    if (error) throw new Error(error.message);
  }

  /**
   * True when a teammate is still visibly in conversation here, so a follow-up
   * belongs to them rather than to the room. Conversations go cold: an agent
   * who answered an hour ago is not "mid-exchange", and someone returning to a
   * quiet channel should be heard by everyone in it.
   */
  private async exchangeIsUnderway(msg: DbMessage) {
    const { data, error } = await this.supabase
      .from("messages")
      .select("sender_type, created_at")
      .eq("channel_id", msg.channel_id)
      .is("thread_parent_id", null)
      .lt("seq", msg.seq)
      .order("seq", { ascending: false })
      .limit(2);
    if (error) throw new Error(error.message);
    const cutoff = Date.parse(msg.created_at) - EXCHANGE_ACTIVE_MS;
    return ((data || []) as Array<{ sender_type: string; created_at: string }>).some(
      (row) => row.sender_type === "agent" && Date.parse(row.created_at) >= cutoff,
    );
  }

  /**
   * Deterministic floor under agent-to-agent mentions, adapted from Cumora's
   * loop floors: prompt etiquette shapes behavior, but only a mechanical cap
   * guarantees two agents cannot mention-bounce forever. Counts the unbroken
   * run of agent messages since a human last spoke in the channel; an
   * in-progress task raises the ceiling because owned work legitimately needs
   * longer agent exchanges.
   */
  private async agentLoopGuardReason(
    delivery: DbMessageDelivery,
    msg: DbMessage,
  ): Promise<string | null> {
    const { data, error } = await this.supabase
      .from("messages")
      .select("sender_type")
      .eq("channel_id", msg.channel_id)
      .lte("seq", msg.seq)
      .order("seq", { ascending: false })
      .limit(AGENT_LOOP_HARD_CAP + 1);
    if (error) throw new Error(error.message);
    const rows = (data || []) as Array<{ sender_type: string }>;
    let runLength = 0;
    for (const row of rows) {
      if (row.sender_type === "human") break;
      if (row.sender_type === "agent") runLength += 1;
    }
    if (runLength < AGENT_LOOP_UNCLAIMED_CAP) return null;
    if (runLength >= AGENT_LOOP_HARD_CAP) {
      return "Agent-only exchange reached the hard loop cap; waiting for a human to weigh in";
    }
    const { data: activeTask, error: taskError } = await this.supabase
      .from("tasks")
      .select("id")
      .eq("channel_id", msg.channel_id)
      .eq("status", "in_progress")
      .is("archived_at", null)
      .limit(1);
    if (taskError) throw new Error(taskError.message);
    if (((activeTask || []) as unknown[]).length > 0) return null;
    return "Agent-only exchange with no in-progress task wound down by the loop guard";
  }

  /**
   * DMs normally rely on the runtime's own session memory. When that session
   * is missing or belongs to another runtime (new agent, workspace reset,
   * engine switch), prefix recent history so the agent does not greet its own
   * conversation as a stranger.
   */
  private async getDmColdStartContext(delivery: DbMessageDelivery, msg: DbMessage) {
    const { data, error } = await this.supabase
      .from("agents")
      .select("runtime, runtime_session_id, runtime_session_runtime, session_id")
      .eq("id", delivery.agent_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const stored = (data || {}) as {
      runtime?: string | null;
      runtime_session_id?: string | null;
      runtime_session_runtime?: string | null;
      session_id?: string | null;
    };
    const runtime = stored.runtime || "codex";
    const hasUsableSession = stored.runtime_session_runtime === runtime
      ? Boolean(stored.runtime_session_id)
      : runtime === "claude-code" && !stored.runtime_session_runtime && Boolean(stored.session_id);
    if (hasUsableSession) return "";
    return this.getChannelContext(msg.channel_id, 10, msg.id);
  }

  /**
   * Fetch recent channel history for context.
   */
  private async getChannelContext(
    channelId: string,
    limit: number = 10,
    excludeMessageId?: string,
    channelAgents?: Map<string, Pick<DbAgent, "id" | "name" | "display_name">>,
  ): Promise<string> {
    let query = this.supabase
      .from("messages")
      .select("sender_id, sender_type, content, created_at")
      .eq("channel_id", channelId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (excludeMessageId) query = query.neq("id", excludeMessageId);
    const { data: messages } = await query;

    if (!messages || messages.length === 0) return "";

    const lines = messages.reverse().map((m) => {
      let senderName = "Unknown";
      if (m.sender_type === "human") {
        senderName = "User";
      } else if (m.sender_type === "system") {
        senderName = "System";
      } else {
        const agent = channelAgents?.get(m.sender_id) || this.agentRecords.get(m.sender_id);
        senderName = agent?.display_name || "Agent";
      }
      return `[${senderName}]: ${m.content.substring(0, 300)}`;
    });

    return `\n--- Recent channel messages ---\n${lines.join("\n")}\n---`;
  }

  /**
   * Resolve the display name for a sender_id (human or agent).
   */
  private async resolveSenderName(
    senderId: string,
    senderType: string,
    channelAgents?: Map<string, Pick<DbAgent, "id" | "name" | "display_name">>,
  ): Promise<string> {
    if (senderType === "agent") {
      const agent = channelAgents?.get(senderId) || this.agentRecords.get(senderId);
      if (agent) return agent.display_name;
    }

    // Try profiles table for humans
    const { data } = await this.supabase
      .from("profiles")
      .select("display_name")
      .eq("id", senderId)
      .single();
    return data?.display_name || "User";
  }

  /**
   * Build a target string for the channel (e.g. "#general", "dm:@alice").
   */
  private buildChannelTarget(channelId: string, senderName?: string): string {
    const ch = this.channelTypes.get(channelId);
    if (ch === "dm" && senderName) {
      return `dm:@${senderName}`;
    }
    // For non-DM channels, find the channel name
    for (const [id, info] of this.channelNames) {
      if (id === channelId) return `#${info}`;
    }
    return channelId;
  }

  private startDeliveryPoll() {
    if (this.deliveryPollInterval) clearInterval(this.deliveryPollInterval);
    this.deliveryPollInterval = setInterval(() => {
      void this.requestDeliveryPump();
    }, DELIVERY_POLL_MS);
    void this.requestDeliveryPump();

    if (this.owedWorkInterval) clearInterval(this.owedWorkInterval);
    this.owedWorkInterval = setInterval(() => {
      void this.scanOwedWork().catch((error: unknown) => {
        console.error(
          "  Could not scan for owed work:",
          error instanceof Error ? error.message : error,
        );
      });
    }, OWED_TASK_SCAN_MS);
    this.owedWorkInterval.unref?.();
  }

  /**
   * Wake agents for work that is theirs but that nobody pinged them about: a
   * task assigned to them still sitting in `todo`. This is the proactive half
   * of "agents are teammates" — a colleague picks up their own assignments
   * without being reminded every time.
   *
   * Everything here is deterministic DB fact. Turning a nudge into a turn
   * costs a claim (see `claim_task_nudge`), so a declining agent is asked at
   * most `OWED_TASK_NUDGE_CAP` times per task revision.
   */
  private async scanOwedWork() {
    if (this.stopping || this.owedWorkScanning || !this.config.localMode) return;
    const agentIds = [...this.agentRecords.keys()];
    if (agentIds.length === 0) return;
    this.owedWorkScanning = true;
    try {
      const cutoff = new Date(Date.now() - OWED_TASK_STALL_MS).toISOString();
      const { data, error } = await this.supabase
        .from("tasks")
        .select("id, task_number, title, channel_id, assignee_id, updated_at")
        .eq("assignee_type", "agent")
        .in("assignee_id", agentIds)
        .eq("status", "todo")
        .is("archived_at", null)
        .lt("updated_at", cutoff)
        .order("updated_at", { ascending: true })
        .limit(OWED_TASK_NUDGE_BATCH * 4);
      if (error) throw new Error(error.message);
      const tasks = (data || []) as Array<{
        id: string;
        task_number: number;
        title: string;
        channel_id: string;
        assignee_id: string;
        updated_at: string;
      }>;

      let nudged = 0;
      for (const task of tasks) {
        if (this.stopping || nudged >= OWED_TASK_NUDGE_BATCH) break;
        const agent = this.agentRecords.get(task.assignee_id);
        if (!agent || this.agentManager.isBusy(task.assignee_id)) continue;
        if (!(await this.isCurrentChannelAgent(task.assignee_id, task.channel_id))) continue;

        const claim = await this.supabase.rpc("claim_task_nudge", {
          task_uuid: task.id,
          agent_uuid: task.assignee_id,
          task_updated_at: task.updated_at,
          cooldown_ms: OWED_TASK_NUDGE_COOLDOWN_MS,
          max_nudges: OWED_TASK_NUDGE_CAP,
        });
        if (claim.error) throw new Error(claim.error.message);
        if (!(claim.data as { claimed?: boolean } | null)?.claimed) continue;

        nudged += 1;
        const target = this.buildChannelTarget(task.channel_id);
        const prompt =
          `[target=${target} time=${new Date().toISOString()} sender=@teammate type=system delivery=owed-work]\n` +
          `Task #${task.task_number} "${task.title}" is assigned to you and still unstarted. ` +
          `If you can take it, claim it with \`teammate task claim ${task.task_number}\` and do the work. ` +
          `If you cannot — blocked, missing input, or it is not really yours — say so once in ${target} and reassign or leave it. ` +
          `Nobody is waiting on a reply to this notice itself.`;
        console.log(`  [${agent.display_name}] Owed work: task #${task.task_number}.`);
        await this.agentManager.sendToAgent(task.assignee_id, prompt, task.channel_id, {
          ambient: true,
        });
      }
    } finally {
      this.owedWorkScanning = false;
    }
  }

  /** Coalesce Realtime and polling wake-ups into one queue drain. */
  private requestDeliveryPump(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.deliveryPumpRequested = true;
    if (this.deliveryPumpPromise) return this.deliveryPumpPromise;

    this.deliveryPumpPromise = this.runDeliveryPump()
      .catch((error) => {
        console.error(
          "  Could not drain agent deliveries:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        this.deliveryPumpPromise = null;
        if (this.deliveryPumpRequested && !this.stopping) {
          void this.requestDeliveryPump();
        }
      });
    return this.deliveryPumpPromise;
  }

  private async runDeliveryPump() {
    do {
      this.deliveryPumpRequested = false;
      await this.drainDeliveryQueue();
    } while (this.deliveryPumpRequested && !this.stopping);
  }

  private async drainDeliveryQueue() {
    while (!this.stopping) {
      const candidates = await this.loadDeliveryCandidates();
      if (candidates.length === 0) return;

      const claimed: DbMessageDelivery[] = [];
      for (const candidate of candidates) {
        if (this.stopping) return;
        if (candidate.attempts >= DELIVERY_MAX_ATTEMPTS) {
          await this.markExhaustedDelivery(candidate);
          continue;
        }
        const delivery = await this.claimDelivery(candidate);
        if (delivery) claimed.push(delivery);
      }

      if (claimed.length === 0) return;
      await Promise.all(claimed.map((delivery) => this.processClaimedDelivery(delivery)));
    }
  }

  private async loadDeliveryCandidates(): Promise<DbMessageDelivery[]> {
    const agentIds = Array.from(this.agentRecords.keys());
    if (agentIds.length === 0) return [];
    const now = new Date().toISOString();

    const [pendingResult, expiredResult, unleasedResult] = await Promise.all([
      this.supabase
        .from("message_deliveries")
        .select("*")
        .eq("server_id", this.config.serverId)
        .in("agent_id", agentIds)
        .eq("status", "pending")
        .lte("next_attempt_at", now)
        .order("created_at", { ascending: true })
        .limit(DELIVERY_BATCH_SIZE),
      this.supabase
        .from("message_deliveries")
        .select("*")
        .eq("server_id", this.config.serverId)
        .in("agent_id", agentIds)
        .eq("status", "processing")
        .lte("lease_expires_at", now)
        .order("created_at", { ascending: true })
        .limit(DELIVERY_BATCH_SIZE),
      this.supabase
        .from("message_deliveries")
        .select("*")
        .eq("server_id", this.config.serverId)
        .in("agent_id", agentIds)
        .eq("status", "processing")
        .is("lease_expires_at", null)
        .order("created_at", { ascending: true })
        .limit(DELIVERY_BATCH_SIZE),
    ]);

    if (pendingResult.error) throw new Error(pendingResult.error.message);
    if (expiredResult.error) throw new Error(expiredResult.error.message);
    if (unleasedResult.error) throw new Error(unleasedResult.error.message);

    const byKey = new Map<string, DbMessageDelivery>();
    for (const raw of [
      ...(pendingResult.data || []),
      ...(expiredResult.data || []),
      ...(unleasedResult.data || []),
    ]) {
      const delivery = raw as DbMessageDelivery;
      byKey.set(this.deliveryKey(delivery), delivery);
    }
    return Array.from(byKey.values())
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .slice(0, DELIVERY_BATCH_SIZE);
  }

  /** Atomic compare-and-swap claim. Concurrent Bridges can only win once. */
  private async claimDelivery(candidate: DbMessageDelivery): Promise<DbMessageDelivery | null> {
    const claimToken = randomUUID();
    const now = new Date();
    let query = this.supabase
      .from("message_deliveries")
      .update({
        status: "processing",
        attempts: candidate.attempts + 1,
        claim_token: claimToken,
        claimed_by: this.bridgeInstanceId,
        lease_expires_at: new Date(now.getTime() + DELIVERY_LEASE_MS).toISOString(),
        next_attempt_at: now.toISOString(),
        last_error: null,
        updated_at: now.toISOString(),
      })
      .eq("message_id", candidate.message_id)
      .eq("agent_id", candidate.agent_id)
      .eq("server_id", this.config.serverId)
      .eq("status", candidate.status)
      .eq("attempts", candidate.attempts);
    query = candidate.claim_token === null
      ? query.is("claim_token", null)
      : query.eq("claim_token", candidate.claim_token);
    if (candidate.status === "processing") {
      query = candidate.lease_expires_at === null
        ? query.is("lease_expires_at", null)
        : query.eq("lease_expires_at", candidate.lease_expires_at);
    }
    const { data, error } = await query.select("*").maybeSingle();
    if (error) throw new Error(error.message);
    return data ? data as DbMessageDelivery : null;
  }

  private async markExhaustedDelivery(candidate: DbMessageDelivery) {
    const now = new Date().toISOString();
    let query = this.supabase
      .from("message_deliveries")
      .update({
        status: "failed",
        claim_token: null,
        claimed_by: null,
        lease_expires_at: null,
        last_error: candidate.last_error || "Delivery retry limit reached",
        updated_at: now,
      })
      .eq("message_id", candidate.message_id)
      .eq("agent_id", candidate.agent_id)
      .eq("server_id", this.config.serverId)
      .eq("status", candidate.status)
      .eq("attempts", candidate.attempts);
    query = candidate.claim_token === null
      ? query.is("claim_token", null)
      : query.eq("claim_token", candidate.claim_token);
    if (candidate.status === "processing") {
      query = candidate.lease_expires_at === null
        ? query.is("lease_expires_at", null)
        : query.eq("lease_expires_at", candidate.lease_expires_at);
    }
    const { error } = await query;
    if (error) throw new Error(error.message);
  }

  private async processClaimedDelivery(delivery: DbMessageDelivery) {
    let leaseValid = true;
    const renewTimer = setInterval(() => {
      void this.renewDeliveryLease(delivery).then((renewed) => {
        if (!renewed) leaseValid = false;
      }).catch(() => {
        leaseValid = false;
      });
    }, DELIVERY_LEASE_RENEW_MS);

    try {
      await this.executeClaimedDelivery(delivery, async () => {
        if (!leaseValid) return false;
        leaseValid = await this.renewDeliveryLease(delivery);
        return leaseValid;
      });
    } catch (error) {
      try {
        await this.failDelivery(delivery, error);
      } catch (updateError) {
        console.error(
          `  Could not persist failed delivery ${this.deliveryKey(delivery)}:`,
          updateError instanceof Error ? updateError.message : updateError,
        );
      }
    } finally {
      clearInterval(renewTimer);
    }
  }

  private async executeClaimedDelivery(
    delivery: DbMessageDelivery,
    ensureLease: () => Promise<boolean>,
  ) {
    const key = this.deliveryKey(delivery);
    if (this.locallyDelivered.has(key)) {
      await this.finishDelivery(delivery, "completed");
      return;
    }
    if (delivery.server_id !== this.config.serverId) {
      await this.finishDelivery(delivery, "skipped", "Delivery belongs to another workspace");
      return;
    }

    const agent = this.agentRecords.get(delivery.agent_id);
    if (!agent || agent.server_id !== this.config.serverId) {
      await this.finishDelivery(delivery, "skipped", "Agent is no longer managed by this Bridge");
      return;
    }

    if (!(await this.isCurrentAgentMembership(delivery))) {
      await this.finishDelivery(delivery, "skipped", "Agent is no longer a channel member");
      return;
    }

    const [channelResult, messageResult] = await Promise.all([
      this.supabase
        .from("channels")
        .select("id, name, type, server_id")
        .eq("id", delivery.channel_id)
        .maybeSingle(),
      this.supabase
        .from("messages")
        .select(
          "id, channel_id, sender_id, sender_type, content, seq, thread_parent_id, thread_broadcast, created_at",
        )
        .eq("id", delivery.message_id)
        .maybeSingle(),
    ]);
    if (channelResult.error) throw new Error(channelResult.error.message);
    if (messageResult.error) throw new Error(messageResult.error.message);
    if (!channelResult.data || channelResult.data.server_id !== this.config.serverId) {
      await this.finishDelivery(delivery, "skipped", "Channel is missing or belongs to another workspace");
      return;
    }
    const msg = messageResult.data as DbMessage | null;
    if (
      !msg ||
      msg.channel_id !== delivery.channel_id ||
      (msg.sender_type !== "human" && msg.sender_type !== "agent")
    ) {
      await this.finishDelivery(delivery, "skipped", "Message is missing or has an unsupported sender");
      return;
    }

    const channel = channelResult.data as {
      id: string;
      name: string;
      type: string;
      server_id: string;
    };
    const isDm = channel.type === "dm";
    const isAgentAssignment = msg.sender_type === "agent";
    if (isAgentAssignment && msg.sender_id === delivery.agent_id) {
      await this.finishDelivery(delivery, "skipped", "An agent cannot deliver a task mention to itself");
      return;
    }
    if (
      isAgentAssignment &&
      !(await this.isCurrentChannelAgent(msg.sender_id, delivery.channel_id))
    ) {
      await this.finishDelivery(delivery, "skipped", "The sending agent is no longer a channel member");
      return;
    }
    let channelAgents:
      | Map<string, Pick<DbAgent, "id" | "name" | "display_name">>
      | undefined;
    let ambientReason: string | null = null;
    // Whether a teammate had already replied by the time this delivery came up.
    let answeredAlready = false;
    if (isAgentAssignment || !isDm) {
      channelAgents = await this.loadCurrentChannelMentionAgents(delivery.channel_id);
      const mentioned = this.parseMentionedAgents(msg.content, channelAgents);
      if (!mentioned.has(delivery.agent_id)) {
        // A mention redirects: naming one teammate keeps the rest out of it.
        if (mentioned.size > 0) {
          await this.finishDelivery(delivery, "skipped", "Another teammate was named");
          return;
        }
        // Nobody was named. A person talking to the room reaches everyone in
        // it — deciding whether a message is "for you" is the teammate's job,
        // not a rule applied before they ever see it. Silence when someone
        // reaches out is the worst outcome this system can produce.
        // Agent-authored messages stay narrower: they reach a teammate whose
        // conversation they continue, and the loop guard bounds the run.
        if (isAgentAssignment) {
          // A teammate greeting the room back is not addressed to the other
          // agents and needs no answer from them. Waking everyone for it costs
          // a full turn per agent and produces nothing.
          if (isSocialAcknowledgement(msg.content)) {
            await this.finishDelivery(
              delivery,
              "skipped",
              "Teammate's social message needs no reply",
            );
            return;
          }
          ambientReason = await this.implicitConversationReason(delivery, msg, channelAgents);
          if (!ambientReason) {
            await this.finishDelivery(
              delivery,
              "skipped",
              "Agent message outside this teammate's conversations",
            );
            return;
          }
        } else {
          const mine = await this.implicitConversationReason(delivery, msg, channelAgents);
          if (mine) {
            ambientReason = mine;
          } else {
            // Someone else may already be mid-conversation here, or this may
            // belong to a thread that is not yours. That used to end it: the
            // delivery was dropped and the teammate never saw the message at
            // all, so a thread one teammate had answered once was closed to
            // every other teammate forever — even when the next question was
            // plainly for one of them.
            //
            // Being outside the conversation is now a place in the queue
            // rather than a bar. Whoever is in it is asked first and answers;
            // `someoneAnswered` then stands the rest down before they cost a
            // turn. What changes is the case where nobody answers — because
            // the teammate had nothing to say, or was stuck, or the exchange
            // had simply moved on — where the room now gets its turn instead
            // of the message going unanswered by everyone.
            const outsideConversation = this.threadScoped(msg)
              ? await this.threadHasTeammate(msg)
              : await this.exchangeIsUnderway(msg);
            const wave =
              (await this.roomFanoutWave(delivery, msg, channelAgents)) +
              (outsideConversation ? 1 : 0);
            if (wave > 0) {
              const readyAt = Date.parse(msg.created_at) + wave * ROOM_FANOUT_INTERVAL_MS;
              if (Date.now() < readyAt) {
                await this.deferDelivery(delivery, readyAt);
                return;
              }
              // Someone answering used to end it here. But "你俩想啥时候下班"
              // is addressed to two people, and one reply does not cover it —
              // and no rule can tell that message from "有人在吗", where one
              // reply does. So this stops deciding: the message goes through
              // with the fact attached, and the teammate weighs whether it has
              // anything left for them. Answering second is a cost of one turn;
              // a question to two people getting one answer is a worse room.
              answeredAlready = await this.someoneAnswered(msg);
              // Nobody has answered yet, but someone may still be writing one.
              // Waiting another interval costs nothing; two teammates
              // answering the same question costs the reader.
              if (await this.anotherTeammateIsWorkingOn(delivery, msg)) {
                await this.deferDelivery(delivery, Date.now() + ROOM_FANOUT_INTERVAL_MS);
                return;
              }
            }
            // The reason is the teammate's cue: "in the room" is a message
            // addressed to everyone, where "unanswered" means it was somebody
            // else's and they have not taken it.
            ambientReason = answeredAlready
              ? "already answered"
              : outsideConversation
                ? "unanswered"
                : "in the room";
          }
        }
      }
      if (isAgentAssignment) {
        const loopGuard = await this.agentLoopGuardReason(delivery, msg);
        if (loopGuard) {
          await this.finishDelivery(delivery, "skipped", loopGuard);
          return;
        }
      }
    }

    this.channelTypes.set(channel.id, channel.type);
    this.channelNames.set(channel.id, channel.name);
    const senderName = await this.resolveSenderName(
      msg.sender_id,
      msg.sender_type,
      channelAgents,
    );
    const channelTarget = this.buildChannelTarget(msg.channel_id, senderName);
    const contextPrefix = isDm
      ? await this.getDmColdStartContext(delivery, msg)
      : await this.getChannelContext(msg.channel_id, 10, msg.id, channelAgents);

    // Recheck membership immediately before handing work to a runtime. A stale
    // Realtime membership map is never sufficient authorization to execute.
    if (!(await this.isCurrentAgentMembership(delivery))) {
      await this.finishDelivery(delivery, "skipped", "Agent was removed before delivery");
      return;
    }
    if (!(await ensureLease())) throw new Error("Delivery lease was lost before runtime hand-off");

    const receiptKind = isDm ? "" : ambientReason ? ` (${ambientReason})` : " (@mention)";
    console.log(
      `  [${agent.display_name}] Received${receiptKind}: "${msg.content.substring(0, 60)}${msg.content.length > 60 ? "..." : ""}"`,
    );
    const threadTarget = msg.thread_parent_id
      ? `${channelTarget}:${msg.thread_parent_id.substring(0, 8)}`
      : channelTarget;
    const msgHeader = `[target=${threadTarget} msg=${msg.id.substring(0, 8)} time=${msg.created_at} sender=@${senderName} type=${msg.sender_type}${ambientReason ? " delivery=unmentioned" : ""}]`;
    const body = `${msgHeader} ${msg.content}`;
    const prompt = contextPrefix ? `${contextPrefix}\n\n${body}` : body;

    if (this.config.localMode) {
      // "Shown ⇒ seen": the send-time freshness gate compares against what
      // this delivery is about to show the agent.
      const seen = await this.supabase.rpc("record_channel_seen", {
        channel_uuid: msg.channel_id,
        agent_uuid: delivery.agent_id,
        seq: msg.seq,
      });
      if (seen.error) {
        console.error(`  Could not record the seen baseline: ${seen.error.message}`);
      }
    }

    await this.agentManager.sendToAgent(delivery.agent_id, prompt, msg.channel_id, {
      // A person naming you is asking you something, so an empty turn means the
      // runtime dropped the reply and the trailing text is worth publishing. A
      // teammate naming you is often just a citation — "@test answered that" —
      // and publishing the trailing text there posts the agent's decision not
      // to answer as a channel message. Their explicit `message send` still
      // works; only the fallback is off.
      ambient: ambientReason !== null || msg.sender_type === "agent",
      body,
    });
    // Record this before the completion update. If that update fails, this
    // process can reclaim the row without sending the same prompt twice.
    this.rememberLocalDelivery(key);
    await this.finishDelivery(delivery, "completed");
  }

  private async isCurrentAgentMembership(delivery: DbMessageDelivery) {
    const { data, error } = await this.supabase
      .from("channel_members")
      .select("channel_id")
      .eq("channel_id", delivery.channel_id)
      .eq("member_id", delivery.agent_id)
      .eq("member_type", "agent")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return Boolean(data);
  }

  private async isCurrentChannelAgent(agentId: string, channelId: string) {
    const { data, error } = await this.supabase
      .from("channel_members")
      .select("member_id")
      .eq("channel_id", channelId)
      .eq("member_id", agentId)
      .eq("member_type", "agent")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return Boolean(data);
  }

  private async renewDeliveryLease(delivery: DbMessageDelivery) {
    const now = new Date();
    const { data, error } = await this.supabase
      .from("message_deliveries")
      .update({
        lease_expires_at: new Date(now.getTime() + DELIVERY_LEASE_MS).toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("message_id", delivery.message_id)
      .eq("agent_id", delivery.agent_id)
      .eq("server_id", this.config.serverId)
      .eq("status", "processing")
      .eq("claim_token", delivery.claim_token)
      .select("message_id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return Boolean(data);
  }

  private async finishDelivery(
    delivery: DbMessageDelivery,
    status: "completed" | "skipped",
    reason: string | null = null,
  ) {
    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from("message_deliveries")
      .update({
        status,
        claim_token: null,
        claimed_by: null,
        lease_expires_at: null,
        last_error: reason,
        completed_at: now,
        updated_at: now,
      })
      .eq("message_id", delivery.message_id)
      .eq("agent_id", delivery.agent_id)
      .eq("server_id", this.config.serverId)
      .eq("status", "processing")
      .eq("claim_token", delivery.claim_token)
      .select("message_id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Delivery claim was lost before completion");
  }

  private async failDelivery(delivery: DbMessageDelivery, error: unknown) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
    const terminal = delivery.attempts >= DELIVERY_MAX_ATTEMPTS;
    const now = new Date();
    const retryDelay = Math.min(60_000, 1_000 * (2 ** Math.max(0, delivery.attempts - 1)));
    const { data, error: updateError } = await this.supabase
      .from("message_deliveries")
      .update({
        status: terminal ? "failed" : "pending",
        claim_token: null,
        claimed_by: null,
        lease_expires_at: null,
        next_attempt_at: new Date(now.getTime() + retryDelay).toISOString(),
        last_error: message || "Unknown delivery error",
        updated_at: now.toISOString(),
      })
      .eq("message_id", delivery.message_id)
      .eq("agent_id", delivery.agent_id)
      .eq("server_id", this.config.serverId)
      .eq("status", "processing")
      .eq("claim_token", delivery.claim_token)
      .select("message_id")
      .maybeSingle();
    if (updateError) throw new Error(updateError.message);
    if (!data) throw new Error("Delivery claim was lost while recording failure");
  }

  private deliveryKey(delivery: Pick<DbMessageDelivery, "message_id" | "agent_id">) {
    return `${delivery.message_id}:${delivery.agent_id}`;
  }

  private rememberLocalDelivery(key: string) {
    this.locallyDelivered.delete(key);
    this.locallyDelivered.add(key);
    while (this.locallyDelivered.size > MAX_LOCAL_DELIVERY_GUARDS) {
      const oldest = this.locallyDelivered.values().next().value as string | undefined;
      if (!oldest) break;
      this.locallyDelivered.delete(oldest);
    }
  }

  private subscribeToAgentChanges() {
    this.agentChangesChannel = this.supabase
      .channel("bridge-agent-changes")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "agents",
          filter: `owner_id=eq.${this.config.userId}`,
        },
        (payload) => {
          void this.handleAgentInserted(payload.new as DbAgent).catch((error) => {
            console.error(
              "  Could not initialize new agent:",
              error instanceof Error ? error.message : error,
            );
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "agents" },
        (payload) => {
          const updated = payload.new as DbAgent;
          const current = this.agentRecords.get(updated.id);
          if (!current) return;
          if (
            (updated.owner_id && updated.owner_id !== this.config.userId) ||
            (updated.server_id && updated.server_id !== this.config.serverId)
          ) {
            this.removeManagedAgent(updated.id);
            return;
          }
          this.agentRecords.set(updated.id, { ...current, ...updated });
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "agents" },
        (payload) => {
          const deleted = payload.old as Partial<DbAgent>;
          if (deleted.id && this.agentRecords.has(deleted.id)) {
            this.removeManagedAgent(deleted.id);
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "channel_members",
        },
        (payload) => {
          void this.handleMembershipInserted(payload.new as DbChannelMember).catch((error) => {
            console.error(
              "  Could not add agent channel membership:",
              error instanceof Error ? error.message : error,
            );
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "channel_members" },
        (payload) => {
          const member = payload.old as Partial<DbChannelMember>;
          if (member.channel_id && member.member_id) {
            this.removeChannelMembership(member.channel_id, member.member_id);
          }
        },
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR") {
          console.error("  Agent and channel membership subscription error.");
        }
      });
  }

  private async handleAgentInserted(agent: DbAgent) {
    if (
      this.agentRecords.has(agent.id) ||
      (agent.owner_id && agent.owner_id !== this.config.userId) ||
      (agent.server_id && agent.server_id !== this.config.serverId)
    ) {
      return;
    }

    if (!(await this.ensureAgentCredential(agent.id))) {
      console.error(
        `  [Agent runtime] Ignoring ${agent.display_name}: no live scoped agent credential was issued.`,
      );
      return;
    }

    console.log(`  [Agent runtime] New agent detected: ${agent.display_name}`);
    this.agentRecords.set(agent.id, agent);
    try {
      await this.agentManager.initAgent(agent.id, agent);
    } catch (error) {
      this.agentRecords.delete(agent.id);
      throw error;
    }

    await this.supabase
      .from("agents")
      .update({ status: "online" })
      .eq("id", agent.id);
    void this.requestDeliveryPump();
  }

  private async ensureAgentCredential(agentId: string) {
    if (this.config.agentAuthTokens?.[agentId]) return true;
    if (!this.config.refreshAgentAuthTokens) return false;

    const refreshed = await this.config.refreshAgentAuthTokens();
    this.config.agentAuthTokens = refreshed;
    this.agentManager.updateAgentAuthTokens(refreshed);
    return Boolean(refreshed[agentId]);
  }

  private removeManagedAgent(agentId: string) {
    const agent = this.agentRecords.get(agentId);
    if (!agent) return;

    this.agentRecords.delete(agentId);
    for (const channelId of Array.from(this.channelAgents.keys())) {
      this.removeChannelMembership(channelId, agentId);
    }
    this.agentManager.removeAgent(agentId);
    console.log(`  [Agent runtime] Agent removed: ${agent.display_name}`);
  }

  private async handleMembershipInserted(member: DbChannelMember) {
    if (
      member.member_type !== "agent" ||
      !this.agentRecords.has(member.member_id)
    ) {
      return;
    }

    console.log(
      `  [Agent runtime] Agent ${this.agentRecords.get(member.member_id)?.display_name} joined channel ${member.channel_id}`,
    );
    const agents = this.channelAgents.get(member.channel_id) || new Set<string>();
    agents.add(member.member_id);
    this.channelAgents.set(member.channel_id, agents);

    if (!this.channelTypes.has(member.channel_id)) {
      const { data: channel } = await this.supabase
        .from("channels")
        .select("name, type")
        .eq("id", member.channel_id)
        .single();
      if (channel) {
        this.channelTypes.set(member.channel_id, channel.type);
        this.channelNames.set(member.channel_id, channel.name);
      }
    }
    void this.requestDeliveryPump();
  }

  private removeChannelMembership(channelId: string, memberId: string) {
    const agents = this.channelAgents.get(channelId);
    if (!agents?.delete(memberId)) return;

    if (agents.size === 0) {
      this.channelAgents.delete(channelId);
      this.channelTypes.delete(channelId);
      this.channelNames.delete(channelId);
    }
    console.log(`  [Agent runtime] Agent ${memberId} left channel ${channelId}`);
  }

  /** Periodically update machine_keys.last_used_at as a heartbeat for polling-based status. */
  private startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    const sendHeartbeat = async () => {
      try {
        const { error } = await this.supabase.rpc("touch_current_bridge_machine_key", {});
        if (error) throw new Error(error.message);
        this.lastHeartbeatErrorLogAt = 0;
      } catch (error) {
        const now = Date.now();
        if (now - this.lastHeartbeatErrorLogAt >= 60_000) {
          this.lastHeartbeatErrorLogAt = now;
          console.error(
            "  Agent runtime heartbeat failed:",
            error instanceof Error ? error.message : error,
          );
        }
      }
    };

    // Send immediately, then every 30 seconds
    sendHeartbeat();
    this.heartbeatInterval = setInterval(sendHeartbeat, 30_000);
  }

  /**
   * Subscribe to workspace file RPC requests from the web UI.
   * The web UI sends broadcast events; the bridge reads local files and responds.
   */
  private subscribeToWorkspaceRpc() {
    const requestTopic = `bridge-rpc-request:${this.config.serverId}:${this.config.userId}`;
    const responseTopic = `bridge-rpc-response:${this.config.serverId}:${this.config.userId}`;
    const requestChannel = this.supabase.channel(requestTopic, {
      config: { private: true, broadcast: { ack: true, self: false } },
    });
    const responseChannel = this.supabase.channel(responseTopic, {
      config: { private: true, broadcast: { ack: true, self: false } },
    });
    this.workspaceRpcRequestChannel = requestChannel;
    this.workspaceRpcResponseChannel = responseChannel;

    let requestReady = false;
    let responseReady = false;
    const reportReady = () => {
      if (requestReady && responseReady) {
        console.log("  Agent runtime RPC channels ready.");
      }
    };
    const sendResponse = async (
      requestId: string,
      responsePayload: Record<string, unknown>,
    ) => {
      try {
        const status = await responseChannel.send({
          type: "broadcast",
          event: "rpc:response",
          payload: {
            ...responsePayload,
            requestId,
            serverId: this.config.serverId,
            ownerId: this.config.userId,
          },
        });
        if (status !== "ok") {
          console.error("  Agent runtime RPC response failed:", status);
        }
      } catch (error) {
        console.error(
          "  Agent runtime RPC response failed:",
          error instanceof Error ? error.message : error,
        );
      }
    };

    responseChannel.subscribe((status, error) => {
      responseReady = status === "SUBSCRIBED";
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error("  Agent runtime RPC response subscription failed:", status, error || "");
      }
      reportReady();
    });

    requestChannel
      .on(
        "broadcast",
        { event: "rpc:request" },
        async ({ payload }) => {
          const { requestId, agentId, action, filePath, runtime, serverId, ownerId } = payload;
          if (
            typeof requestId !== "string" ||
            requestId.length === 0 ||
            requestId.length > 128 ||
            serverId !== this.config.serverId ||
            ownerId !== this.config.userId
          ) {
            return;
          }

          try {
            let responsePayload: Record<string, unknown>;

            if (action === "skills:list") {
              // Skills are machine-wide, no agentId needed
              if (runtime !== "codex" && runtime !== "claude-code" && runtime !== "pi") {
                responsePayload = { error: "Unsupported agent runtime" };
              } else {
                responsePayload = await this.listSkills(runtime);
              }
            } else if (agentId && this.agentRecords.has(agentId)) {
              const workDir = this.agentManager.getWorkspaceDir(agentId);
              if (!workDir) {
                responsePayload = { error: "Agent workspace not found" };
              } else if (action === "list") {
                responsePayload = await this.listWorkspaceFiles(workDir);
              } else if (action === "read" && filePath) {
                responsePayload = await this.readWorkspaceFile(
                  workDir,
                  filePath
                );
              } else {
                responsePayload = { error: "Unknown action" };
              }
            } else {
              responsePayload = { error: "Unknown action or agent" };
            }

            await sendResponse(requestId, responsePayload);
          } catch (err) {
            await sendResponse(requestId, {
              error: err instanceof Error ? err.message : "Unknown error",
            });
          }
        }
      )
      .subscribe((status, error) => {
        requestReady = status === "SUBSCRIBED";
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("  Agent runtime RPC request subscription failed:", status, error || "");
        }
        reportReady();
      });
  }

  private async listWorkspaceFiles(workDir: string) {
    type WorkspaceFileEntry = {
      name: string;
      type: "file" | "directory";
      size: number;
      modified: string;
    };

    const rootPath = await realpath(workDir);
    const rootStat = await lstat(rootPath);
    if (!rootStat.isDirectory()) throw new Error("Agent workspace not found");

    const listDirectory = async (directoryPath: string, prefix = "") => {
      const files: WorkspaceFileEntry[] = [];
      const entries = await readdir(directoryPath);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const entryPath = join(directoryPath, entry);
        try {
          const entryStat = await lstat(entryPath);
          if (entryStat.isSymbolicLink() || (!entryStat.isFile() && !entryStat.isDirectory())) {
            continue;
          }
          const resolvedEntryPath = await realpath(entryPath);
          if (!isWithinRoot(rootPath, resolvedEntryPath)) continue;
          files.push({
            name: `${prefix}${entry}`,
            type: entryStat.isDirectory() ? "directory" : "file",
            size: entryStat.size,
            modified: entryStat.mtime.toISOString(),
          });
        } catch {
          // An entry can disappear between readdir and lstat.
        }
      }
      return files;
    };

    const files = await listDirectory(rootPath);

    // Also list files inside notes/
    const notesDir = join(rootPath, "notes");
    let notesFiles: WorkspaceFileEntry[] = [];
    try {
      const notesStat = await lstat(notesDir);
      if (!notesStat.isSymbolicLink() && notesStat.isDirectory()) {
        const resolvedNotesDir = await realpath(notesDir);
        if (isWithinRoot(rootPath, resolvedNotesDir)) {
          notesFiles = await listDirectory(resolvedNotesDir, "notes/");
        }
      }
    } catch {
      // notes/ may not exist yet
    }

    return { workspace_path: workDir, files, notes_files: notesFiles };
  }

  private async readWorkspaceFile(workDir: string, filePath: string) {
    if (!filePath || isAbsolute(filePath) || hasHiddenPathSegment(filePath)) {
      throw new Error("Invalid file path");
    }

    const rootPath = await realpath(workDir);
    const rootStat = await lstat(rootPath);
    if (!rootStat.isDirectory()) throw new Error("Agent workspace not found");

    const requestedPath = resolve(rootPath, filePath);
    if (!isWithinRoot(rootPath, requestedPath)) throw new Error("Invalid file path");

    const relativePath = relative(rootPath, requestedPath);
    let currentPath = rootPath;
    for (const segment of relativePath.split(sep).filter(Boolean)) {
      currentPath = join(currentPath, segment);
      const segmentStat = await lstat(currentPath);
      if (segmentStat.isSymbolicLink()) throw new Error("Symbolic links are not allowed");
    }

    const resolvedPath = await realpath(requestedPath);
    if (!isWithinRoot(rootPath, resolvedPath)) throw new Error("Invalid file path");

    const fileStat = await lstat(resolvedPath);
    if (!fileStat.isFile()) throw new Error("Only regular files can be read");
    if (fileStat.size > MAX_WORKSPACE_FILE_BYTES) throw new Error("File is too large");

    const content = await readFile(resolvedPath);
    if (content.length > MAX_WORKSPACE_FILE_BYTES) throw new Error("File is too large");
    return { file: filePath, content: decodeWorkspaceText(content) };
  }

  private async listSkills(runtime: "claude-code" | "codex" | "pi") {
    const runtimeDirectory = runtime === "codex"
      ? [".codex", "skills"]
      : runtime === "pi"
        ? [".pi", "agent", "skills"]
        : [".claude", "skills"];
    const skillsDir = join(
      homedir(),
      ...runtimeDirectory,
    );
    const skills: Array<{ name: string; description: string }> = [];

    try {
      const entries = await readdir(skillsDir);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const entryPath = join(skillsDir, entry);
        const entryStat = await lstat(entryPath);
        const resolvedPath = entryStat.isSymbolicLink()
          ? resolve(skillsDir, entry)
          : entryPath;

        for (const filename of ["SKILL.md", "skill.md"]) {
          try {
            const content = await readFile(
              join(resolvedPath, filename),
              "utf-8"
            );
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            let description = "";
            if (fmMatch) {
              const descMatch = fmMatch[1].match(
                /^description:\s*(.+)$/m
              );
              if (descMatch) {
                description = descMatch[1]
                  .trim()
                  .replace(/^['"]|['"]$/g, "");
              }
            }
            skills.push({ name: entry, description: description || entry });
            break;
          } catch {
            // File doesn't exist, try next
          }
        }
      }
    } catch {
      // Skills directory doesn't exist
    }

    return { skills };
  }

  stop() {
    if (!this.stopPromise) {
      this.stopping = true;
      this.stopPromise = this.stopInternal();
    }
    return this.stopPromise;
  }

  private async stopInternal() {
    if (this.owedWorkInterval) {
      clearInterval(this.owedWorkInterval);
      this.owedWorkInterval = null;
    }
    if (this.deliveryPollInterval) {
      clearInterval(this.deliveryPollInterval);
      this.deliveryPollInterval = null;
    }

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Stop child processes before any network operation can delay shutdown.
    this.agentManager.stopAll();

    // Mark agents as offline
    const agentIds = Array.from(this.agentRecords.keys());
    // The bundled local service persists this synchronously in its own signal
    // handler before it stops accepting requests.
    if (agentIds.length > 0 && process.env.TEAMMATE_EMBEDDED_SIDECAR !== "1") {
      try {
        const { error } = await this.supabase
          .from("agents")
          .update({ status: "offline" })
          .in("id", agentIds);
        if (error) {
          console.error(
            "  Could not mark agents offline during shutdown:",
            error.message,
          );
        }
      } catch (error) {
        console.error(
          "  Could not mark agents offline during shutdown:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    await this.removeBridgeChannels(this.supabase);
    await this.supabase.removeAllChannels();

    console.log("  Agent runtime stopped.");
  }
}
