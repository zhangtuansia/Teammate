#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";
const LOCAL_SERVER_ID = "00000000-0000-4000-8000-000000001001";
const LOCAL_AGENT_ID = "00000000-0000-4000-8000-000000002001";
const LOCAL_DM_ID = "00000000-0000-4000-8000-000000003001";
const LOCAL_CHANNEL_ID = "00000000-0000-4000-8000-000000003002";
const LOCAL_KEY_ID = "00000000-0000-4000-8000-000000004001";
const LOCAL_API_KEY = "zk_local";

const port = Number(process.env.ZANO_LOCAL_PORT || 8787);
const dbPath = resolve(process.env.ZANO_LOCAL_DB || ".zano/local.db");
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

const tableColumns = {
  profiles: ["id", "email", "display_name", "avatar_url", "created_at"],
  servers: ["id", "name", "slug", "description", "owner_id", "created_at"],
  server_members: ["server_id", "member_id", "member_type", "role", "joined_at"],
  agents: [
    "id",
    "name",
    "display_name",
    "description",
    "system_prompt",
    "model",
    "status",
    "owner_id",
    "server_id",
    "workspace_path",
    "session_id",
    "avatar_url",
    "created_at",
  ],
  channels: ["id", "name", "description", "type", "created_by", "server_id", "created_at"],
  channel_members: ["channel_id", "member_id", "member_type", "joined_at"],
  messages: [
    "id",
    "channel_id",
    "sender_id",
    "sender_type",
    "content",
    "seq",
    "thread_parent_id",
    "created_at",
    "updated_at",
  ],
  tasks: [
    "id",
    "message_id",
    "channel_id",
    "task_number",
    "status",
    "assignee_id",
    "assignee_type",
    "created_at",
    "updated_at",
  ],
  machine_keys: [
    "id",
    "key_prefix",
    "key_hash",
    "key_value",
    "user_id",
    "server_id",
    "name",
    "created_at",
    "last_used_at",
  ],
} as const;

type TableName = keyof typeof tableColumns;
type DbRow = Record<string, unknown>;

interface QueryFilter {
  column?: string;
  operator: string;
  value: unknown;
}

interface QueryRequest {
  table: string;
  action: "select" | "insert" | "update" | "delete";
  filters?: QueryFilter[];
  values?: unknown;
  order?: { column: string; ascending: boolean };
  limit?: number;
  count?: "exact";
  head?: boolean;
  single?: boolean;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    owner_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS server_members (
    server_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    member_type TEXT NOT NULL,
    role TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (server_id, member_id)
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT,
    model TEXT NOT NULL DEFAULT 'sonnet',
    status TEXT NOT NULL DEFAULT 'offline',
    owner_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    workspace_path TEXT,
    session_id TEXT,
    avatar_url TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (server_id, name)
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL DEFAULT 'public',
    created_by TEXT NOT NULL,
    server_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (server_id, name)
  );

  CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    member_type TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, member_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_type TEXT NOT NULL,
    content TEXT NOT NULL,
    seq INTEGER NOT NULL,
    thread_parent_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_local_messages_channel_seq
    ON messages(channel_id, seq DESC);

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL UNIQUE,
    channel_id TEXT NOT NULL,
    task_number INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'todo',
    assignee_id TEXT,
    assignee_type TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS machine_keys (
    id TEXT PRIMARY KEY,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_value TEXT,
    user_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS local_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    kind TEXT NOT NULL,
    event_name TEXT NOT NULL,
    table_name TEXT,
    payload TEXT,
    record TEXT,
    created_at TEXT NOT NULL
  );
`);

seedDatabase();

const server = createServer(async (request, response) => {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${port}`}`);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        ok: true,
        mode: "local",
        database: dbPath,
      });
    }

    if (url.pathname === "/api/agents") {
      return handleAgentsRequest(request, response);
    }

    const agentRoute = url.pathname.match(/^\/api\/agents\/([^/]+)(?:\/(reset|workspace))?$/);
    if (agentRoute) {
      return handleAgentRequest(request, response, url, agentRoute[1], agentRoute[2]);
    }

    if (request.method === "GET" && url.pathname === "/api/skills") {
      return sendJson(response, 200, await listLocalSkills());
    }

    if (request.method === "POST" && url.pathname === "/api/query") {
      const query = (await readJson(request)) as QueryRequest;
      return sendJson(response, 200, executeQuery(query));
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      return sendJson(response, 200, getEvents(url.searchParams.get("after")));
    }

    if (request.method === "POST" && url.pathname === "/api/broadcast") {
      const body = (await readJson(request)) as {
        topic?: string;
        event?: string;
        payload?: Record<string, unknown>;
      };
      if (!body.topic || !body.event) {
        return sendJson(response, 400, { error: "topic and event are required" });
      }
      emitEvent({
        topic: body.topic,
        kind: "broadcast",
        event: body.event,
        payload: body.payload || {},
      });
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/bridge/connect") {
      const body = (await readJson(request)) as { apiKey?: string; hostname?: string };
      if (body.apiKey !== LOCAL_API_KEY) {
        return sendJson(response, 401, { error: "Invalid local API key" });
      }

      const now = new Date().toISOString();
      db.prepare("UPDATE machine_keys SET last_used_at = ?, name = ? WHERE id = ?").run(
        now,
        body.hostname || "Local machine",
        LOCAL_KEY_ID
      );
      const key = db.prepare("SELECT * FROM machine_keys WHERE id = ?").get(LOCAL_KEY_ID) as DbRow;
      emitDatabaseEvent("UPDATE", "machine_keys", key);

      const agents = db
        .prepare("SELECT id, name, display_name, description, model, status FROM agents WHERE owner_id = ? AND server_id = ? ORDER BY created_at")
        .all(LOCAL_USER_ID, LOCAL_SERVER_ID);

      const localServerUrl = `http://${request.headers.host || `127.0.0.1:${port}`}`;
      return sendJson(response, 200, {
        localMode: true,
        localServerUrl,
        supabaseUrl: localServerUrl,
        supabaseAnonKey: "local",
        token: "local",
        userId: LOCAL_USER_ID,
        serverId: LOCAL_SERVER_ID,
        serverName: "Local Workspace",
        agents,
      });
    }

    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error("Local service request failed:", error);
    return sendJson(response, 500, {
      data: null,
      error: {
        message: error instanceof Error ? error.message : "Unknown local service error",
      },
      count: null,
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Zano local service ready at http://127.0.0.1:${port}`);
  console.log(`SQLite database: ${dbPath}`);
  console.log(`Local bridge key: ${LOCAL_API_KEY}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

function seedDatabase() {
  const now = new Date().toISOString();
  const insertProfile = db.prepare(
    "INSERT OR IGNORE INTO profiles (id, email, display_name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  insertProfile.run(LOCAL_USER_ID, "local@zano.dev", "Local User", null, now);

  db.prepare(
    "INSERT OR IGNORE INTO servers (id, name, slug, description, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    LOCAL_SERVER_ID,
    "Local Workspace",
    "local",
    "Runs entirely on this Mac with Node and SQLite.",
    LOCAL_USER_ID,
    now
  );

  db.prepare(
    "INSERT OR IGNORE INTO server_members (server_id, member_id, member_type, role, joined_at) VALUES (?, ?, ?, ?, ?)"
  ).run(LOCAL_SERVER_ID, LOCAL_USER_ID, "human", "owner", now);

  db.prepare(
    `INSERT OR IGNORE INTO agents
      (id, name, display_name, description, system_prompt, model, status, owner_id, server_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    LOCAL_AGENT_ID,
    "local-assistant",
    "Local Assistant",
    "A Claude Code agent running entirely through the local Zano service.",
    "You are the local Zano assistant. Reply in the user's language and help with work on this machine.",
    "sonnet",
    "offline",
    LOCAL_USER_ID,
    LOCAL_SERVER_ID,
    now
  );

  db.prepare(
    "INSERT OR IGNORE INTO server_members (server_id, member_id, member_type, role, joined_at) VALUES (?, ?, ?, ?, ?)"
  ).run(LOCAL_SERVER_ID, LOCAL_AGENT_ID, "agent", "member", now);

  db.prepare(
    "INSERT OR IGNORE INTO channels (id, name, description, type, created_by, server_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    LOCAL_DM_ID,
    "Local Assistant",
    "Direct chat with the local Claude Code agent",
    "dm",
    LOCAL_USER_ID,
    LOCAL_SERVER_ID,
    now
  );
  db.prepare(
    "INSERT OR IGNORE INTO channels (id, name, description, type, created_by, server_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    LOCAL_CHANNEL_ID,
    "general",
    "Local human and agent collaboration",
    "public",
    LOCAL_USER_ID,
    LOCAL_SERVER_ID,
    now
  );

  const addMember = db.prepare(
    "INSERT OR IGNORE INTO channel_members (channel_id, member_id, member_type, joined_at) VALUES (?, ?, ?, ?)"
  );
  for (const channelId of [LOCAL_DM_ID, LOCAL_CHANNEL_ID]) {
    addMember.run(channelId, LOCAL_USER_ID, "human", now);
    addMember.run(channelId, LOCAL_AGENT_ID, "agent", now);
  }

  db.prepare(
    `INSERT OR IGNORE INTO machine_keys
      (id, key_prefix, key_hash, key_value, user_id, server_id, name, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    LOCAL_KEY_ID,
    "zk_local",
    createHash("sha256").update(LOCAL_API_KEY).digest("hex"),
    LOCAL_API_KEY,
    LOCAL_USER_ID,
    LOCAL_SERVER_ID,
    "Local machine",
    now,
    null
  );

  const messageCount = Number(
    (db.prepare("SELECT count(*) AS count FROM messages").get() as { count: number }).count
  );
  if (messageCount === 0) {
    db.prepare(
      `INSERT INTO messages
        (id, channel_id, sender_id, sender_type, content, seq, thread_parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      LOCAL_DM_ID,
      LOCAL_AGENT_ID,
      "agent",
      "你好，我是 Local Assistant。这里的消息保存在本机 SQLite，启动 Bridge 后我会通过 Claude Code 真正回复你。",
      1,
      null,
      now,
      now
    );
  }
}

async function handleAgentsRequest(request: IncomingMessage, response: ServerResponse) {
  if (request.method === "GET") {
    const agents = db
      .prepare("SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at")
      .all(LOCAL_USER_ID);
    return sendJson(response, 200, { agents });
  }

  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Method not allowed" });
  }

  const body = (await readJson(request)) as {
    display_name?: string;
    description?: string;
    system_prompt?: string;
    model?: string;
    server_id?: string;
  };
  const displayName = body.display_name?.trim();
  if (!displayName || !body.server_id) {
    return sendJson(response, 400, { error: "display_name and server_id are required" });
  }

  const baseName =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "agent";
  const model = ["opus", "sonnet", "haiku"].includes(body.model || "")
    ? body.model
    : "sonnet";
  const agent = queryData({
    table: "agents",
    action: "insert",
    single: true,
    values: {
      name: `${baseName}-${randomUUID().slice(0, 8)}`,
      display_name: displayName,
      description: body.description?.trim() || null,
      system_prompt: body.system_prompt?.trim() || null,
      model,
      status: "offline",
      owner_id: LOCAL_USER_ID,
      server_id: body.server_id,
    },
  }) as DbRow;

  try {
    const channel = queryData({
      table: "channels",
      action: "insert",
      single: true,
      values: {
        name: displayName,
        description: `Direct chat with ${displayName}`,
        type: "dm",
        created_by: LOCAL_USER_ID,
        server_id: body.server_id,
      },
    }) as DbRow;
    queryData({
      table: "channel_members",
      action: "insert",
      values: [
        { channel_id: channel.id, member_id: LOCAL_USER_ID, member_type: "human" },
        { channel_id: channel.id, member_id: agent.id, member_type: "agent" },
      ],
    });
    queryData({
      table: "server_members",
      action: "insert",
      values: {
        server_id: body.server_id,
        member_id: agent.id,
        member_type: "agent",
        role: "member",
      },
    });
    return sendJson(response, 200, { agent, channel });
  } catch (error) {
    queryData({
      table: "agents",
      action: "delete",
      filters: [{ column: "id", operator: "eq", value: agent.id }],
    });
    throw error;
  }
}

async function handleAgentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  agentId: string,
  action?: string,
) {
  const agent = db
    .prepare("SELECT * FROM agents WHERE id = ? AND owner_id = ?")
    .get(agentId, LOCAL_USER_ID) as DbRow | undefined;
  if (!agent) return sendJson(response, 404, { error: "Agent not found" });

  if (action === "reset" && request.method === "POST") {
    const memberships = db
      .prepare(
        `SELECT cm.channel_id FROM channel_members cm
         JOIN channels c ON c.id = cm.channel_id
         WHERE cm.member_id = ? AND cm.member_type = 'agent' AND c.type = 'dm'`,
      )
      .all(agentId) as Array<{ channel_id: string }>;
    let messagesDeleted = 0;
    for (const membership of memberships) {
      const result = executeQuery({
        table: "messages",
        action: "delete",
        filters: [{ column: "channel_id", operator: "eq", value: membership.channel_id }],
      });
      messagesDeleted += result.count || 0;
    }
    executeQuery({
      table: "agents",
      action: "update",
      values: { session_id: null },
      filters: [{ column: "id", operator: "eq", value: agentId }],
    });
    return sendJson(response, 200, { success: true, messagesDeleted });
  }

  if (action === "workspace" && request.method === "GET") {
    return sendJson(response, 200, await readAgentWorkspace(agent, url.searchParams.get("file")));
  }

  if (action) return sendJson(response, 405, { error: "Method not allowed" });

  if (request.method === "GET") return sendJson(response, 200, { agent });

  if (request.method === "PUT") {
    const body = (await readJson(request)) as Record<string, unknown>;
    const updates: DbRow = {};
    if (body.display_name !== undefined) {
      const displayName = String(body.display_name).trim();
      if (!displayName) return sendJson(response, 400, { error: "display_name cannot be empty" });
      updates.display_name = displayName;
    }
    if (body.description !== undefined) {
      updates.description = String(body.description || "").trim() || null;
    }
    if (body.system_prompt !== undefined) {
      updates.system_prompt = String(body.system_prompt || "").trim() || null;
    }
    if (body.model !== undefined) {
      const model = String(body.model);
      if (!["opus", "sonnet", "haiku"].includes(model)) {
        return sendJson(response, 400, { error: "Unsupported Claude model" });
      }
      updates.model = model;
    }
    const updated = queryData({
      table: "agents",
      action: "update",
      values: updates,
      single: true,
      filters: [{ column: "id", operator: "eq", value: agentId }],
    });
    return sendJson(response, 200, { agent: updated });
  }

  if (request.method === "DELETE") {
    const dmChannels = db
      .prepare(
        `SELECT c.id FROM channels c
         JOIN channel_members cm ON cm.channel_id = c.id
         WHERE cm.member_id = ? AND cm.member_type = 'agent' AND c.type = 'dm'`,
      )
      .all(agentId) as Array<{ id: string }>;
    for (const channel of dmChannels) {
      for (const table of ["messages", "channel_members"] as const) {
        executeQuery({
          table,
          action: "delete",
          filters: [{ column: "channel_id", operator: "eq", value: channel.id }],
        });
      }
      executeQuery({
        table: "channels",
        action: "delete",
        filters: [{ column: "id", operator: "eq", value: channel.id }],
      });
    }
    executeQuery({
      table: "channel_members",
      action: "delete",
      filters: [{ column: "member_id", operator: "eq", value: agentId }],
    });
    executeQuery({
      table: "server_members",
      action: "delete",
      filters: [{ column: "member_id", operator: "eq", value: agentId }],
    });
    executeQuery({
      table: "agents",
      action: "delete",
      filters: [{ column: "id", operator: "eq", value: agentId }],
    });
    return sendJson(response, 200, { success: true });
  }

  return sendJson(response, 405, { error: "Method not allowed" });
}

