import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SelectedChannelMember = {
  member_id: string;
  member_type: "human" | "agent";
};

function parseSelectedMembers(value: unknown): SelectedChannelMember[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return null;
  const selected: SelectedChannelMember[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }
    const record = candidate as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      typeof record.member_id !== "string" ||
      !UUID_PATTERN.test(record.member_id) ||
      (record.member_type !== "human" && record.member_type !== "agent") ||
      ids.has(record.member_id)
    ) {
      return null;
    }
    ids.add(record.member_id);
    selected.push({
      member_id: record.member_id,
      member_type: record.member_type,
    });
  }
  return selected;
}

async function canAccessServer(
  supabase: Awaited<ReturnType<typeof createClient>>,
  serverId: string,
  userId: string,
) {
  const [serverResult, membershipResult] = await Promise.all([
    supabase
      .from("servers")
      .select("id, owner_id")
      .eq("id", serverId)
      .maybeSingle(),
    supabase
      .from("server_members")
      .select("member_id")
      .eq("server_id", serverId)
      .eq("member_id", userId)
      .eq("member_type", "human")
      .maybeSingle(),
  ]);
  if (serverResult.error || membershipResult.error) {
    throw new Error(serverResult.error?.message || membershipResult.error?.message);
  }
  return Boolean(
    serverResult.data &&
      (serverResult.data.owner_id === userId || membershipResult.data),
  );
}

// GET /api/channels — list channels
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const serverId = request.nextUrl.searchParams.get("server_id")?.trim() || "";
  if (!UUID_PATTERN.test(serverId)) {
    return NextResponse.json({ error: "valid server_id required" }, { status: 400 });
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    if (!(await canAccessServer(supabase, serverId, user.id))) {
      return NextResponse.json({ error: "Workspace access denied" }, { status: 403 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Workspace lookup failed" },
      { status: 500 },
    );
  }

  const { data, error } = await supabase
    .from("channels")
    .select("*")
    .eq("server_id", serverId)
    .order("created_at");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ channels: data ?? [] });
}

// POST /api/channels — create channel
export async function POST(request: NextRequest) {
  const supabase = await createClient();
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
  if (
    Object.keys(payload).some(
      (key) => !["name", "server_id", "type", "description", "selected_members"].includes(key),
    )
  ) {
    return NextResponse.json({ error: "Unsupported request field" }, { status: 400 });
  }
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const serverId =
    typeof payload.server_id === "string" ? payload.server_id.trim() : "";
  const type = payload.type === undefined ? "public" : payload.type;
  const description = payload.description;
  const selectedMembers = parseSelectedMembers(payload.selected_members);
  if (!name || name.length > 100) {
    return NextResponse.json(
      { error: "name must be between 1 and 100 characters" },
      { status: 400 },
    );
  }
  if (!UUID_PATTERN.test(serverId)) {
    return NextResponse.json({ error: "valid server_id required" }, { status: 400 });
  }
  if (type !== "public" && type !== "private") {
    return NextResponse.json(
      { error: "type must be public or private" },
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
  if (!selectedMembers) {
    return NextResponse.json(
      { error: "selected_members must contain at most 100 unique valid members" },
      { status: 400 },
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase.rpc("create_channel_with_members", {
    server_uuid: serverId,
    channel_name: name,
    channel_description:
      typeof description === "string" ? description.trim() || null : null,
    channel_type: type,
    selected_members: selectedMembers,
  });
  if (error || !data || typeof data !== "object" || !("channel" in data)) {
    const message = error?.message || "Channel creation failed";
    const status = error?.code === "42501" || /access denied/i.test(message)
      ? 403
      : error?.code === "23505" || /already exists|unique constraint/i.test(message)
        ? 409
        : error?.code === "22023" || error?.code === "22P02" || /invalid|must|exclude/i.test(message)
          ? 400
          : error?.code === "P0002"
            ? 404
            : 500;
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json({ channel: data.channel, members: data.members }, { status: 201 });
}
