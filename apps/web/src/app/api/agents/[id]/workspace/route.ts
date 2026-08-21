import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Hosted workspaces live on the machine running the agent. The UI uses this
// response to switch to the authenticated private runtime RPC instead of ever
// interpreting an agent-controlled database value as a web-server file path.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
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

  const { data: agent, error } = await supabase
    .from("agents")
    .select("id, workspace_path")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "Failed to load agent workspace" }, { status: 500 });
  }
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  if (!agent.workspace_path) {
    return NextResponse.json(
      { error: "Agent workspace is not initialized" },
      { status: 404 },
    );
  }

  return NextResponse.json(
    {
      error: "remote_workspace",
      message: "Workspace files are stored on the machine running the agent.",
      workspace_path: agent.workspace_path,
    },
    { status: 422 },
  );
}
