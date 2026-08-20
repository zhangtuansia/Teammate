import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/bridge/keys?server_id=...
 * List the user's machine API keys (metadata only, not the actual key).
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const serverId = request.nextUrl.searchParams.get("server_id");
  if (!serverId) {
    return NextResponse.json(
      { error: "server_id is required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("machine_keys")
    .select("id, key_prefix, key_value, name, created_at, last_used_at")
    .eq("user_id", user.id)
    .eq("server_id", serverId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ keys: data ?? [] });
}

/**
 * POST /api/bridge/keys
 * Generate a new machine API key. Returns the full key ONCE.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { server_id, name } = body;

  if (!server_id) {
    return NextResponse.json(
      { error: "server_id is required" },
      { status: 400 }
    );
  }

  // Verify user is a member of this server
  const { data: membership } = await supabase
    .from("server_members")
    .select("server_id")
    .eq("server_id", server_id)
    .eq("member_id", user.id)
    .eq("member_type", "human")
    .single();

  if (!membership) {
    return NextResponse.json(
      { error: "You are not a member of this server" },
      { status: 403 }
    );
  }

  // Generate a secure random key
  const rawKey = randomBytes(32).toString("hex");
  const apiKey = `zk_${rawKey}`;
  const keyPrefix = `zk_${rawKey.substring(0, 8)}`;
  const keyHash = createHash("sha256").update(apiKey).digest("hex");

  const { data, error } = await supabase
    .from("machine_keys")
    .insert({
      key_prefix: keyPrefix,
      key_hash: keyHash,
      key_value: apiKey,
      user_id: user.id,
      server_id,
      name: name?.trim() || "Default",
    })
    .select("id, key_prefix, key_value, name, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Return the full key only this once
  return NextResponse.json({
    key: data,
    apiKey, // Full key — shown once, then never retrievable
  });
}

/**
 * PATCH /api/bridge/keys
 * Update a machine API key's name.
 */
export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { id, name } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("machine_keys")
    .update({ name: name.trim() })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id, key_prefix, name, created_at, last_used_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ key: data });
}

/**
 * DELETE /api/bridge/keys?id=...
 * Revoke a machine API key.
 */
export async function DELETE(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const keyId = request.nextUrl.searchParams.get("id");
  if (!keyId) {
    return NextResponse.json(
      { error: "id is required" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("machine_keys")
    .delete()
    .eq("id", keyId)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