async function readAgentWorkspace(agent: DbRow, requestedFile: string | null) {
  const configuredRoot =
    typeof agent.workspace_path === "string" && agent.workspace_path
      ? agent.workspace_path
      : join(process.env.ZANO_AGENTS_DIR || ".zano/agents", String(agent.id));
  const workspaceRoot = resolve(configuredRoot);

  if (requestedFile) {
    const requestedPath = resolve(workspaceRoot, requestedFile);
    if (requestedPath !== workspaceRoot && !requestedPath.startsWith(`${workspaceRoot}${sep}`)) {
      throw new Error("Invalid file path");
    }
    return { file: requestedFile, content: await readFile(requestedPath, "utf8") };
  }

  const files: Array<{ name: string; type: "file" | "directory"; size: number; modified: string }> = [];
  try {
    for (const name of await readdir(workspaceRoot)) {
      if (name.startsWith(".")) continue;
      const entry = await stat(join(workspaceRoot, name));
      files.push({
        name,
        type: entry.isDirectory() ? "directory" : "file",
        size: entry.size,
        modified: entry.mtime.toISOString(),
      });
    }
  } catch {
    // Workspace is created by the bridge and may not exist yet.
  }
  return { workspace_path: workspaceRoot, files, notes_files: files.filter((file) => file.name.startsWith("notes/")) };
}

