import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/agents/[id] — get a single agent
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: agent, error } = await supabase
    .from("agents")
    .select("*")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (error || !agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({ agent });
}

// PUT /api/agents/[id] — update agent info
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify ownership
  const { data: existing } = await supabase
    .from("agents")
    .select("id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  if (body.display_name !== undefined) {
    if (!body.display_name?.trim()) {
      return NextResponse.json(
        { error: "display_name cannot be empty" },
        { status: 400 }
      );
    }
    updates.display_name = body.display_name.trim();
  }
  if (body.description !== undefined) {
    updates.description = body.description?.trim() || null;
  }
  if (body.system_prompt !== undefined) {
    updates.system_prompt = body.system_prompt?.trim() || null;
  }
  if (body.model !== undefined) {
    const validModels = ["opus", "sonnet", "haiku"];
    if (!validModels.includes(body.model)) {
      return NextResponse.json(
        { error: "model must be one of: opus, sonnet, haiku" },
        { status: 400 }
      );
    }
    updates.model = body.model;
  }

  const { data: agent, error } = await supabase
    .from("agents")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ agent });
}

// DELETE /api/agents/[id] — delete agent + associated DM channel
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify ownership
  const { data: existing } = await supabase
    .from("agents")
    .select("id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  // Find and delete the DM channel (messages cascade via FK)
  const { data: dmMembership } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", id)
    .eq("member_type", "agent");

  if (dmMembership) {
    for (const m of dmMembership) {
      const { data: ch } = await supabase
        .from("channels")
        .select("id, type")
        .eq("id", m.channel_id)
        .eq("type", "dm")
        .single();

      if (ch) {
        // Delete messages in this DM channel
        await supabase.from("messages").delete().eq("channel_id", ch.id);
        // Delete channel members
        await supabase.from("channel_members").delete().eq("channel_id", ch.id);
        // Delete channel
        await supabase.from("channels").delete().eq("id", ch.id);
      }
    }
  }

  // Remove agent from any group channels
  await supabase
    .from("channel_members")
    .delete()
    .eq("member_id", id)
    .eq("member_type", "agent");

  // Delete the agent
  const { error } = await supabase.from("agents").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
