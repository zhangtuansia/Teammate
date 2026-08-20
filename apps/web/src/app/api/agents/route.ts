import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/agents — list user's agents
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("agents")
    .select("*")
    .eq("owner_id", user.id)
    .order("created_at");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ agents: data ?? [] });
}

// POST /api/agents — create a new agent + DM channel
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { display_name, description, system_prompt, model, server_id } = body;

  if (!display_name?.trim()) {
    return NextResponse.json(
      { error: "display_name is required" },
      { status: 400 }
    );
  }

  // Generate a unique agent name from display name + user id prefix + random suffix
  const baseName = display_name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const randomSuffix = Math.random().toString(36).substring(2, 6);
  const name = `${baseName}-${user.id.substring(0, 8)}-${randomSuffix}`;

  // 1. Create the agent
  // Validate model if provided
  const validModels = ["opus", "sonnet", "haiku"];
  const agentModel = model && validModels.includes(model) ? model : "opus";

  if (!server_id) {
    return NextResponse.json(
      { error: "server_id is required" },
      { status: 400 }
    );
  }

  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .insert({
      name,
      display_name: display_name.trim(),
      description: description?.trim() || null,
      system_prompt: system_prompt?.trim() || null,
      model: agentModel,
      status: "offline",
      owner_id: user.id,
      server_id,
    })
    .select()
    .single();

  if (agentError) {
    return NextResponse.json({ error: agentError.message }, { status: 500 });
  }

  // 2. Create a DM channel for this agent
  const { data: dmChannel, error: channelError } = await supabase
    .from("channels")
    .insert({
      name: display_name.trim(),
      description: `Direct chat with ${display_name.trim()}`,
      type: "dm",
      server_id,
      created_by: user.id,
    })
    .select()
    .single();

  if (channelError) {
    // Rollback: delete the agent if channel creation fails
    await supabase.from("agents").delete().eq("id", agent.id);
    return NextResponse.json({ error: channelError.message }, { status: 500 });
  }

  // 3. Add both user and agent to the DM channel
  await supabase.from("channel_members").insert([
    { channel_id: dmChannel.id, member_id: user.id, member_type: "human" },
    { channel_id: dmChannel.id, member_id: agent.id, member_type: "agent" },
  ]);

  // 4. Add agent as server member
  await supabase.from("server_members").insert({
    server_id,
    member_id: agent.id,
    member_type: "agent",
    role: "member",
  });

  return NextResponse.json({ agent, channel: dmChannel });
}
