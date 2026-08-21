import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  if (!serverId || !UUID_PATTERN.test(serverId)) {
    return NextResponse.json(
      { error: "valid server_id is required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("machine_keys")
    .select("id, key_prefix, name, created_at, last_used_at")
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
  const serverId = typeof payload.server_id === "string" ? payload.server_id : "";
  const name = typeof payload.name === "string" ? payload.name.trim() : "Default";

  if (!UUID_PATTERN.test(serverId)) {
    return NextResponse.json(
      { error: "valid server_id is required" },
      { status: 400 }
    );
  }
  if (!name || name.length > 100) {
    return NextResponse.json(
      { error: "name must be between 1 and 100 characters" },
      { status: 400 },
    );
  }

  // Generate a secure random key
  const rawKey = randomBytes(32).toString("hex");
  const apiKey = `tm_${rawKey}`;
  const keyPrefix = `tm_${rawKey.substring(0, 8)}`;
  const keyHash = createHash("sha256").update(apiKey).digest("hex");

  // Membership validation, eviction-compatible locks, and the insert happen
  // in one transaction. The raw secret is only returned by this HTTP request.
  const { data, error } = await supabase.rpc("create_current_user_machine_key", {
    server_uuid: serverId,
    machine_key_prefix: keyPrefix,
    machine_key_hash: keyHash,
    machine_key_name: name,
  });

  if (error) {
    const accessDenied =
      error.code === "42501" || /authentication required|workspace access denied/i.test(error.message);
    const invalid = error.code === "22023" || /invalid runtime key/i.test(error.message);
    const duplicate = error.code === "23505" || /unique constraint/i.test(error.message);
    const status = accessDenied ? 403 : invalid ? 400 : duplicate ? 409 : 500;
    const message = accessDenied
      ? "You are not a member of this workspace"
      : invalid
        ? "Invalid runtime key"
        : duplicate
          ? "Runtime key conflict; try again"
          : "Failed to create runtime key";
    return NextResponse.json(
      { error: message },
      { status },
    );
  }

  // Return the full key only this once
  return NextResponse.json({ key: data, apiKey }, { status: 201 });
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
  const id = typeof payload.id === "string" ? payload.id : "";
  const name = typeof payload.name === "string" ? payload.name.trim() : "";

  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }

  if (!name || name.length > 100) {
    return NextResponse.json(
      { error: "name must be between 1 and 100 characters" },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from("machine_keys")
    .update({ name })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id, key_prefix, name, created_at, last_used_at")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Runtime key not found" }, { status: 404 });
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
  const serverId = request.nextUrl.searchParams.get("server_id");
  if (!keyId || !UUID_PATTERN.test(keyId)) {
    return NextResponse.json(
      { error: "valid id is required" },
      { status: 400 }
    );
  }
  if (serverId !== null && !UUID_PATTERN.test(serverId)) {
    return NextResponse.json({ error: "valid server_id is required" }, { status: 400 });
  }

  let deletion = supabase
    .from("machine_keys")
    .delete()
    .eq("id", keyId)
    .eq("user_id", user.id);
  if (serverId) deletion = deletion.eq("server_id", serverId);
  const { data, error } = await deletion.select("id").maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Runtime key not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
