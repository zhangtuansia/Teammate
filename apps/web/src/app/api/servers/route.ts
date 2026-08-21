import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { createClient } from "@/lib/supabase/server";
import {
  isValidWorkspaceSlug,
  workspaceSlugFromName,
} from "@/lib/workspace-slug";

// GET /api/servers — list servers the user belongs to
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get servers where user is a member
  const { data: memberships, error: membershipsError } = await supabase
    .from("server_members")
    .select("server_id")
    .eq("member_id", user.id)
    .eq("member_type", "human");

  if (membershipsError) {
    return NextResponse.json({ error: membershipsError.message }, { status: 500 });
  }

  if (!memberships || memberships.length === 0) {
    return NextResponse.json({ servers: [] });
  }

  const serverIds = memberships.map((m: { server_id: string }) => m.server_id);
  const { data: servers, error } = await supabase
    .from("servers")
    .select("*")
    .in("id", serverIds)
    .order("created_at");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ servers: servers ?? [] });
}

// POST /api/servers — create a new server
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
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const userSlug = typeof payload.slug === "string" ? payload.slug.trim() : "";
  const description = payload.description;

  if (!name || name.length > 100) {
    return NextResponse.json(
      { error: "name must be between 1 and 100 characters" },
      { status: 400 },
    );
  }
  if (
    description !== undefined &&
    description !== null &&
    (typeof description !== "string" || description.length > 1000)
  ) {
    return NextResponse.json(
      { error: "description must be a string of at most 1000 characters" },
      { status: 400 },
    );
  }

  const rawSlug = userSlug || workspaceSlugFromName(name);

  if (!isValidWorkspaceSlug(rawSlug)) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  const rawKey = randomBytes(32).toString("hex");
  const apiKey = `tm_${rawKey}`;
  const keyPrefix = `tm_${rawKey.substring(0, 8)}`;
  const keyHash = createHash("sha256").update(apiKey).digest("hex");

  const { data, error } = await supabase.rpc("create_owned_server", {
    server_name: name,
    server_slug: rawSlug,
    server_description:
      typeof description === "string" ? description.trim() : "",
    machine_key_prefix: keyPrefix,
    machine_key_hash: keyHash,
    // Kept for compatibility with the deployed RPC signature. The database
    // never stores this value, and the actual one-time key stays in this process.
    machine_key_value: `tm_${"0".repeat(64)}`,
    machine_key_name: "Default",
  });
  if (error || !data) {
    const duplicate = error?.code === "23505" || /duplicate|unique/i.test(error?.message || "");
    const status = duplicate
      ? 409
      : error?.code === "42501"
        ? 403
        : error?.code === "22023"
          ? 400
          : 500;
    return NextResponse.json(
      {
        error: duplicate
          ? "This slug is already taken. Please choose another one."
          : error?.message || "Workspace creation failed",
      },
      { status },
    );
  }
  const result = data as { server?: Record<string, unknown> };
  if (!result.server) {
    return NextResponse.json({ error: "Workspace creation failed" }, { status: 500 });
  }

  return NextResponse.json({ server: result.server, apiKey }, { status: 201 });
}
