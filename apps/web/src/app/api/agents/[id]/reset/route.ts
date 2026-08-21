import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// POST /api/agents/[id]/reset — reset agent conversation (clear messages + session)
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: "Invalid agent id" }, { status: 400 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: messagesDeleted, error } = await supabase.rpc(
    "reset_owned_agent",
    { agent_uuid: id },
  );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (typeof messagesDeleted !== "number" || messagesDeleted < 0) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, messagesDeleted });
}
