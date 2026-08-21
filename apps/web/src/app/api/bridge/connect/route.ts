import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { signAgentJwt, signBridgeJwt } from "@/lib/jwt";

/**
 * POST /api/bridge/connect
 *
 * Validates a machine API key and returns credentials for the bridge to
 * connect to Supabase. The bridge never receives the service role key —
 * only a scoped JWT that identifies the user.
 *
 * Request body: { apiKey: "tm_..." }
 * Response v2 separates the controller credential from per-agent credentials.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "JSON object required" }, { status: 400 });
  }
  const payload = body as Record<string, unknown>;
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
  const hostname = typeof payload.hostname === "string" ? payload.hostname.trim() : "";

  if (!/^tm_[0-9a-f]{64}$/.test(apiKey)) {
    return NextResponse.json({ error: "Invalid apiKey format" }, { status: 400 });
  }
  if (
    (payload.hostname !== undefined && typeof payload.hostname !== "string") ||
    hostname.length > 100
  ) {
    return NextResponse.json({ error: "Invalid hostname" }, { status: 400 });
  }

  // Hash the key and look it up
  const keyHash = createHash("sha256").update(apiKey).digest("hex");

  const admin = createAdminClient();

  const { data: keyRecord, error: keyError } = await admin
    .from("machine_keys")
    .select("id, user_id, server_id")
    .eq("key_hash", keyHash)
    .maybeSingle();

  if (keyError) {
    return NextResponse.json({ error: "Runtime key lookup failed" }, { status: 500 });
  }
  if (!keyRecord) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  }

  // Load server info
  const { data: server, error: serverError } = await admin
    .from("servers")
    .select("id, name, slug, owner_id")
    .eq("id", keyRecord.server_id)
    .maybeSingle();

  if (serverError) {
    return NextResponse.json({ error: "Workspace lookup failed" }, { status: 500 });
  }

  if (!server) {
    return NextResponse.json(
      { error: "Server not found for this key" },
      { status: 404 }
    );
  }

  if (server.owner_id !== keyRecord.user_id) {
    const { data: membership, error: membershipError } = await admin
      .from("server_members")
      .select("server_id")
      .eq("server_id", keyRecord.server_id)
      .eq("member_id", keyRecord.user_id)
      .eq("member_type", "human")
      .maybeSingle();
    if (membershipError) {
      return NextResponse.json({ error: "Workspace membership lookup failed" }, { status: 500 });
    }
    if (!membership) {
      return NextResponse.json(
        { error: "This runtime key no longer has access to the workspace" },
        { status: 403 },
      );
    }
  }

  // Only mark the key active after its current workspace access is confirmed.
  const keyUpdate: Record<string, string> = {
    last_used_at: new Date().toISOString(),
  };
  if (hostname) keyUpdate.name = hostname;
  const { data: activatedKey, error: keyUpdateError } = await admin
    .from("machine_keys")
    .update(keyUpdate)
    .eq("id", keyRecord.id)
    .eq("user_id", keyRecord.user_id)
    .eq("server_id", keyRecord.server_id)
    .eq("key_hash", keyHash)
    .select("id")
    .maybeSingle();
  if (keyUpdateError) {
    return NextResponse.json({ error: "Runtime key activation failed" }, { status: 500 });
  }
  if (!activatedKey) {
    return NextResponse.json({ error: "Runtime key is no longer active" }, { status: 401 });
  }

  // Load the owner's agents, then require a live agent workspace membership.
  const { data: agents, error: agentsError } = await admin
    .from("agents")
    .select("id, name, display_name, description, model, status")
    .eq("owner_id", keyRecord.user_id)
    .eq("server_id", keyRecord.server_id)
    .order("created_at");
  if (agentsError) {
    return NextResponse.json({ error: "Agent lookup failed" }, { status: 500 });
  }

  const candidateAgents = agents ?? [];
  const candidateAgentIds = candidateAgents.map((agent) => agent.id);
  let liveAgentIds = new Set<string>();
  if (candidateAgentIds.length > 0) {
    const { data: memberships, error: membershipsError } = await admin
      .from("server_members")
      .select("member_id")
      .eq("server_id", keyRecord.server_id)
      .eq("member_type", "agent")
      .in("member_id", candidateAgentIds);
    if (membershipsError) {
      return NextResponse.json({ error: "Agent membership lookup failed" }, { status: 500 });
    }
    liveAgentIds = new Set((memberships ?? []).map((membership) => membership.member_id));
  }
  const liveAgents = candidateAgents.filter((agent) => liveAgentIds.has(agent.id));

  // One-hour token limits the lifetime of a revoked runtime connection.
  const token = signBridgeJwt(
    keyRecord.user_id,
    keyRecord.server_id,
    keyRecord.id,
  );
  const agentTokens = Object.fromEntries(
    liveAgents.map((agent) => [
      agent.id,
      signAgentJwt(agent.id, keyRecord.user_id, keyRecord.server_id, keyRecord.id),
    ]),
  );

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    protocolVersion: 2,
    supabaseUrl,
    supabaseAnonKey,
    token,
    agentTokens,
    userId: keyRecord.user_id,
    serverId: keyRecord.server_id,
    serverName: server.name,
    agents: liveAgents,
  });
}
