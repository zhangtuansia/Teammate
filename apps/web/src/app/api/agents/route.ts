import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import {
  isAgentRuntime,
  normalizeAgentRuntime,
  resolveAgentRuntimeSelection,
} from "@/lib/agent-runtime";

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
  const displayName =
    typeof payload.display_name === "string" ? payload.display_name.trim() : "";
  const description = payload.description;
  const systemPrompt = payload.system_prompt;
  const runtime = payload.runtime;
  const model = payload.model;
  const serverId =
    typeof payload.server_id === "string" ? payload.server_id.trim() : "";

  if (!displayName || displayName.length > 100) {
    return NextResponse.json(
      { error: "display_name must be between 1 and 100 characters" },
      { status: 400 }
    );
  }
  if (
    description !== undefined &&
    description !== null &&
    (typeof description !== "string" || description.length > 2000)
  ) {
    return NextResponse.json({ error: "Invalid description" }, { status: 400 });
  }
  if (
    systemPrompt !== undefined &&
    systemPrompt !== null &&
    (typeof systemPrompt !== "string" || systemPrompt.length > 50000)
  ) {
    return NextResponse.json({ error: "Invalid system_prompt" }, { status: 400 });
  }

  const baseName = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "agent";
  const name = `${baseName}-${user.id.substring(0, 8)}-${randomUUID().slice(0, 8)}`;

  const agentRuntime = normalizeAgentRuntime(runtime);
  if (runtime !== undefined && !isAgentRuntime(runtime)) {
    return NextResponse.json({ error: "Unsupported agent runtime" }, { status: 400 });
  }
  if (agentRuntime === "pi") {
    return NextResponse.json(
      { error: "Pi model connections are currently available in the local desktop app" },
      { status: 400 },
    );
  }
  const resolvedSelection = resolveAgentRuntimeSelection({
    runtime: agentRuntime,
    model,
  });
  if (resolvedSelection.issue) {
    return NextResponse.json({ error: "Unsupported runtime model" }, { status: 400 });
  }
  const agentModel = resolvedSelection.selection.model;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(serverId)) {
    return NextResponse.json(
      { error: "valid server_id is required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase.rpc("create_owned_agent_with_dm", {
    server_uuid: serverId,
    agent_name: name,
    agent_display_name: displayName,
    agent_description: typeof description === "string" ? description.trim() : "",
    agent_system_prompt: typeof systemPrompt === "string" ? systemPrompt.trim() : "",
    agent_runtime: agentRuntime,
    agent_model: agentModel,
  });
  if (error || !data) {
    const status = error?.code === "42501"
      ? 403
      : error?.code === "22023"
        ? 400
        : error?.code === "23505" || /duplicate|unique/i.test(error?.message || "")
          ? 409
          : 500;
    return NextResponse.json(
      { error: error?.message || "Agent creation failed" },
      { status },
    );
  }
  const result = data as {
    agent?: Record<string, unknown>;
    channel?: Record<string, unknown>;
  };
  if (!result.agent || !result.channel) {
    return NextResponse.json({ error: "Agent creation failed" }, { status: 500 });
  }

  return NextResponse.json(
    { agent: result.agent, channel: result.channel },
    { status: 201 },
  );
}