async function listLocalSkills() {
  const skills: Array<{ name: string; description: string }> = [];
  const skillsRoot = join(homedir(), ".claude", "skills");
  try {
    for (const name of await readdir(skillsRoot)) {
      if (name.startsWith(".")) continue;
      const entryPath = join(skillsRoot, name);
      const entry = await lstat(entryPath);
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      let description = name;
      for (const filename of ["SKILL.md", "skill.md"]) {
        try {
          const content = await readFile(join(entryPath, filename), "utf8");
          const match = content.match(/^description:\s*(.+)$/m);
          if (match) description = match[1].trim().replace(/^['"]|['"]$/g, "");
          break;
        } catch {
          // Try the next conventional filename.
        }
      }
      skills.push({ name, description });
    }
  } catch {
    // Claude skills are optional.
  }
  return { skills };
}

function queryData(query: QueryRequest) {
  return executeQuery(query).data;
}

function executeQuery(query: QueryRequest) {
  const table = assertTable(query.table);
  const filters = query.filters || [];
  const { clause: whereClause, params: whereParams } = buildWhere(table, filters);

  if (query.action === "select") {
    const count = query.count === "exact"
      ? Number(
          (db.prepare(`SELECT count(*) AS count FROM ${table}${whereClause}`).get(...whereParams) as { count: number }).count
        )
      : null;

    if (query.head) return { data: [], error: null, count };

    const orderClause = query.order
      ? ` ORDER BY ${assertColumn(table, query.order.column)} ${query.order.ascending ? "ASC" : "DESC"}`
      : "";
    const hasLimit = typeof query.limit === "number" && Number.isFinite(query.limit);
    const limitClause = hasLimit ? " LIMIT ?" : "";
    const params: SQLInputValue[] = [...whereParams];
    if (hasLimit) params.push(query.limit as number);
    const rows = db
      .prepare(`SELECT * FROM ${table}${whereClause}${orderClause}${limitClause}`)
      .all(...params) as DbRow[];
    return {
      data: query.single ? rows[0] || null : rows,
      error: null,
      count,
    };
  }

  if (query.action === "insert") {
    const inputRows = Array.isArray(query.values) ? query.values : [query.values];
    const inserted: DbRow[] = [];
    for (const input of inputRows) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Insert values must be an object or array of objects");
      }
      const row = applyDefaults(table, { ...(input as DbRow) });
      const columns = Object.keys(row).map((column) => assertColumn(table, column));
      const placeholders = columns.map(() => "?").join(", ");
      db.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`
      ).run(...columns.map((column) => toSqlValue(row[column])));
      const stored = fetchInsertedRow(table, row);
      inserted.push(stored);
      emitDatabaseEvent("INSERT", table, stored);
    }
    return {
      data: query.single ? inserted[0] || null : inserted,
      error: null,
      count: inserted.length,
    };
  }

  if (query.action === "update") {
    if (!query.values || typeof query.values !== "object" || Array.isArray(query.values)) {
      throw new Error("Update values must be an object");
    }
    const values = { ...(query.values as DbRow) };
    if (
      (tableColumns[table] as readonly string[]).includes("updated_at") &&
      values.updated_at === undefined
    ) {
      values.updated_at = new Date().toISOString();
    }
    const columns = Object.keys(values).map((column) => assertColumn(table, column));
    if (columns.length === 0) return { data: [], error: null, count: 0 };
    const setClause = columns.map((column) => `${column} = ?`).join(", ");
    const rows = db
      .prepare(`UPDATE ${table} SET ${setClause}${whereClause} RETURNING *`)
      .all(
        ...columns.map((column) => toSqlValue(values[column])),
        ...whereParams
      ) as DbRow[];
    for (const row of rows) emitDatabaseEvent("UPDATE", table, row);
    return {
      data: query.single ? rows[0] || null : rows,
      error: null,
      count: rows.length,
    };
  }

  const rows = db
    .prepare(`DELETE FROM ${table}${whereClause} RETURNING *`)
    .all(...whereParams) as DbRow[];
  for (const row of rows) emitDatabaseEvent("DELETE", table, row);
  return {
    data: query.single ? rows[0] || null : rows,
    error: null,
    count: rows.length,
  };
}

function buildWhere(table: TableName, filters: QueryFilter[]) {
  if (filters.length === 0) return { clause: "", params: [] as SQLInputValue[] };
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];

  for (const filter of filters) {
    if (filter.operator === "or") {
      const alternatives = String(filter.value)
        .split(",")
        .map((item) => {
          const separator = item.indexOf(".eq.");
          if (separator < 1) throw new Error(`Unsupported OR filter: ${item}`);
          const column = assertColumn(table, item.slice(0, separator));
          params.push(item.slice(separator + 4));
          return `${column} = ?`;
        });
      clauses.push(`(${alternatives.join(" OR ")})`);
      continue;
    }

    const column = assertColumn(table, filter.column || "");
    switch (filter.operator) {
      case "eq":
        clauses.push(`${column} = ?`);
        params.push(toSqlValue(filter.value));
        break;
      case "neq":
        clauses.push(`${column} != ?`);
        params.push(toSqlValue(filter.value));
        break;
      case "in": {
        const values = Array.isArray(filter.value) ? filter.value : [];
        if (values.length === 0) {
          clauses.push("0 = 1");
        } else {
          clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`);
          params.push(...values.map(toSqlValue));
        }
        break;
      }
      case "is":
        if (filter.value === null) clauses.push(`${column} IS NULL`);
        else {
          clauses.push(`${column} IS ?`);
          params.push(toSqlValue(filter.value));
        }
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const symbols = { lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;
        clauses.push(`${column} ${symbols[filter.operator]} ?`);
        params.push(toSqlValue(filter.value));
        break;
      }
      case "ilike":
        clauses.push(`LOWER(${column}) LIKE LOWER(?)`);
        params.push(toSqlValue(filter.value));
        break;
      default:
        throw new Error(`Unsupported filter operator: ${filter.operator}`);
    }
  }
  return { clause: ` WHERE ${clauses.join(" AND ")}`, params };
}

