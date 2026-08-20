#!/usr/bin/env node
/**
 * Zano MCP Chat Bridge
 *
 * A standalone MCP server that Claude Code agents can call to:
 * - send_message: Send messages to channels or DMs
 * - check_messages: Check for new messages
 * - read_history: Read message history from a channel
 *
 * Spawned by Claude Code via --mcp-config. Communicates with Supabase directly.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Parse CLI args
const args = process.argv.slice(2);
let agentId = "";
let agentName = "";
let supabaseUrl = "";
let supabaseKey = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--agent-id" && args[i + 1]) agentId = args[++i];
  if (args[i] === "--agent-name" && args[i + 1]) agentName = args[++i];
  if (args[i] === "--supabase-url" && args[i + 1]) supabaseUrl = args[++i];
  if (args[i] === "--supabase-key" && args[i + 1]) supabaseKey = args[++i];
}

if (!agentId || !supabaseUrl || !supabaseKey) {
  console.error(
    "Missing required args: --agent-id, --supabase-url, --supabase-key"
  );
  process.exit(1);
}

// Create Supabase client
const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Track last check time for check_messages
let lastCheckTime = new Date().toISOString();

// Cache: channel memberships for this agent
let agentChannelIds: string[] = [];
let channelInfoCache = new Map<
  string,
  { name: string; type: string; description: string | null }
>();

async function loadAgentChannels() {
  const { data: memberships } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", agentId)
    .eq("member_type", "agent");

  agentChannelIds = (memberships || []).map((m: any) => m.channel_id);

  if (agentChannelIds.length > 0) {
    const { data: channels } = await supabase
      .from("channels")
      .select("id, name, type, description")
      .in("id", agentChannelIds);

    channelInfoCache.clear();
    for (const ch of channels || []) {
      channelInfoCache.set(ch.id, {
        name: ch.name,
        type: ch.type,
        description: ch.description,
      });
    }
  }
}

/**
 * Resolve a human-friendly target to a channel_id.
 * Supports: "#channel-name", "dm:@agent-or-user-name", channel UUID
 */
async function resolveTarget(target: string): Promise<string | null> {
  // Already a UUID
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      target
    )
  ) {
    return target;
  }

  // #channel-name
  if (target.startsWith("#")) {
    const channelName = target.slice(1);
    const { data } = await supabase
      .from("channels")
      .select("id")
      .eq("name", channelName)
      .single();
    return data?.id || null;
  }

  // dm:@name — find the DM channel between this agent and the named user/agent
  if (target.startsWith("dm:@")) {
    const peerName = target.slice(4);

    // Try to find the peer as a user first, then as an agent
    let peerId: string | null = null;

    const { data: user } = await supabase
      .from("profiles")
      .select("id")
      .eq("display_name", peerName)
      .single();

    if (user) {
      peerId = user.id;
    } else {
      const { data: agent } = await supabase
        .from("agents")
        .select("id")
        .eq("display_name", peerName)
        .single();
      if (agent) peerId = agent.id;
    }

    if (!peerId) return null;

    // Find a DM channel that has both this agent and the peer
    const { data: myChannels } = await supabase
      .from("channel_members")
      .select("channel_id")
      .eq("member_id", agentId);

    const { data: peerChannels } = await supabase
      .from("channel_members")
      .select("channel_id")
      .eq("member_id", peerId);

    if (!myChannels || !peerChannels) return null;

    const mySet = new Set(myChannels.map((c: any) => c.channel_id));
    const common = peerChannels
      .map((c: any) => c.channel_id)
      .filter((id: string) => mySet.has(id));

    // Find which of the common channels is a DM
    for (const channelId of common) {
      const { data: ch } = await supabase
        .from("channels")
        .select("type")
        .eq("id", channelId)
        .single();
      if (ch?.type === "dm") return channelId;
    }

    return null;
  }

  return null;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Create MCP server
const server = new McpServer({
  name: "zano-chat",
  version: "1.0.0",
});

