import { createClient, SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { createLocalClient } from "@zano/local-client";
import { readdir, readFile, stat, lstat } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";
import { AgentManager } from "./agent-manager.js";

interface BridgeConfig {
  supabaseUrl: string;
  supabaseKey: string;    // anon key
  authToken: string;       // JWT for authenticated Supabase operations
  userId: string;
  serverId: string;
  agentsDir: string;
  hostname?: string;
  platform?: string;
  arch?: string;
  localMode?: boolean;
  localServerUrl?: string;
}

interface DbMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: "human" | "agent" | "system";
  content: string;
  thread_parent_id: string | null;
  created_at: string;
}

interface DbAgent {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  system_prompt: string | null;
  model: string;
  status: string;
}

interface DbChannelMember {
  channel_id: string;
  member_id: string;
  member_type: string;
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
  // Realtime channel for workspace file RPC (web UI ↔ bridge)
  private workspaceRpcChannel: RealtimeChannel | null = null;
  // Presence channel for online status (auto-offline on disconnect)
  private presenceChannel: RealtimeChannel | null = null;
  // Heartbeat timer for machine_keys.last_used_at (polling fallback for online status)
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.supabase = config.localMode
      ? (createLocalClient(config.localServerUrl) as unknown as SupabaseClient)
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
      config.localServerUrl
    );
  }

  /** Update the auth token (called on periodic refresh) */
  updateAuthToken(token: string) {
    this.config.authToken = token;
    if (this.config.localMode) return;
    // Remove old channels before recreating client
    if (this.workspaceRpcChannel) {
      this.supabase.removeChannel(this.workspaceRpcChannel);
      this.workspaceRpcChannel = null;
    }
    if (this.presenceChannel) {
      this.supabase.removeChannel(this.presenceChannel);
      this.presenceChannel = null;
    }
    // Recreate the Supabase client with the new token
    this.supabase = createClient(this.config.supabaseUrl, this.config.supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    this.supabase.realtime.setAuth(token);
    // Update agent manager's client too
    this.agentManager.updateSupabaseClient(this.supabase, token);
    // Re-subscribe workspace RPC and presence on new client
    this.subscribeToWorkspaceRpc();
    this.trackPresence();
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

    // 5. Subscribe to new messages in channels where agents are members
    this.subscribeToMessages();

    // 6. Subscribe to new agents and channel memberships (for agents created via UI)
    this.subscribeToNewAgents();

    // 7. Subscribe to workspace file RPC (web UI requests files via Realtime)
    this.subscribeToWorkspaceRpc();

    // 8. Track presence (auto-offline on disconnect — no SIGINT needed)
    this.trackPresence();

    // 9. Start heartbeat (updates machine_keys.last_used_at every 30s for polling-based status)
    this.startHeartbeat();

    console.log(
      `  Bridge ready. Listening for messages across ${this.channelAgents.size} channel(s).`
    );
    console.log(
      `  Managing ${this.agentRecords.size} agent(s): ${Array.from(this.agentRecords.values()).map((a) => a.display_name).join(", ")}`
    );
  }

  private async loadAgents() {
    const { data: agents, error } = await this.supabase
      .from("agents")
      .select("*")
      .eq("owner_id", this.config.userId);

    if (error) {
      console.error("  Failed to load agents:", error.message);
      return;
    }

    for (const agent of agents || []) {
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

  private subscribeToMessages() {
    const subscription = this.supabase
      .channel("bridge-messages")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
        },
        (payload) => {
          const msg = payload.new as DbMessage;
          this.handleNewMessage(msg);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log("  Subscribed to Supabase Realtime.");
        } else if (status === "CHANNEL_ERROR") {
          console.error("  Supabase Realtime subscription error.");
        }
      });
  }

  /**
   * Parse @mentions from message content.
   * Matches @DisplayName (case-insensitive) against agents in the channel.
   */
  private parseMentionedAgents(
    content: string,
    channelAgentIds: Set<string>
  ): Set<string> {
    const mentioned = new Set<string>();
    for (const agentId of channelAgentIds) {
      const agent = this.agentRecords.get(agentId);
      if (!agent) continue;
      // Match @DisplayName followed by whitespace, punctuation, or end of string
      // (don't use \b — it doesn't work with CJK characters)
      const escaped = agent.display_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`@${escaped}(?=[\\s,.:!?，。！？、；]|$)`, "i");
      if (pattern.test(content)) {
        mentioned.add(agentId);
      }
    }
    return mentioned;
  }

  /**
   * Fetch recent channel history for context.
   */
  private async getChannelContext(
    channelId: string,
    limit: number = 10
  ): Promise<string> {
    const { data: messages } = await this.supabase
      .from("messages")
      .select("sender_id, sender_type, content, created_at")
      .eq("channel_id", channelId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (!messages || messages.length === 0) return "";

    const lines = messages.reverse().map((m) => {
      let senderName = "Unknown";
      if (m.sender_type === "human") {
        senderName = "User";
      } else if (m.sender_type === "system") {
        senderName = "System";
      } else {
        const agent = this.agentRecords.get(m.sender_id);
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
    senderType: string
  ): Promise<string> {
    if (senderType === "agent") {
      const agent = this.agentRecords.get(senderId);
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

  private async handleNewMessage(msg: DbMessage) {
    // Only respond to human messages
    if (msg.sender_type !== "human") return;

    // Check if any of our agents are in this channel
    const agentIdsInChannel = this.channelAgents.get(msg.channel_id);
    if (!agentIdsInChannel || agentIdsInChannel.size === 0) return;

    const channelType = this.channelTypes.get(msg.channel_id);
    const isDm = channelType === "dm";

    // Determine which agents should respond
    let respondingAgentIds: Set<string>;

    if (isDm) {
      // DM: always respond with the single agent
      respondingAgentIds = agentIdsInChannel;
    } else {
      // Channel: only respond if @mentioned
      const mentioned = this.parseMentionedAgents(
        msg.content,
        agentIdsInChannel
      );
      if (mentioned.size === 0) {
        // No agents mentioned — don't respond
        console.log(
          `  [Bridge] No @mention in channel message, skipping.`
        );
        return;
      }
      respondingAgentIds = mentioned;
    }

    // Resolve sender name for message context
    const senderName = await this.resolveSenderName(
      msg.sender_id,
      msg.sender_type
    );

    // Build channel target for MCP context
    const channelTarget = this.buildChannelTarget(msg.channel_id, senderName);

    // For channels (not DM), get conversation context
    let contextPrefix = "";
    if (!isDm) {
      contextPrefix = await this.getChannelContext(msg.channel_id);
    }

    for (const agentId of respondingAgentIds) {
      const agent = this.agentRecords.get(agentId);
      if (!agent) continue;

      console.log(
        `  [${agent.display_name}] Received${isDm ? "" : " (@mention)"}: "${msg.content.substring(0, 60)}${msg.content.length > 60 ? "..." : ""}"`
      );

      try {
        // Build prompt with message metadata
        const msgHeader = `[target=${channelTarget} sender=@${senderName} type=${msg.sender_type}]`;
        const prompt = contextPrefix
          ? `${contextPrefix}\n\n${msgHeader} ${msg.content}`
          : `${msgHeader} ${msg.content}`;

        // Fire-and-forget: agent handles all responses via `zano` CLI
        await this.agentManager.sendToAgent(agentId, prompt);
      } catch (err) {
        console.error(
          `  [${agent.display_name}] Error:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  private subscribeToNewAgents() {
    // Watch for new agents belonging to this user
    this.supabase
      .channel("bridge-new-agents")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "agents",
          filter: `owner_id=eq.${this.config.userId}`,
        },
        async (payload) => {
          const agent = payload.new as DbAgent;
          if (this.agentRecords.has(agent.id)) return;

          console.log(
            `  [Bridge] New agent detected: ${agent.display_name}`
          );
          this.agentRecords.set(agent.id, agent);
          await this.agentManager.initAgent(agent.id, agent);

          // Mark as active (best-effort DB backup)
          await this.supabase
            .from("agents")
            .update({ status: "online" })
            .eq("id", agent.id);

          // Update presence with new agent list
          this.updatePresence();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "channel_members",
        },
        async (payload) => {
          const member = payload.new as DbChannelMember;
          // Only track agent memberships for our agents
          if (
            member.member_type !== "agent" ||
            !this.agentRecords.has(member.member_id)
          )
            return;

          console.log(
            `  [Bridge] Agent ${this.agentRecords.get(member.member_id)?.display_name} joined channel ${member.channel_id}`
          );
          if (!this.channelAgents.has(member.channel_id)) {
            this.channelAgents.set(member.channel_id, new Set());
          }
          this.channelAgents.get(member.channel_id)!.add(member.member_id);

          // Load channel type and name if not known
          if (!this.channelTypes.has(member.channel_id)) {
            const { data: ch } = await this.supabase
              .from("channels")
              .select("name, type")
              .eq("id", member.channel_id)
              .single();
            if (ch) {
              this.channelTypes.set(member.channel_id, ch.type);
              this.channelNames.set(member.channel_id, ch.name);
            }
          }
        }
      )
      .subscribe();
  }

  /**
   * Track this bridge's presence. Supabase automatically removes presence
   * when the WebSocket disconnects (crash, network loss, terminal close).
   */
  private trackPresence() {
    const channelName = `bridge-presence:${this.config.serverId}`;
    this.presenceChannel = this.supabase
      .channel(channelName)
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await this.updatePresence();
          console.log("  Bridge presence tracked.");
        }
      });
  }

  /** Periodically update machine_keys.last_used_at as a heartbeat for polling-based status. */
  private startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    const sendHeartbeat = async () => {
      try {
        await this.supabase
          .from("machine_keys")
          .update({ last_used_at: new Date().toISOString() })
          .eq("user_id", this.config.userId)
          .eq("server_id", this.config.serverId);
      } catch {
        // Ignore heartbeat errors
      }
    };

    // Send immediately, then every 30 seconds
    sendHeartbeat();
    this.heartbeatInterval = setInterval(sendHeartbeat, 30_000);
  }

  /** Update the presence payload (e.g. when new agents are added). */
  private async updatePresence() {
    if (!this.presenceChannel) return;
    await this.presenceChannel.track({
      hostname: this.config.hostname || "unknown",
      platform: this.config.platform || "",
      arch: this.config.arch || "",
      agentIds: Array.from(this.agentRecords.keys()),
    });
  }

  /**
   * Subscribe to workspace file RPC requests from the web UI.
   * The web UI sends broadcast events; the bridge reads local files and responds.
   */
  private subscribeToWorkspaceRpc() {
    this.workspaceRpcChannel = this.supabase
      .channel("bridge-rpc")
      .on(
        "broadcast",
        { event: "rpc:request" },
        async ({ payload }) => {
          const { requestId, agentId, action, filePath } = payload;
          if (!requestId) return;

          try {
            let responsePayload: Record<string, unknown>;

            if (action === "skills:list") {
              // Skills are machine-wide, no agentId needed
              responsePayload = await this.listSkills();
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

            this.workspaceRpcChannel!.send({
              type: "broadcast",
              event: "rpc:response",
              payload: { requestId, ...responsePayload },
            });
          } catch (err) {
            this.workspaceRpcChannel!.send({
              type: "broadcast",
              event: "rpc:response",
              payload: {
                requestId,
                error:
                  err instanceof Error ? err.message : "Unknown error",
              },
            });
          }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log("  Bridge RPC channel ready.");
        }
      });
  }

  private async listWorkspaceFiles(workDir: string) {
    const files: Array<{
      name: string;
      type: "file" | "directory";
      size: number;
      modified: string;
    }> = [];

    const entries = await readdir(workDir);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const entryPath = join(workDir, entry);
      const entryStat = await stat(entryPath);
      files.push({
        name: entry,
        type: entryStat.isDirectory() ? "directory" : "file",
        size: entryStat.size,
        modified: entryStat.mtime.toISOString(),
      });
    }

    // Also list files inside notes/
    const notesDir = join(workDir, "notes");
    const notesFiles: typeof files = [];
    try {
      const notesEntries = await readdir(notesDir);
      for (const entry of notesEntries) {
        if (entry.startsWith(".")) continue;
        const entryPath = join(notesDir, entry);
        const entryStat = await stat(entryPath);
        notesFiles.push({
          name: `notes/${entry}`,
          type: entryStat.isDirectory() ? "directory" : "file",
          size: entryStat.size,
          modified: entryStat.mtime.toISOString(),
        });
      }
    } catch {
      // notes/ may not exist yet
    }

    return { workspace_path: workDir, files, notes_files: notesFiles };
  }

  private async readWorkspaceFile(workDir: string, filePath: string) {
    // Security: prevent path traversal
    const resolvedPath = join(workDir, filePath);
    if (!resolvedPath.startsWith(workDir)) {
      throw new Error("Invalid file path");
    }
    const content = await readFile(resolvedPath, "utf-8");
    return { file: filePath, content };
  }

  private async listSkills() {
    const skillsDir = join(homedir(), ".claude", "skills");
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

  async stop() {
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Mark agents as offline
    const agentIds = Array.from(this.agentRecords.keys());
    if (agentIds.length > 0) {
      await this.supabase
        .from("agents")
        .update({ status: "offline" })
        .in("id", agentIds);
    }

    // Stop all agent sessions
    this.agentManager.stopAll();

    // Disconnect from Supabase (removes all channels including workspace RPC + presence)
    this.workspaceRpcChannel = null;
    this.presenceChannel = null;
    await this.supabase.removeAllChannels();

    console.log("  Bridge stopped.");
  }
}
