import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// POST /api/agents/[id]/reset — reset agent conversation (clear messages + session)
export async function POST(
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
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  // Find the DM channel for this agent
  const { data: memberships } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", id)
    .eq("member_type", "agent");

  let messagesDeleted = 0;

  if (memberships) {
    for (const m of memberships) {
      const { data: ch } = await supabase
        .from("channels")
        .select("id, type")
        .eq("id", m.channel_id)
        .eq("type", "dm")
        .single();

      if (ch) {
        // Delete all messages in the DM channel
        const { count } = await supabase
          .from("messages")
          .delete({ count: "exact" })
          .eq("channel_id", ch.id);

        messagesDeleted += count ?? 0;
      }
    }
  }

  return NextResponse.json({ success: true, messagesDeleted });
}
