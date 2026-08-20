import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/channels — list channels
export async function GET() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("channels")
    .select("*")
    .order("created_at");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ channels: data ?? [] });
}

// POST /api/channels — create channel
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const body = await request.json();
  const { name, type, description } = body;

  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("channels")
    .insert({
      name,
      type: type || "public",
      description: description || null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Auto-join creator
  await supabase.from("channel_members").insert({
    channel_id: data.id,
    member_id: user.id,
    member_type: "human",
  });

  return NextResponse.json({ channel: data });
}