function applyDefaults(table: TableName, row: DbRow) {
  const now = new Date().toISOString();
  const columns = tableColumns[table] as readonly string[];
  if (columns.includes("id") && !row.id) row.id = randomUUID();
  if (columns.includes("created_at") && !row.created_at) row.created_at = now;
  if (columns.includes("updated_at") && !row.updated_at) row.updated_at = now;
  if (columns.includes("joined_at") && !row.joined_at) row.joined_at = now;

  if (table === "messages" && row.seq === undefined) {
    const result = db
      .prepare("SELECT coalesce(max(seq), 0) + 1 AS next_seq FROM messages WHERE channel_id = ?")
      .get(toSqlValue(row.channel_id)) as { next_seq: number };
    row.seq = result.next_seq;
    row.thread_parent_id ??= null;
  }
  if (table === "tasks" && row.task_number === undefined) {
    const result = db.prepare("SELECT coalesce(max(task_number), 0) + 1 AS next_number FROM tasks").get() as {
      next_number: number;
    };
    row.task_number = result.next_number;
    row.status ??= "todo";
    row.assignee_id ??= null;
    row.assignee_type ??= null;
  }
  if (table === "agents") {
    row.model ??= "sonnet";
    row.status ??= "offline";
    row.workspace_path ??= null;
    row.session_id ??= null;
    row.avatar_url ??= null;
  }
  if (table === "server_members") row.role ??= "member";
  return row;
}

