import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  defaultModelForRuntime,
  isAgentRuntime,
  normalizeAgentRuntime,
  resolveAgentRuntimeSelection,
} from "@/lib/agent-runtime";
import { isValidAgentAvatarUrl } from "@/lib/agent-avatar";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// GET /api/agents/[id] — get a single agent
export async function GET(
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

  const { data: agent, error } = await supabase
    .from("agents")
    .select("*")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!agent) {
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

  // Verify ownership
  const { data: existing, error: existingError } = await supabase
    .from("agents")
    .select("*")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();

  if (existingError) {
    return NextResponse.json({ error: existingError.message }, { status: 500 });
  }

  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
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
  const updates: Record<string, unknown> = {};

  if (payload.display_name !== undefined) {
    if (typeof payload.display_name !== "string") {
      return NextResponse.json(
        { error: "display_name must be a string" },
        { status: 400 },
      );
    }
    const displayName = payload.display_name.trim();
    if (!displayName || displayName.length > 100) {
      return NextResponse.json(
        { error: "display_name must be between 1 and 100 characters" },
        { status: 400 }
      );
    }
    updates.display_name = displayName;
  }
  if (payload.description !== undefined) {
    if (
      payload.description !== null &&
      (typeof payload.description !== "string" || payload.description.length > 2000)
    ) {
      return NextResponse.json({ error: "Invalid description" }, { status: 400 });
    }
    updates.description = typeof payload.description === "string"
      ? payload.description.trim() || null
      : null;
  }
  if (payload.system_prompt !== undefined) {
    if (
      payload.system_prompt !== null &&
      (typeof payload.system_prompt !== "string" || payload.system_prompt.length > 50000)
    ) {
      return NextResponse.json({ error: "Invalid system_prompt" }, { status: 400 });
    }
    updates.system_prompt = typeof payload.system_prompt === "string"
      ? payload.system_prompt.trim() || null
      : null;
  }
  if (payload.avatar_data !== undefined) {
    return NextResponse.json(
      { error: "Custom avatar uploads are currently available in the local desktop app" },
      { status: 400 },
    );
  }
  if (payload.avatar_url !== undefined) {
    if (!isValidAgentAvatarUrl(payload.avatar_url)) {
      return NextResponse.json({ error: "Unsupported avatar URL" }, { status: 400 });
    }
    updates.avatar_url = payload.avatar_url;
  }
  const currentRuntime = normalizeAgentRuntime(existing.runtime);
  const nextRuntime = payload.runtime === undefined
    ? currentRuntime
    : normalizeAgentRuntime(payload.runtime);
  if (payload.runtime !== undefined && !isAgentRuntime(payload.runtime)) {
    return NextResponse.json({ error: "Unsupported agent runtime" }, { status: 400 });
  }
  if (nextRuntime === "pi") {
    return NextResponse.json(
      { error: "Pi model connections are currently available in the local desktop app" },
      { status: 400 },
    );
  }
  if (payload.runtime !== undefined) {
    updates.runtime = nextRuntime;
    if (nextRuntime !== currentRuntime) {
      updates.session_id = null;
      updates.runtime_session_id = null;
      updates.runtime_session_runtime = null;
    }
  }
  if (payload.model !== undefined) {
    const resolvedSelection = resolveAgentRuntimeSelection({
      runtime: nextRuntime,
      model: payload.model,
    });
    if (resolvedSelection.issue) {
      return NextResponse.json(
        { error: "Unsupported runtime model" },
        { status: 400 }
      );
    }
    updates.model = resolvedSelection.selection.model;
  } else if (nextRuntime !== currentRuntime) {
    updates.model = defaultModelForRuntime(nextRuntime);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ agent: existing });
  }

  const { data: agent, error } = await supabase
    .from("agents")
    .update(updates)
    .eq("id", id)
    .eq("owner_id", user.id)
    .select()
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({ agent });
}

// DELETE /api/agents/[id] — atomically delete an owned agent and memberships
export async function DELETE(
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

  const { data: deleted, error } = await supabase.rpc("delete_owned_agent", {
    agent_uuid: id,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (deleted !== true) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
