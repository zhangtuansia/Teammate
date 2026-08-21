import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 100_000;

// GET /api/messages?channel_id=xxx&limit=50&before=xxx
// `before` is a seq number (cursor-based pagination)
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const channelId = searchParams.get("channel_id");
  const requestedLimit = Number(searchParams.get("limit") ?? "50");
  const beforeValue = searchParams.get("before");

  if (!channelId || !UUID_PATTERN.test(channelId)) {
    return NextResponse.json({ error: "valid channel_id required" }, { status: 400 });
  }
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200) {
    return NextResponse.json({ error: "limit must be between 1 and 200" }, { status: 400 });
  }
  const before = beforeValue === null ? null : Number(beforeValue);
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) {
    return NextResponse.json({ error: "before must be a positive sequence number" }, { status: 400 });
  }

  let query = supabase
    .from("messages")
    .select("*, profiles:sender_id(display_name)")
    .eq("channel_id", channelId)
    .order("seq", { ascending: false })
    .limit(requestedLimit);

  if (before !== null) {
    query = query.lt("seq", before);
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "JSON object required" }, { status: 400 });
  }
  const payload = body as Record<string, unknown>;
  const channelId = typeof payload.channel_id === "string" ? payload.channel_id : "";
  const senderId = typeof payload.sender_id === "string" ? payload.sender_id : "";
  const senderType = payload.sender_type === undefined ? "agent" : payload.sender_type;
  const content = typeof payload.content === "string" ? payload.content : "";
  const threadParentId = payload.thread_parent_id;

  if (!UUID_PATTERN.test(channelId) || !UUID_PATTERN.test(senderId)) {
    return NextResponse.json(
      { error: "valid channel_id and sender_id required" },
      { status: 400 }
    );
  }
  if (senderType !== "human" && senderType !== "agent" && senderType !== "system") {
    return NextResponse.json({ error: "Invalid sender_type" }, { status: 400 });
  }
  if (!content.trim() || content.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `content must be between 1 and ${MAX_MESSAGE_LENGTH} characters` },
      { status: 400 },
    );
  }
  if (
    threadParentId !== undefined &&
    threadParentId !== null &&
    (typeof threadParentId !== "string" || !UUID_PATTERN.test(threadParentId))
  ) {
    return NextResponse.json({ error: "Invalid thread_parent_id" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("messages")
    .insert({
      channel_id: channelId,
      sender_id: senderId,
      sender_type: senderType,
      content,
      thread_parent_id: threadParentId || null,
    })
    .select()
    .single();

  if (error) {
    const status = error.code === "42501" ? 403 : error.code === "23514" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ message: data }, { status: 201 });
}