function fetchInsertedRow(table: TableName, row: DbRow) {
  if (row.id) {
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(toSqlValue(row.id)) as DbRow;
  }
  if (table === "server_members") {
    return db
      .prepare("SELECT * FROM server_members WHERE server_id = ? AND member_id = ?")
      .get(toSqlValue(row.server_id), toSqlValue(row.member_id)) as DbRow;
  }
  if (table === "channel_members") {
    return db
      .prepare("SELECT * FROM channel_members WHERE channel_id = ? AND member_id = ?")
      .get(toSqlValue(row.channel_id), toSqlValue(row.member_id)) as DbRow;
  }
  return row;
}

function getEvents(afterValue: string | null) {
  const latest = Number(
    (db.prepare("SELECT coalesce(max(id), 0) AS id FROM local_events").get() as { id: number }).id
  );
  if (afterValue === null) return { cursor: latest, events: [] };

  const after = Number(afterValue) || 0;
  const rows = db
    .prepare(
      "SELECT id, topic, kind, event_name, table_name, payload, record FROM local_events WHERE id > ? ORDER BY id ASC LIMIT 200"
    )
    .all(after) as Array<{
    id: number;
    topic: string;
    kind: string;
    event_name: string;
    table_name: string | null;
    payload: string | null;
    record: string | null;
  }>;
  const events = rows.map((row) => ({
    id: row.id,
    topic: row.topic,
    kind: row.kind,
    event: row.event_name,
    table_name: row.table_name,
    payload: row.payload ? JSON.parse(row.payload) : null,
    record: row.record ? JSON.parse(row.record) : null,
  }));
  return {
    cursor: events.length > 0 ? events[events.length - 1].id : latest,
    events,
  };
}

function emitDatabaseEvent(event: "INSERT" | "UPDATE" | "DELETE", table: TableName, record: DbRow) {
  emitEvent({
    topic: "database",
    kind: "postgres_changes",
    event,
    table,
    record,
  });
}

function emitEvent(input: {
  topic: string;
  kind: "postgres_changes" | "broadcast";
  event: string;
  table?: string;
  payload?: Record<string, unknown>;
  record?: DbRow;
}) {
  db.prepare(
    `INSERT INTO local_events
      (topic, kind, event_name, table_name, payload, record, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.topic,
    input.kind,
    input.event,
    input.table || null,
    input.payload ? JSON.stringify(input.payload) : null,
    input.record ? JSON.stringify(input.record) : null,
    new Date().toISOString()
  );
}

function assertTable(value: string): TableName {
  if (!(value in tableColumns)) throw new Error(`Unknown table: ${value}`);
  return value as TableName;
}

function assertColumn(table: TableName, value: string) {
  if (!(tableColumns[table] as readonly string[]).includes(value)) {
    throw new Error(`Unknown column ${table}.${value}`);
  }
  return value;
}

function toSqlValue(value: unknown): SQLInputValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function setCors(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