// === Tool: send_message ===
server.tool(
  "send_message",
  "Send a message to a channel or DM. Use '#channel-name' for channels, 'dm:@person-name' for DMs, or a channel UUID.",
  {
    target: z
      .string()
      .describe(
        "Where to send. '#channel-name' for channels, 'dm:@person-name' for DMs, or a channel UUID."
      ),
    content: z.string().describe("The message content"),
  },
  async ({ target, content }) => {
    try {
      const channelId = await resolveTarget(target);
      if (!channelId) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Could not resolve target: ${target}. Use '#channel-name', 'dm:@person-name', or a channel UUID.`,
            },
          ],
        };
      }

      const { error } = await supabase.from("messages").insert({
        channel_id: channelId,
        sender_id: agentId,
        sender_type: "agent",
        content,
      });

      if (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Message sent to ${target}.`,
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
      };
    }
  }
);

// === Tool: check_messages ===
server.tool(
  "check_messages",
  "Check for new messages since the last check. Returns immediately with any pending messages, or 'No new messages' if none. Use this at natural breakpoints during work.",
  {},
  async () => {
    try {
      // Refresh channel memberships
      if (agentChannelIds.length === 0) {
        await loadAgentChannels();
      }

      if (agentChannelIds.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No channels joined. No messages to check." },
          ],
        };
      }

      const { data: messages, error } = await supabase
        .from("messages")
        .select(
          "id, channel_id, sender_id, sender_type, content, created_at"
        )
        .in("channel_id", agentChannelIds)
        .neq("sender_id", agentId)
        .gt("created_at", lastCheckTime)
        .order("created_at", { ascending: true })
        .limit(20);

      if (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
        };
      }

      // Update last check time
      lastCheckTime = new Date().toISOString();

      if (!messages || messages.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No new messages." }],
        };
      }

      // Format messages
      const formatted = messages
        .map((m: any) => {
          const ch = channelInfoCache.get(m.channel_id);
          const channelLabel = ch
            ? ch.type === "dm"
              ? `dm`
              : `#${ch.name}`
            : m.channel_id.slice(0, 8);
          const time = formatTimestamp(m.created_at);
          return `[${channelLabel} time=${time} type=${m.sender_type}] ${m.content}`;
        })
        .join("\n");

      return {
        content: [{ type: "text" as const, text: formatted }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
      };
    }
  }
);

// === Tool: read_history ===
server.tool(
  "read_history",
  "Read message history from a channel or DM. Use '#channel-name' for channels, 'dm:@person-name' for DMs, or a channel UUID.",
  {
    channel: z
      .string()
      .describe(
        "The channel to read from. '#channel-name', 'dm:@person-name', or UUID."
      ),
    limit: z
      .number()
      .default(20)
      .describe("Max number of messages to return (default 20, max 50)"),
  },
  async ({ channel, limit }) => {
    try {
      const channelId = await resolveTarget(channel);
      if (!channelId) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Could not resolve channel: ${channel}`,
            },
          ],
        };
      }

      const effectiveLimit = Math.min(limit, 50);

      const { data: messages, error } = await supabase
        .from("messages")
        .select(
          "id, sender_id, sender_type, content, created_at"
        )
        .eq("channel_id", channelId)
        .order("created_at", { ascending: false })
        .limit(effectiveLimit);

      if (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
        };
      }

      if (!messages || messages.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `No messages in ${channel}.` },
          ],
        };
      }

      // Collect unique sender_ids to resolve names
      const senderIds = [...new Set(messages.map((m: any) => m.sender_id))];

      // Resolve agent names
      const { data: agents } = await supabase
        .from("agents")
        .select("id, display_name")
        .in("id", senderIds);

      // Resolve user names
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", senderIds);

      const nameMap = new Map<string, string>();
      for (const a of agents || []) nameMap.set(a.id, a.display_name);
      for (const p of profiles || []) nameMap.set(p.id, p.display_name);

      const ch = channelInfoCache.get(channelId);
      const channelLabel = ch
        ? ch.type === "dm"
          ? `dm`
          : `#${ch.name}`
        : channel;

      const formatted = messages
        .reverse()
        .map((m: any) => {
          const sender = nameMap.get(m.sender_id) || m.sender_type;
          const time = formatTimestamp(m.created_at);
          return `[${time} ${m.sender_type}] @${sender}: ${m.content}`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `## Message History for ${channelLabel} (${messages.length} messages)\n\n${formatted}`,
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
      };
    }
  }
);

// Initialize and start
async function main() {
  await loadAgentChannels();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Chat bridge fatal error:", err);
  process.exit(1);
});
