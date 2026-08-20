import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/messages?channel_id=xxx&limit=50&before=xxx
// `before` is a seq number (cursor-based pagination)
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const channelId = searchParams.get("channel_id");
  const limit = parseInt(searchParams.get("limit") || "50");
  const before = searchParams.get("before");

  if (!channelId) {
    return NextResponse.json({ error: "channel_id required" }, { status: 400 });
  }

  let query = supabase
    .from("messages")
    .select("*, profiles:sender_id(display_name)")
    .eq("channel_id", channelId)
    .order("seq", { ascending: false })
    .limit(limit);

  if (before) {
    query = query.lt("seq", parseInt(before));
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ messages: data?.reverse() ?? [] });
}

// POST /api/messages — used by Bridge CLI to send messages
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const body = await request.json();

  const { channel_id, sender_id, sender_type, content, thread_parent_id } =
    body;

  if (!channel_id || !sender_id || !content) {
    return NextResponse.json(
      { error: "channel_id, sender_id, and content required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("messages")
    .insert({
      channel_id,
      sender_id,
      sender_type: sender_type || "agent",
      content,
      thread_parent_id: thread_parent_id || null,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ message: data });
}
