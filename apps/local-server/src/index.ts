#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { lstat, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { TextDecoder } from "node:util";
import {
  CodexOAuthRefreshCoordinator,
  loginOpenAICodex,
} from "./chatgpt-oauth.js";
import {
  EncryptedCredentialStore,
  type StoredCredential,
} from "./credential-store.js";
import { deleteConnectionSafely } from "./connection-deletion.js";
import { CHATGPT_MODEL_CATALOG } from "./chatgpt-model-catalog.js";
import {
  enforcePrivateFileCreationMask,
  ensurePrivateDirectory,
  restrictPrivateFile,
  restrictSqliteFiles,
} from "./private-filesystem.js";

enforcePrivateFileCreationMask();

const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";
const LOCAL_SERVER_ID = "00000000-0000-4000-8000-000000001001";
const LOCAL_AGENT_ID = "00000000-0000-4000-8000-000000002001";
const LOCAL_DM_ID = "00000000-0000-4000-8000-000000003001";
const LOCAL_CHANNEL_ID = "00000000-0000-4000-8000-000000003002";
const LOCAL_KEY_ID = "00000000-0000-4000-8000-000000004001";
const CHATGPT_CONNECTION_ID = "00000000-0000-4000-8000-000000005001";
const LOCAL_KEY_PREFIX = "tm_local";
const LOCAL_CAPABILITY_CONTEXT = "teammate-local-agent-capability-v1";
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;
const LOCAL_REQUEST_TIMEOUT_MS = 30_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const configuredControllerCredential =
  process.env.TEAMMATE_LOCAL_CONTROLLER_TOKEN?.trim();
const localControllerCredential = configuredControllerCredential || randomBytes(32).toString("base64url");
if (localControllerCredential.length < 32) {
  throw new Error("TEAMMATE_LOCAL_CONTROLLER_TOKEN must contain at least 32 characters");
}
const localCapabilitySigningKey = createHmac("sha256", localControllerCredential)
  .update(LOCAL_CAPABILITY_CONTEXT)
  .digest();
const agentCapabilityTtlMs = process.env.NODE_ENV === "test"
  ? Math.max(
      100,
      Math.min(
        45 * 60_000,
        Number(process.env.TEAMMATE_LOCAL_AGENT_CAPABILITY_TTL_MS) || 45 * 60_000,
      ),
    )
  : 45 * 60_000;
interface ActiveAgentCapabilities {
  current: { id: string; expiresAt: number };
  previous?: { id: string; expiresAt: number };
}

const port = Number(process.env.TEAMMATE_LOCAL_PORT || 8787);
const configuredDbPath = process.env.TEAMMATE_LOCAL_DB;
const teammateDataDir = resolve(".teammate");
// Keep the former data directory readable so existing installations migrate in place.
const legacyDataDir = resolve(".zano");
if (!configuredDbPath && !existsSync(teammateDataDir) && existsSync(legacyDataDir)) {
  renameSync(legacyDataDir, teammateDataDir);
}
const dbPath = resolve(configuredDbPath || ".teammate/local.db");
ensurePrivateDirectory(dirname(dbPath));
const avatarsDir = join(dirname(dbPath), "avatars");
ensurePrivateDirectory(avatarsDir);
const credentialStorePath = join(dirname(dbPath), "credentials.enc");
restrictPrivateFile(credentialStorePath);
const credentialStore = new EncryptedCredentialStore(
  credentialStorePath,
);
const chatGptRefreshCoordinator = new CodexOAuthRefreshCoordinator();

restrictSqliteFiles(dbPath);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
restrictSqliteFiles(dbPath);

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
    "runtime",
    "model",
    "thinking_level",
    "status",
    "owner_id",
    "server_id",
    "workspace_path",
    "session_id",
    "runtime_session_id",
    "runtime_session_runtime",
    "connection_id",
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
  message_deliveries: [
    "message_id",
    "agent_id",
    "server_id",
    "channel_id",
    "status",
    "attempts",
    "claim_token",
    "claimed_by",
    "lease_expires_at",
    "next_attempt_at",
    "last_error",
    "completed_at",
    "created_at",
    "updated_at",
  ],
  tasks: [
    "id",
    "message_id",
    "channel_id",
    "task_number",
    "title",
    "description",
    "status",
    "parent_task_id",
    "assignee_id",
    "assignee_type",
    "archived_at",
    "created_at",
    "updated_at",
  ],
  documents: [
    "id",
    "server_id",
    "title",
    "content",
    "created_by",
    "generated_by_agent_id",
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

interface QueryExecutionResult {
  data: DbRow | DbRow[] | null;
  error: null;
  count: number | null;
}

class LocalRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "LocalRequestError";
  }
}

interface LocalHumanPrincipal {
  kind: "human";
  humanId: string;
  serverId: string;
}

interface LocalAgentPrincipal {
  kind: "agent";
  agentId: string;
  ownerId: string;
  serverId: string;
  capabilityId: string;
  expiresAt: number;
}

type LocalPrincipal = LocalHumanPrincipal | LocalAgentPrincipal;

interface LocalAgentCapabilityClaims {
  version: 1;
  kind: "agent";
  agent_id: string;
  server_id: string;
  issued_at: number;
  expires_at: number;
  capability_id: string;
}

function equalSecret(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function signLocalCapability(encodedClaims: string) {
  return createHmac("sha256", localCapabilitySigningKey)
    .update(encodedClaims)
    .digest("base64url");
}

function readActiveAgentCapabilities(
  agentId: string,
  serverId: string,
  now = Date.now(),
): ActiveAgentCapabilities | undefined {
  const row = db.prepare(
    `SELECT current_id, current_expires_at, previous_id, previous_expires_at
       FROM local_agent_capabilities
      WHERE agent_id = ? AND server_id = ?`,
  ).get(agentId, serverId) as {
    current_id: string;
    current_expires_at: number;
    previous_id: string | null;
    previous_expires_at: number | null;
  } | undefined;
  if (!row) return undefined;

  const currentExpiresAt = Number(row.current_expires_at);
  if (!Number.isSafeInteger(currentExpiresAt) || currentExpiresAt <= now) {
    db.prepare("DELETE FROM local_agent_capabilities WHERE agent_id = ?").run(agentId);
    return undefined;
  }

  const previousExpiresAt = Number(row.previous_expires_at);
  const previous = row.previous_id &&
      Number.isSafeInteger(previousExpiresAt) &&
      previousExpiresAt > now
    ? { id: row.previous_id, expiresAt: previousExpiresAt }
    : undefined;
  if (row.previous_id && !previous) {
    db.prepare(
      `UPDATE local_agent_capabilities
          SET previous_id = NULL, previous_expires_at = NULL
        WHERE agent_id = ?`,
    ).run(agentId);
  }
  return {
    current: { id: row.current_id, expiresAt: currentExpiresAt },
    ...(previous ? { previous } : {}),
  };
}

function deleteAgentCapabilities(agentId: string) {
  db.prepare("DELETE FROM local_agent_capabilities WHERE agent_id = ?").run(agentId);
}

function mintLocalAgentCapability(agentId: string, serverId: string) {
  const now = Date.now();
  const capabilityId = randomUUID();
  const claims: LocalAgentCapabilityClaims = {
    version: 1,
    kind: "agent",
    agent_id: agentId,
    server_id: serverId,
    issued_at: now,
    expires_at: now + agentCapabilityTtlMs,
    capability_id: capabilityId,
  };
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const existing = readActiveAgentCapabilities(agentId, serverId, now);
  const previous = existing?.current.expiresAt && existing.current.expiresAt > now
    ? existing.current
    : undefined;
  db.prepare(
    `INSERT INTO local_agent_capabilities (
       agent_id, server_id, current_id, current_expires_at, previous_id, previous_expires_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       server_id = excluded.server_id,
       current_id = excluded.current_id,
       current_expires_at = excluded.current_expires_at,
       previous_id = excluded.previous_id,
       previous_expires_at = excluded.previous_expires_at`,
  ).run(
    agentId,
    serverId,
    capabilityId,
    claims.expires_at,
    previous?.id ?? null,
    previous?.expiresAt ?? null,
  );
  return `tm_local_agent_v1.${encodedClaims}.${signLocalCapability(encodedClaims)}`;
}

function readBearerCredential(request: IncomingMessage) {
  const authorization = request.headers.authorization;
  if (!authorization) return null;
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  return match?.[1] || null;
}

function authenticateLocalRequest(request: IncomingMessage): LocalPrincipal {
  const credential = readBearerCredential(request);
  if (!credential) throw new LocalRequestError(401, "Local authorization is required");
  if (equalSecret(credential, localControllerCredential)) {
    return { kind: "human", humanId: LOCAL_USER_ID, serverId: LOCAL_SERVER_ID };
  }

  const [prefix, encodedClaims, signature, extra] = credential.split(".");
  if (prefix !== "tm_local_agent_v1" || !encodedClaims || !signature || extra) {
    throw new LocalRequestError(401, "Invalid local capability");
  }
  const expectedSignature = signLocalCapability(encodedClaims);
  if (!equalSecret(signature, expectedSignature)) {
    throw new LocalRequestError(401, "Invalid local capability");
  }

  let claims: LocalAgentCapabilityClaims;
  try {
    claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")) as LocalAgentCapabilityClaims;
  } catch {
    throw new LocalRequestError(401, "Invalid local capability");
  }
  const now = Date.now();
  if (
    claims.version !== 1 ||
    claims.kind !== "agent" ||
    !UUID_PATTERN.test(claims.agent_id) ||
    !UUID_PATTERN.test(claims.server_id) ||
    !UUID_PATTERN.test(claims.capability_id) ||
    !Number.isSafeInteger(claims.issued_at) ||
    !Number.isSafeInteger(claims.expires_at) ||
    claims.issued_at > now + 5_000 ||
    claims.expires_at <= now ||
    claims.expires_at - claims.issued_at > agentCapabilityTtlMs
  ) {
    throw new LocalRequestError(401, "Expired or retired local capability");
  }

  const activeCapabilities = readActiveAgentCapabilities(
    claims.agent_id,
    claims.server_id,
    now,
  );
  const liveCapability = [
    activeCapabilities?.current,
    activeCapabilities?.previous,
  ].some(
    (candidate) =>
      candidate?.id === claims.capability_id &&
      candidate.expiresAt === claims.expires_at &&
      candidate.expiresAt > now,
  );
  if (!liveCapability) {
    throw new LocalRequestError(401, "Expired or retired local capability");
  }

  const agent = db.prepare(
    `SELECT agent.owner_id
       FROM agents agent
       JOIN server_members membership
         ON membership.server_id = agent.server_id
        AND membership.member_id = agent.id
        AND membership.member_type = 'agent'
      WHERE agent.id = ? AND agent.server_id = ?`,
  ).get(claims.agent_id, claims.server_id) as { owner_id: string } | undefined;
  if (!agent) {
    deleteAgentCapabilities(claims.agent_id);
    throw new LocalRequestError(401, "Local capability has been revoked");
  }
  return {
    kind: "agent",
    agentId: claims.agent_id,
    ownerId: agent.owner_id,
    serverId: claims.server_id,
    capabilityId: claims.capability_id,
    expiresAt: claims.expires_at,
  };
}

function requireHumanPrincipal(principal: LocalPrincipal) {
  if (principal.kind !== "human") {
    throw new LocalRequestError(403, "This local operation requires the human controller");
  }
  return principal;
}

const QUERY_ACTIONS = new Set<QueryRequest["action"]>([
  "select",
  "insert",
  "update",
  "delete",
]);
const QUERY_FILTER_OPERATORS = new Set([
  "eq",
  "neq",
  "in",
  "is",
  "lt",
  "lte",
  "gt",
  "gte",
  "ilike",
  "or",
]);
const QUERY_REQUEST_KEYS = new Set([
  "table",
  "action",
  "filters",
  "values",
  "order",
  "limit",
  "count",
  "head",
  "single",
]);

function parseQueryRequest(value: unknown):
  | { query: QueryRequest }
  | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Query body must be an object" };
  }
  const candidate = value as Record<string, unknown>;
  const unknownKey = Object.keys(candidate).find((key) => !QUERY_REQUEST_KEYS.has(key));
  if (unknownKey) return { error: `Unknown query field: ${unknownKey}` };

  if (typeof candidate.table !== "string" || !candidate.table) {
    return { error: "Query table is required" };
  }
  if (!Object.prototype.hasOwnProperty.call(tableColumns, candidate.table)) {
    return { error: `Unknown query table: ${candidate.table}` };
  }
  const table = candidate.table as TableName;
  if (
    typeof candidate.action !== "string" ||
    !QUERY_ACTIONS.has(candidate.action as QueryRequest["action"])
  ) {
    return { error: "Unsupported query action" };
  }
  const action = candidate.action as QueryRequest["action"];
  if (candidate.filters !== undefined && !Array.isArray(candidate.filters)) {
    return { error: "Query filters must be an array" };
  }
  const parsedFilters = parseQueryFilters(table, candidate.filters || []);
  if ("error" in parsedFilters) return parsedFilters;
  const filters = parsedFilters.filters;

  if ((action === "update" || action === "delete") && filters.length === 0) {
    return { error: `${action} requires at least one filter` };
  }
  if (action === "insert" && filters.length > 0) {
    return { error: "insert does not accept filters" };
  }

  if (action === "insert" || action === "update") {
    const payloadError = validateMutationPayload(table, action, candidate.values);
    if (payloadError) return { error: payloadError };
  } else if (candidate.values !== undefined) {
    return { error: `${action} does not accept values` };
  }

  if (candidate.order !== undefined) {
    if (
      !candidate.order ||
      typeof candidate.order !== "object" ||
      Array.isArray(candidate.order)
    ) {
      return { error: "Query order must be an object" };
    }
    const order = candidate.order as Record<string, unknown>;
    if (
      Object.keys(order).some((key) => key !== "column" && key !== "ascending") ||
      typeof order.column !== "string" ||
      !(tableColumns[table] as readonly string[]).includes(order.column) ||
      typeof order.ascending !== "boolean"
    ) {
      return { error: "Query order requires a valid column and boolean ascending" };
    }
    if (action !== "select") return { error: `${action} does not accept order` };
  }
  if (
    candidate.limit !== undefined &&
    (!Number.isInteger(candidate.limit) || (candidate.limit as number) < 0 || (candidate.limit as number) > 1000)
  ) {
    return { error: "Query limit must be an integer between 0 and 1000" };
  }
  if (candidate.limit !== undefined && action !== "select") {
    return { error: `${action} does not accept limit` };
  }
  if (candidate.count !== undefined && candidate.count !== "exact") {
    return { error: "Unsupported query count mode" };
  }
  if (candidate.head !== undefined && typeof candidate.head !== "boolean") {
    return { error: "Query head must be a boolean" };
  }
  if (candidate.single !== undefined && typeof candidate.single !== "boolean") {
    return { error: "Query single must be a boolean" };
  }

  return {
    query: {
      table,
      action,
      filters,
      ...(candidate.values !== undefined ? { values: candidate.values } : {}),
      ...(candidate.order !== undefined
        ? { order: candidate.order as QueryRequest["order"] }
        : {}),
      ...(candidate.limit !== undefined ? { limit: candidate.limit as number } : {}),
      ...(candidate.count !== undefined ? { count: candidate.count as "exact" } : {}),
      ...(candidate.head !== undefined ? { head: candidate.head as boolean } : {}),
      ...(candidate.single !== undefined ? { single: candidate.single as boolean } : {}),
    },
  };
}

function parseQueryFilters(table: TableName, value: unknown[]):
  | { filters: QueryFilter[] }
  | { error: string } {
  const filters: QueryFilter[] = [];
  for (const [index, rawFilter] of value.entries()) {
    if (!rawFilter || typeof rawFilter !== "object" || Array.isArray(rawFilter)) {
      return { error: `Query filter ${index} must be an object` };
    }
    const filter = rawFilter as Record<string, unknown>;
    if (Object.keys(filter).some((key) => !["column", "operator", "value"].includes(key))) {
      return { error: `Query filter ${index} contains an unknown field` };
    }
    if (
      typeof filter.operator !== "string" ||
      !QUERY_FILTER_OPERATORS.has(filter.operator)
    ) {
      return { error: `Unsupported filter operator at index ${index}` };
    }
    if (!Object.prototype.hasOwnProperty.call(filter, "value")) {
      return { error: `Query filter ${index} requires a value` };
    }

    if (filter.operator === "or") {
      if (filter.column !== undefined || typeof filter.value !== "string" || !filter.value) {
        return { error: `Invalid OR filter at index ${index}` };
      }
      for (const alternative of filter.value.split(",")) {
        const separator = alternative.indexOf(".eq.");
        const column = separator > 0 ? alternative.slice(0, separator) : "";
        if (
          separator < 1 ||
          !(tableColumns[table] as readonly string[]).includes(column)
        ) {
          return { error: `Invalid OR filter at index ${index}` };
        }
      }
      filters.push({ operator: "or", value: filter.value });
      continue;
    }

    if (
      typeof filter.column !== "string" ||
      !(tableColumns[table] as readonly string[]).includes(filter.column)
    ) {
      return { error: `Invalid filter column at index ${index}` };
    }
    if (filter.operator === "in") {
      if (!Array.isArray(filter.value) || !filter.value.every(isQueryScalar)) {
        return { error: `IN filter ${index} requires an array of scalar values` };
      }
    } else if (filter.operator === "ilike") {
      if (typeof filter.value !== "string") {
        return { error: `ILIKE filter ${index} requires a string value` };
      }
    } else if (!isQueryScalar(filter.value)) {
      return { error: `Query filter ${index} requires a scalar value` };
    }
    filters.push({
      column: filter.column,
      operator: filter.operator,
      value: filter.value,
    });
  }
  return { filters };
}

function validateMutationPayload(
  table: TableName,
  action: "insert" | "update",
  value: unknown,
) {
  if (!value || typeof value !== "object") {
    return `${action} values must be an object${action === "insert" ? " or array of objects" : ""}`;
  }
  if (action === "update" && Array.isArray(value)) {
    return "update values must be an object";
  }
  const rows = Array.isArray(value) ? value : [value];
  if (rows.length === 0) return "insert values must not be empty";
  for (const [index, rawRow] of rows.entries()) {
    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
      return `${action} row ${index} must be an object`;
    }
    const row = rawRow as Record<string, unknown>;
    const columns = Object.keys(row);
    if (columns.length === 0) return `${action} values must not be empty`;
    for (const column of columns) {
      if (!(tableColumns[table] as readonly string[]).includes(column)) {
        return `Unknown column ${table}.${column}`;
      }
      if (!isQueryScalar(row[column])) {
        return `${action} value ${table}.${column} must be scalar`;
      }
    }
  }
  return null;
}

function isQueryScalar(value: unknown): value is SQLInputValue | boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

type AgentRuntime = "claude-code" | "codex" | "pi";
type ThinkingLevel = "low" | "medium" | "high";
type ConnectionProvider =
  | "openai-codex"
  | "openai-compatible"
  | "anthropic-compatible";

interface ConnectionRow {
  id: string;
  name: string;
  provider: ConnectionProvider;
  auth_type: "oauth" | "api-key";
  base_url: string | null;
  api_format: "openai-codex-responses" | "openai-completions" | "anthropic-messages";
  default_model: string;
  models_json: string;
  model_selection_mode: "automatically-synced" | "user-defined";
  models_refreshed_at: string | null;
  status: "connected" | "needs-auth" | "error";
  auth_error: string | null;
  created_at: string;
  updated_at: string;
}

interface PendingOAuthFlow {
  status: "starting" | "waiting" | "complete" | "error";
  authUrl?: string;
  error?: string;
  cancel?: () => void;
}

let pendingOAuthFlow: PendingOAuthFlow | null = null;
const eventWaiters = new Set<() => void>();
let emittedEventsSincePrune = 0;
let localServerStopping = false;
let databaseTransactionActive = false;
let transactionHasEvents = false;
type AtomicMutationScope = "server" | "agent" | "channel" | "task" | "membership" | "key";
let atomicMutationScope: AtomicMutationScope | null = null;
const serverDeletionIds = new Set<string>();
const agentDeletionIds = new Set<string>();
const channelDeletionIds = new Set<string>();
const messageDeletionIds = new Set<string>();

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;
const workspaceTextDecoder = new TextDecoder("utf-8", { fatal: true });
const AVATAR_MIME_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;

function isGeneratedAvatarUrl(value: string) {
  return /^generated:[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
}

function avatarFilePath(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/api/avatars/")) {
    return null;
  }
  const pathname = value.split("?", 1)[0];
  const match = pathname.match(
    /^\/api\/avatars\/([a-f0-9-]{36}\.(?:png|jpg|webp))$/i,
  );
  return match ? join(avatarsDir, match[1]) : null;
}

function normalizeAvatarUrl(value: unknown, agentId: string) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2048) return undefined;
  if (isGeneratedAvatarUrl(value) || /^https:\/\/[^\s]+$/i.test(value)) {
    return value;
  }
  const pathname = value.split("?", 1)[0];
  if (
    new RegExp(
      `^/api/avatars/${agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(?:png|jpg|webp)$`,
      "i",
    ).test(pathname)
  ) {
    return value;
  }
  return undefined;
}

function avatarBytesMatchMime(bytes: Buffer, mime: keyof typeof AVATAR_MIME_TYPES) {
  if (mime === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mime === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

async function persistAgentAvatar(agentId: string, dataUrl: unknown) {
  if (typeof dataUrl !== "string") throw new Error("Invalid avatar image");
  const match = dataUrl.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=\r\n]+)$/,
  );
  if (!match) throw new Error("Avatar must be a PNG, JPEG, or WebP image");

  const mime = match[1] as keyof typeof AVATAR_MIME_TYPES;
  const bytes = Buffer.from(match[2].replace(/[\r\n]/g, ""), "base64");
  if (!bytes.length || bytes.length > MAX_AVATAR_BYTES) {
    throw new Error("Avatar must be 2 MB or smaller");
  }
  if (!avatarBytesMatchMime(bytes, mime)) {
    throw new Error("Avatar file content does not match its image type");
  }

  const extension = AVATAR_MIME_TYPES[mime];
  const filename = `${agentId}.${extension}`;
  const finalPath = join(avatarsDir, filename);
  const temporaryPath = join(avatarsDir, `${agentId}-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, bytes, { mode: 0o600 });
  await rename(temporaryPath, finalPath);

  for (const candidateExtension of Object.values(AVATAR_MIME_TYPES)) {
    if (candidateExtension === extension) continue;
    await unlink(join(avatarsDir, `${agentId}.${candidateExtension}`)).catch(() => undefined);
  }

  return `/api/avatars/${filename}?v=${Date.now()}`;
}

async function removeAgentAvatarFile(value: unknown) {
  const filePath = avatarFilePath(value);
  if (filePath) await unlink(filePath).catch(() => undefined);
}

function isAgentRuntime(value: unknown): value is AgentRuntime {
  return value === "claude-code" || value === "codex" || value === "pi";
}

function normalizeRuntime(value: unknown): AgentRuntime {
  return isAgentRuntime(value) ? value : "codex";
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "low" || value === "medium" || value === "high";
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  return isThinkingLevel(value) ? value : "medium";
}

function isValidModel(runtime: AgentRuntime, value: unknown) {
  if (typeof value !== "string") return false;
  const model = value.trim();
  if (runtime === "claude-code") {
    return ["opus", "sonnet", "haiku"].includes(model);
  }
  if (runtime === "codex") {
    return [
      "default",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.3-codex",
    ].includes(model);
  }
  return (
    model === "default" ||
    (model.length > 0 &&
      model.length <= 120 &&
      /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model))
  );
}

function normalizeModel(runtime: AgentRuntime, value: unknown) {
  return isValidModel(runtime, value)
    ? String(value).trim()
    : runtime === "codex"
      ? "default"
      : runtime === "pi"
        ? "default"
        : "sonnet";
}

function ensureColumn(table: "agents" | "tasks" | "documents", column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function resolveExecutable(command: "claude" | "codex") {
  const override = command === "claude"
    ? process.env.TEAMMATE_CLAUDE_PATH
    : process.env.TEAMMATE_CODEX_PATH;
  const candidates = [
    override,
    ...(process.env.PATH || "")
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => join(entry, command)),
    command === "claude" ? join(homedir(), ".local", "bin", command) : undefined,
    join("/opt/homebrew/bin", command),
    join("/usr/local/bin", command),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) || null;
}

function listAgentRuntimes() {
  return ([
    {
      id: "claude-code",
      name: "Claude Code",
      defaultModel: "sonnet",
      executable: resolveExecutable("claude"),
    },
    {
      id: "codex",
      name: "Codex",
      defaultModel: "default",
      executable: resolveExecutable("codex"),
    },
    {
      id: "pi",
      name: "Pi / Custom API",
      defaultModel: "default",
      executable: "embedded",
    },
  ] as const).map((runtime) => ({
    ...runtime,
    installed: Boolean(runtime.executable),
  }));
}

function isInstalledAgentRuntime(runtime: AgentRuntime) {
  return listAgentRuntimes().some((candidate) => (
    candidate.id === runtime && candidate.installed
  ));
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
    runtime TEXT NOT NULL DEFAULT 'codex',
    model TEXT NOT NULL DEFAULT 'default',
    thinking_level TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'offline',
    owner_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    workspace_path TEXT,
    session_id TEXT,
    runtime_session_id TEXT,
    runtime_session_runtime TEXT,
    connection_id TEXT,
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

  CREATE TABLE IF NOT EXISTS message_deliveries (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'processing', 'completed', 'skipped', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    claim_token TEXT,
    claimed_by TEXT,
    lease_expires_at TEXT,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (message_id, agent_id)
  );
  CREATE INDEX IF NOT EXISTS idx_local_message_deliveries_ready
    ON message_deliveries(server_id, status, next_attempt_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_local_message_deliveries_expired
    ON message_deliveries(server_id, status, lease_expires_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_local_message_deliveries_agent
    ON message_deliveries(agent_id, status, created_at);

  DROP TRIGGER IF EXISTS trg_local_enqueue_human_message_deliveries;
  CREATE TRIGGER IF NOT EXISTS trg_local_enqueue_message_deliveries
  AFTER INSERT ON messages
  WHEN NEW.sender_type IN ('human', 'agent')
  BEGIN
    INSERT OR IGNORE INTO message_deliveries (
      message_id,
      agent_id,
      server_id,
      channel_id,
      status,
      attempts,
      next_attempt_at,
      created_at,
      updated_at
    )
    SELECT
      NEW.id,
      agent.id,
      channel.server_id,
      NEW.channel_id,
      'pending',
      0,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM channel_members member
    JOIN agents agent
      ON agent.id = member.member_id
     AND member.member_type = 'agent'
    JOIN channels channel
      ON channel.id = NEW.channel_id
     AND channel.server_id = agent.server_id
    WHERE member.channel_id = NEW.channel_id
      AND agent.id <> NEW.sender_id;
  END;

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL UNIQUE,
    channel_id TEXT NOT NULL,
    task_number INTEGER NOT NULL UNIQUE,
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 500),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 100000),
    status TEXT NOT NULL DEFAULT 'todo',
    parent_task_id TEXT,
    assignee_id TEXT,
    assignee_type TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    generated_by_agent_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_local_documents_server_updated
    ON documents(server_id, updated_at DESC);

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

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS local_agent_capabilities (
    agent_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    current_id TEXT NOT NULL,
    current_expires_at INTEGER NOT NULL,
    previous_id TEXT,
    previous_expires_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS llm_connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    auth_type TEXT NOT NULL,
    base_url TEXT,
    api_format TEXT NOT NULL,
    default_model TEXT NOT NULL,
    models_json TEXT NOT NULL DEFAULT '[]',
    model_selection_mode TEXT NOT NULL DEFAULT 'user-defined',
    models_refreshed_at TEXT,
    status TEXT NOT NULL DEFAULT 'needs-auth',
    auth_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// Older databases could contain duplicate per-channel sequence values from the
// former max(seq)+1 implementation. Repair only affected channels before adding
// the invariant, so an upgrade cannot fail during service startup.
const duplicateMessageSequence = db.prepare(
  `SELECT 1
     FROM messages
    GROUP BY channel_id, seq
   HAVING count(*) > 1
    LIMIT 1`,
).get();
if (duplicateMessageSequence) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      WITH duplicate_channels AS (
        SELECT channel_id
          FROM messages
         GROUP BY channel_id, seq
        HAVING count(*) > 1
      ), ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY channel_id
                 ORDER BY created_at ASC, id ASC
               ) AS next_seq
          FROM messages
         WHERE channel_id IN (SELECT channel_id FROM duplicate_channels)
      )
      UPDATE messages
         SET seq = (SELECT next_seq FROM ranked WHERE ranked.id = messages.id)
       WHERE id IN (SELECT id FROM ranked)
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_local_messages_channel_seq_unique
    ON messages(channel_id, seq)
`);
db.prepare(
  "DELETE FROM local_events WHERE id <= (SELECT max(id) - 5000 FROM local_events)",
).run();
db.prepare(
  "DELETE FROM local_agent_capabilities WHERE current_expires_at <= ?",
).run(Date.now());

ensureColumn("agents", "runtime", "TEXT NOT NULL DEFAULT 'codex'");
ensureColumn("agents", "thinking_level", "TEXT NOT NULL DEFAULT 'medium'");
ensureColumn("agents", "runtime_session_id", "TEXT");
ensureColumn("agents", "runtime_session_runtime", "TEXT");
ensureColumn("agents", "connection_id", "TEXT");
ensureColumn("tasks", "parent_task_id", "TEXT");
ensureColumn("tasks", "title", "TEXT");
ensureColumn("tasks", "description", "TEXT");
ensureColumn("tasks", "archived_at", "TEXT");
ensureColumn("documents", "generated_by_agent_id", "TEXT");
const llmConnectionColumns = db.prepare("PRAGMA table_info(llm_connections)").all() as Array<{
  name: string;
}>;
if (!llmConnectionColumns.some((column) => column.name === "models_json")) {
  db.exec("ALTER TABLE llm_connections ADD COLUMN models_json TEXT NOT NULL DEFAULT '[]'");
}
for (const [column, definition] of [
  ["model_selection_mode", "TEXT NOT NULL DEFAULT 'user-defined'"],
  ["models_refreshed_at", "TEXT"],
  ["status", "TEXT NOT NULL DEFAULT 'needs-auth'"],
  ["auth_error", "TEXT"],
] as const) {
  if (!llmConnectionColumns.some((candidate) => candidate.name === column)) {
    db.exec(`ALTER TABLE llm_connections ADD COLUMN ${column} ${definition}`);
  }
}

// Older local databases used the task message as the display title. Materialize
// that value once so task edits never rewrite the original chat message.
const legacyTaskTitles = db.prepare(
  `SELECT task.id, task.title, message.content
     FROM tasks task
     LEFT JOIN messages message ON message.id = task.message_id
    WHERE task.title IS NULL
       OR trim(task.title) = ''
       OR length(task.title) > 500`,
).all() as Array<{ id: string; title: string | null; content: string | null }>;
const updateLegacyTaskTitle = db.prepare("UPDATE tasks SET title = ? WHERE id = ?");
for (const task of legacyTaskTitles) {
  const existing = task.title?.trim();
  const firstMessageLine = task.content
    ?.replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  updateLegacyTaskTitle.run(
    truncateTaskText(existing || firstMessageLine || "Untitled task", 500),
    task.id,
  );
}
const legacyTaskDescriptions = db.prepare(
  "SELECT id, description FROM tasks WHERE description IS NULL OR length(description) > 100000",
).all() as Array<{ id: string; description: string | null }>;
const updateLegacyTaskDescription = db.prepare("UPDATE tasks SET description = ? WHERE id = ?");
for (const task of legacyTaskDescriptions) {
  updateLegacyTaskDescription.run(
    truncateTaskText(task.description || "", 100_000),
    task.id,
  );
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_local_tasks_channel_active
    ON tasks(channel_id, status, task_number)
    WHERE archived_at IS NULL
`);

seedDatabase();
restrictSqliteFiles(dbPath);

const server = createServer((request, response) => {
  void dispatchLocalRequest(request, response).catch((error) => {
    handleLocalRequestError(response, error);
  });
});
server.requestTimeout = LOCAL_REQUEST_TIMEOUT_MS;
server.headersTimeout = LOCAL_REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = 5_000;

async function dispatchLocalRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (!isAllowedLocalOrigin(request.headers.origin)) {
    return sendJson(response, 403, { error: "Origin is not allowed" });
  }
  setCors(request, response);

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
      });
    }

    const avatarRoute = url.pathname.match(
      /^\/api\/avatars\/([a-f0-9-]{36}\.(?:png|jpg|webp))$/i,
    );
    if (request.method === "GET" && avatarRoute) {
      requireHumanPrincipal(authenticateLocalRequest(request));
      const filePath = join(avatarsDir, avatarRoute[1]);
      try {
        const content = await readFile(filePath);
        const extension = avatarRoute[1].split(".").pop()?.toLowerCase();
        const contentType = extension === "png"
          ? "image/png"
          : extension === "jpg"
            ? "image/jpeg"
            : "image/webp";
        response.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(content);
      } catch {
        sendJson(response, 404, { error: "Avatar not found" });
      }
      return;
    }

    const principal = authenticateLocalRequest(request);

    if (request.method === "GET" && url.pathname === "/api/ready") {
      requireHumanPrincipal(principal);
      return sendJson(response, 200, {
        ok: true,
        mode: "local",
        protocolVersion: 2,
      });
    }

    if (url.pathname === "/api/settings") {
      requireHumanPrincipal(principal);
      return handleSettingsRequest(request, response);
    }

    if (url.pathname === "/api/profile") {
      requireHumanPrincipal(principal);
      return handleProfileRequest(request, response);
    }

    if (url.pathname === "/api/servers") {
      requireHumanPrincipal(principal);
      return await handleServersRequest(request, response);
    }

    if (request.method === "GET" && url.pathname === "/api/runtimes") {
      requireHumanPrincipal(principal);
      return sendJson(response, 200, { runtimes: listAgentRuntimes() });
    }

    if (url.pathname === "/api/connections") {
      requireHumanPrincipal(principal);
      return handleConnectionsRequest(request, response);
    }

    const connectionRoute = url.pathname.match(
      /^\/api\/connections\/([^/]+)(?:\/(runtime|models|refresh|test))?$/,
    );
    if (connectionRoute) {
      requireHumanPrincipal(principal);
      return handleConnectionRequest(
        request,
        response,
        connectionRoute[1],
        connectionRoute[2],
      );
    }

    const oauthRoute = url.pathname.match(
      /^\/api\/oauth\/chatgpt\/(start|status|cancel)$/,
    );
    if (oauthRoute) {
      requireHumanPrincipal(principal);
      return handleChatGptOAuthRequest(request, response, oauthRoute[1]);
    }

    if (url.pathname === "/api/agents") {
      requireHumanPrincipal(principal);
      return handleAgentsRequest(request, response);
    }

    const agentRoute = url.pathname.match(/^\/api\/agents\/([^/]+)(?:\/(reset|workspace))?$/);
    if (agentRoute) {
      requireHumanPrincipal(principal);
      return handleAgentRequest(request, response, url, agentRoute[1], agentRoute[2]);
    }

    if (request.method === "GET" && url.pathname === "/api/skills") {
      requireHumanPrincipal(principal);
      return sendJson(
        response,
        200,
        await listLocalSkills(normalizeRuntime(url.searchParams.get("runtime"))),
      );
    }

    const rpcRoute = url.pathname.match(/^\/api\/rpc\/([a-z][a-z0-9_]*)$/);
    if (request.method === "POST" && rpcRoute) {
      return await handleRpcRequest(request, response, rpcRoute[1], principal);
    }

    if (request.method === "POST" && url.pathname === "/api/query") {
      const parsed = parseQueryRequest(await readJson(request));
      if ("error" in parsed) {
        return sendJson(response, 400, {
          data: null,
          error: { message: parsed.error },
          count: null,
        });
      }
      return sendJson(response, 200, executeQuery(authorizeLocalQuery(principal, parsed.query)));
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      requireHumanPrincipal(principal);
      const waitMs = Math.min(25_000, Math.max(0, Number(url.searchParams.get("wait")) || 0));
      return sendJson(
        response,
        200,
        await getEventsWithWait(url.searchParams.get("after"), waitMs),
      );
    }

    if (request.method === "POST" && url.pathname === "/api/broadcast") {
      requireHumanPrincipal(principal);
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
      requireHumanPrincipal(principal);
      const body = (await readJson(request)) as { hostname?: string };

      const now = new Date().toISOString();
      db.prepare("UPDATE machine_keys SET last_used_at = ?, name = ? WHERE id = ?").run(
        now,
        body.hostname || "Local machine",
        LOCAL_KEY_ID
      );
      const key = db.prepare("SELECT * FROM machine_keys WHERE id = ?").get(LOCAL_KEY_ID) as DbRow;
      emitDatabaseEvent("UPDATE", "machine_keys", key);

      const agents = db
        .prepare("SELECT id, name, display_name, description, runtime, model, connection_id, status FROM agents WHERE owner_id = ? AND server_id = ? ORDER BY created_at")
        .all(LOCAL_USER_ID, LOCAL_SERVER_ID);
      const agentTokens = Object.fromEntries(
        agents.map((agent) => {
          const agentId = String((agent as DbRow).id);
          return [agentId, mintLocalAgentCapability(agentId, LOCAL_SERVER_ID)];
        }),
      );

      const localServerUrl = `http://${request.headers.host || `127.0.0.1:${port}`}`;
      return sendJson(response, 200, {
        protocolVersion: 2,
        localMode: true,
        localServerUrl,
        supabaseUrl: localServerUrl,
        supabaseAnonKey: "local",
        token: localControllerCredential,
        agentTokens,
        userId: LOCAL_USER_ID,
        serverId: LOCAL_SERVER_ID,
        serverName: "Local Workspace",
        agents,
      });
    }

    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    return handleLocalRequestError(response, error);
  }
}

function handleLocalRequestError(response: ServerResponse, error: unknown) {
  const statusCode = error instanceof LocalRequestError ? error.statusCode : 500;
  if (statusCode >= 500) console.error("Local service request failed:", error);
  if (response.writableEnded || response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  return sendJson(response, statusCode, {
    data: null,
    error: {
      message: error instanceof Error ? error.message : "Unknown local service error",
    },
    count: null,
  });
}

server.once("error", (error) => {
  console.error(`Teammate local service could not listen on 127.0.0.1:${port}:`, error);
  db.close();
  process.exit(1);
});
void reconcileAutoSyncedConnectionsAtStartup()
  .catch((error) => {
    console.error("Could not reconcile managed model catalogs during startup:", error);
  })
  .finally(() => {
    server.listen(port, "127.0.0.1", () => {
      console.log(`Teammate local service ready at http://127.0.0.1:${port}`);
      console.log(`SQLite database: ${dbPath}`);
      console.log("Local agent runtime authentication enabled.");
    });
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    localServerStopping = true;
    for (const wake of [...eventWaiters]) wake();
    if (process.env.TEAMMATE_EMBEDDED_SIDECAR === "1") {
      db.prepare("UPDATE agents SET status = 'offline' WHERE status <> 'offline'").run();
    }
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

function seedDatabase() {
  const now = new Date().toISOString();
  const insertSetting = db.prepare(
    "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
  );
  insertSetting.run("language", "zh-CN", now);
  insertSetting.run("theme", "system", now);
  insertSetting.run("default_runtime", "codex", now);
  insertSetting.run("default_model", "default", now);
  insertSetting.run("default_connection_id", "", now);
  insertSetting.run("default_thinking_level", "medium", now);
  insertSetting.run("message_sounds", "true", now);

  const insertProfile = db.prepare(
    "INSERT OR IGNORE INTO profiles (id, email, display_name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  insertProfile.run(LOCAL_USER_ID, "local@teammate.dev", "Local User", null, now);
  // Preserve profiles created before the Teammate rename while updating visible metadata.
  db.prepare("UPDATE profiles SET email = ? WHERE id = ? AND email = ?")
    .run("local@teammate.dev", LOCAL_USER_ID, "local@zano.dev");

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
  // Rewrite the former product name only in the deterministic seeded agent record.
  db.prepare(
    "INSERT OR IGNORE INTO server_members (server_id, member_id, member_type, role, joined_at) VALUES (?, ?, ?, ?, ?)"
  ).run(LOCAL_SERVER_ID, LOCAL_USER_ID, "human", "owner", now);

  db.prepare(
    `INSERT OR IGNORE INTO agents
      (id, name, display_name, description, system_prompt, runtime, model, status, owner_id, server_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    LOCAL_AGENT_ID,
    "local-assistant",
    "Local Assistant",
    "A local AI teammate running through the Teammate agent runtime.",
    "You are the local Teammate assistant. Reply in the user's language and help with work on this machine.",
    "codex",
    "default",
    "offline",
    LOCAL_USER_ID,
    LOCAL_SERVER_ID,
    now
  );
  db.prepare(
    `UPDATE agents SET
       runtime = CASE
         WHEN description = 'A Claude Code agent running entirely through the local Teammate service.'
          AND runtime = 'claude-code' AND model = 'sonnet' THEN 'codex'
         ELSE runtime
       END,
       model = CASE
         WHEN description = 'A Claude Code agent running entirely through the local Teammate service.'
          AND runtime = 'claude-code' AND model = 'sonnet' THEN 'default'
         ELSE model
       END,
       description = CASE
         WHEN description = 'A Claude Code agent running entirely through the local Teammate service.'
           THEN 'A local AI teammate running through the Teammate agent runtime.'
         WHEN description LIKE '%Zano%' THEN replace(description, 'Zano', 'Teammate')
         ELSE description
       END,
       system_prompt = CASE
         WHEN system_prompt LIKE '%Zano%' THEN replace(system_prompt, 'Zano', 'Teammate')
         ELSE system_prompt
       END
     WHERE id = ?`,
  ).run(LOCAL_AGENT_ID);

  db.prepare(
    "INSERT OR IGNORE INTO server_members (server_id, member_id, member_type, role, joined_at) VALUES (?, ?, ?, ?, ?)"
  ).run(LOCAL_SERVER_ID, LOCAL_AGENT_ID, "agent", "member", now);

  db.prepare(
    "INSERT OR IGNORE INTO channels (id, name, description, type, created_by, server_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    LOCAL_DM_ID,
    "Local Assistant",
    "Direct chat with the local Teammate agent",
    "dm",
    LOCAL_USER_ID,
    LOCAL_SERVER_ID,
    now
  );
  db.prepare(
    "UPDATE channels SET description = ? WHERE id = ? AND description = ?",
  ).run(
    "Direct chat with the local Teammate agent",
    LOCAL_DM_ID,
    "Direct chat with the local Claude Code agent",
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
    LOCAL_KEY_PREFIX,
    createHash("sha256").update(localControllerCredential).digest("hex"),
    null,
    LOCAL_USER_ID,
    LOCAL_SERVER_ID,
    "Local machine",
    now,
    null
  );
  db.prepare(
    `UPDATE machine_keys SET key_prefix = ?, key_hash = ?, key_value = ? WHERE id = ?`,
  ).run(
    LOCAL_KEY_PREFIX,
    createHash("sha256").update(localControllerCredential).digest("hex"),
    null,
    LOCAL_KEY_ID,
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
      "你好，我是 Local Assistant。这里的消息保存在本机 SQLite；Teammate 的本地智能体运行时启动后，我就可以在这里回复你。",
      1,
      null,
      now,
      now
    );
  }
  db.prepare(
    "UPDATE messages SET content = ?, updated_at = ? WHERE channel_id = ? AND sender_id = ? AND content = ?",
  ).run(
    "你好，我是 Local Assistant。这里的消息保存在本机 SQLite；Teammate 的本地智能体运行时启动后，我就可以在这里回复你。",
    now,
    LOCAL_DM_ID,
    LOCAL_AGENT_ID,
    "你好，我是 Local Assistant。这里的消息保存在本机 SQLite，启动 Bridge 后我会通过 Claude Code 真正回复你。",
  );
}

function readConnections() {
  return db
    .prepare("SELECT * FROM llm_connections ORDER BY created_at")
    .all() as unknown as ConnectionRow[];
}

const CHATGPT_OAUTH_UNAVAILABLE_MODELS = new Set(["gpt-5.3-codex"]);
const MODEL_PROVIDER_DESCRIPTORS = [
  {
    id: "openai-codex",
    name: "ChatGPT Plus / Pro",
    kind: "managed-oauth",
    authTypes: ["oauth"],
    modelCatalog: "sdk",
  },
  {
    id: "openai-compatible",
    name: "OpenAI compatible",
    kind: "compatible-api",
    authTypes: ["api-key"],
    modelCatalog: "user-defined",
  },
  {
    id: "anthropic-compatible",
    name: "Anthropic compatible",
    kind: "compatible-api",
    authTypes: ["api-key"],
    modelCatalog: "user-defined",
  },
] as const;
// Mirrors Craft Agent's evidence-based preference order. The first entry that
// exists in the pinned Pi SDK catalog becomes the fallback default.
const CHATGPT_OAUTH_PREFERRED_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "o4-mini",
  "o3",
  "gpt-4o",
] as const;

interface LocalModelDefinition {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<"text" | "image">;
  supportsImages?: boolean;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

function normalizeStoredModel(value: unknown): LocalModelDefinition | null {
  if (typeof value === "string") {
    const id = normalizeConnectionModel(value);
    return id ? { id, name: id } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = normalizeConnectionModel(record.id);
  if (!id) return null;
  return {
    id,
    name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : id,
    ...(typeof record.reasoning === "boolean" ? { reasoning: record.reasoning } : {}),
    ...(typeof record.contextWindow === "number" && Number.isFinite(record.contextWindow)
      ? { contextWindow: record.contextWindow }
      : {}),
    ...(typeof record.maxTokens === "number" && Number.isFinite(record.maxTokens)
      ? { maxTokens: record.maxTokens }
      : {}),
    ...(Array.isArray(record.input)
      ? { input: record.input.filter((item): item is "text" | "image" => item === "text" || item === "image") }
      : {}),
    ...(typeof record.supportsImages === "boolean" ? { supportsImages: record.supportsImages } : {}),
    ...(record.cost && typeof record.cost === "object" && !Array.isArray(record.cost)
      ? { cost: record.cost as LocalModelDefinition["cost"] }
      : {}),
  };
}

function storedConnectionModels(connection: ConnectionRow) {
  try {
    const parsed = JSON.parse(connection.models_json) as unknown;
    if (!Array.isArray(parsed)) return [];
    const unique = new Map<string, LocalModelDefinition>();
    for (const value of parsed) {
      const model = normalizeStoredModel(value);
      if (model) unique.set(model.id, model);
    }
    return Array.from(unique.values());
  } catch {
    return [];
  }
}

function sdkModelsForConnection(connection: ConnectionRow) {
  if (connection.provider !== "openai-codex") return storedConnectionModels(connection);
  return CHATGPT_MODEL_CATALOG
    .filter((model) => !CHATGPT_OAUTH_UNAVAILABLE_MODELS.has(model.id))
    .map((model) => ({
      id: model.id,
      name: model.name || model.id,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: [...model.input],
      supportsImages: model.input.includes("image"),
      cost: { ...model.cost },
    }));
}

function refreshConnectionModels(connection: ConnectionRow, forceTimestamp = false) {
  if (connection.model_selection_mode !== "automatically-synced") return connection;
  const discovered = sdkModelsForConnection(connection);
  const persisted = storedConnectionModels(connection);
  const models = discovered.length > 0
    ? discovered
    : persisted.length > 0
      ? persisted
      : normalizeConnectionModel(connection.default_model)
        ? [{ id: connection.default_model, name: connection.default_model }]
        : [];
  const modelIds = models.map((model) => model.id);
  const defaultModel = modelIds.includes(connection.default_model)
    ? connection.default_model
    : CHATGPT_OAUTH_PREFERRED_MODELS.find((candidate) => modelIds.includes(candidate)) || modelIds[0] || "";
  if (
    defaultModel &&
    (forceTimestamp || defaultModel !== connection.default_model || JSON.stringify(models) !== connection.models_json)
  ) {
    return runDatabaseTransaction(() => {
      const updatedAt = new Date().toISOString();
      const modelsJson = JSON.stringify(models);
      db.prepare(
        `UPDATE llm_connections
            SET default_model = ?, models_json = ?, models_refreshed_at = ?,
                model_selection_mode = 'automatically-synced', status = 'connected',
                auth_error = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(defaultModel, modelsJson, updatedAt, updatedAt, connection.id);

      const dependentAgents = db.prepare(
        "SELECT * FROM agents WHERE connection_id = ?",
      ).all(connection.id) as DbRow[];
      for (const agent of dependentAgents) {
        if (modelIds.includes(String(agent.model || ""))) continue;
        queryData({
          table: "agents",
          action: "update",
          values: {
            model: defaultModel,
            session_id: null,
            runtime_session_id: null,
            runtime_session_runtime: null,
          },
          filters: [{ column: "id", operator: "eq", value: agent.id }],
        });
      }

      const appSettings = readAppSettings();
      if (
        appSettings.defaultConnectionId === connection.id &&
        !modelIds.includes(appSettings.defaultModel)
      ) {
        const upsertSetting = db.prepare(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        );
        upsertSetting.run("default_runtime", "pi", updatedAt);
        upsertSetting.run("default_model", defaultModel, updatedAt);
      }

      return {
        ...connection,
        default_model: defaultModel,
        models_json: modelsJson,
        models_refreshed_at: updatedAt,
        model_selection_mode: "automatically-synced" as const,
        status: "connected" as const,
        auth_error: null,
        updated_at: updatedAt,
      };
    });
  }
  return connection;
}

async function resolveLocalAgentRuntimeSelection(input: {
  runtime: unknown;
  model?: unknown;
  connectionId?: unknown;
}) {
  if (!isAgentRuntime(input.runtime)) {
    return { error: "Unsupported agent runtime" } as const;
  }
  const runtime = input.runtime;
  if (!isInstalledAgentRuntime(runtime)) {
    return { error: "The selected agent runtime is not installed on this device" } as const;
  }
  if (runtime !== "pi") {
    const model = input.model === undefined
      ? normalizeModel(runtime, undefined)
      : typeof input.model === "string"
        ? input.model.trim()
        : "";
    if (!isValidModel(runtime, model)) {
      return { error: "This model is not supported by the selected runtime" } as const;
    }
    return { selection: { runtime, model, connectionId: null } } as const;
  }

  const connectionId = typeof input.connectionId === "string" ? input.connectionId : "";
  const connection = connectionId
    ? db.prepare("SELECT * FROM llm_connections WHERE id = ?").get(connectionId) as
      | ConnectionRow
      | undefined
    : undefined;
  if (!connection) {
    return { error: "Choose an authenticated model connection" } as const;
  }
  const credentialResult = await credentialStore.getResult(connection.id);
  if (
    credentialResult.issue ||
    !connectionCredentialIsUsable(connection, credentialResult.credential) ||
    connection.status !== "connected"
  ) {
    return { error: "This model connection is not ready" } as const;
  }
  const models = storedConnectionModels(connection).map((model) => model.id);
  if (models.length === 0) {
    return { error: "Refresh this connection before choosing a model" } as const;
  }
  const model = input.model === undefined
    ? connection.default_model
    : typeof input.model === "string"
      ? input.model.trim()
      : "";
  if (!models.includes(model)) {
    return { error: "This model is no longer available for the selected connection" } as const;
  }
  return { selection: { runtime, model, connectionId: connection.id } } as const;
}

function connectionCredentialIsUsable(
  connection: ConnectionRow,
  credential: StoredCredential | undefined,
) {
  return connection.auth_type === "oauth"
    ? credential?.type === "oauth"
    : credential?.type === "api_key";
}

function publicConnection(
  connection: ConnectionRow,
  hasCredential: boolean,
  credentialError: string | null = null,
) {
  const { models_json: _modelsJson, ...visible } = connection;
  return {
    ...visible,
    models: storedConnectionModels(connection),
    status: credentialError
      ? "error"
      : !hasCredential
        ? "needs-auth"
        : connection.auth_error
          ? "error"
          : connection.status,
    auth_error: credentialError || connection.auth_error,
    hasCredential,
  };
}

async function publicConnections() {
  const credentialResult = await credentialStore.listResult();
  return readConnections().map((connection) => {
    const credential = credentialResult.credentials[connection.id];
    const issue = credentialResult.issues.find((candidate) => candidate.id === connection.id)
      ?? credentialResult.issues.find((candidate) => candidate.code === "store_unreadable");
    const usable = connectionCredentialIsUsable(connection, credential);
    return publicConnection(
      connection,
      usable,
      issue?.message || (credential && !usable
        ? "This provider credential has an incompatible authentication type. Reconnect it."
        : null),
    );
  });
}

async function reconcileAutoSyncedConnectionsAtStartup() {
  const credentialResult = await credentialStore.listResult();
  if (credentialResult.issues.some((issue) => issue.code === "store_unreadable")) return;
  for (const connection of readConnections()) {
    if (connection.model_selection_mode !== "automatically-synced") continue;
    const credential = credentialResult.credentials[connection.id];
    const issue = credentialResult.issues.find((candidate) => candidate.id === connection.id);
    if (issue) {
      db.prepare(
        "UPDATE llm_connections SET status = 'error', auth_error = ? WHERE id = ?",
      ).run(issue.message, connection.id);
      continue;
    }
    if (!connectionCredentialIsUsable(connection, credential)) {
      if (credential) {
        db.prepare(
          "UPDATE llm_connections SET status = 'error', auth_error = ? WHERE id = ?",
        ).run(
          "This provider credential has an incompatible authentication type. Reconnect it.",
          connection.id,
        );
        continue;
      }
      db.prepare(
        `UPDATE llm_connections
            SET status = 'needs-auth', auth_error = NULL
          WHERE id = ? AND (status <> 'needs-auth' OR auth_error IS NOT NULL)`,
      ).run(connection.id);
      continue;
    }
    refreshConnectionModels(connection, true);
  }
}

function normalizeConnectionModel(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 120 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value.trim())
  ) {
    return null;
  }
  return value.trim();
}

function normalizeBaseUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function handleConnectionsRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (request.method === "GET") {
    return sendJson(response, 200, {
      connections: await publicConnections(),
      providers: MODEL_PROVIDER_DESCRIPTORS,
    });
  }
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Method not allowed" });
  }

  const body = (await readJson(request)) as {
    name?: string;
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  const provider = body.provider as ConnectionProvider;
  if (!(["openai-compatible", "anthropic-compatible"] as const).includes(
    provider as "openai-compatible" | "anthropic-compatible",
  )) {
    return sendJson(response, 400, { error: "Unsupported connection provider" });
  }
  const name = body.name?.trim();
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  const model = normalizeConnectionModel(body.model);
  const apiKey = body.apiKey?.trim();
  if (!name || name.length > 80 || !baseUrl || !model || !apiKey || apiKey.length > 8192) {
    return sendJson(response, 400, {
      error: "Name, base URL, API key, and model are required",
    });
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const connection: ConnectionRow = {
    id,
    name,
    provider,
    auth_type: "api-key",
    base_url: baseUrl,
    api_format: provider === "openai-compatible"
      ? "openai-completions"
      : "anthropic-messages",
    default_model: model,
    models_json: JSON.stringify([{ id: model, name: model }]),
    model_selection_mode: "user-defined",
    models_refreshed_at: now,
    status: "connected",
    auth_error: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO llm_connections
      (id, name, provider, auth_type, base_url, api_format, default_model, models_json,
       model_selection_mode, models_refreshed_at, status, auth_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    connection.id,
    connection.name,
    connection.provider,
    connection.auth_type,
    connection.base_url,
    connection.api_format,
    connection.default_model,
    connection.models_json,
    connection.model_selection_mode,
    connection.models_refreshed_at,
    connection.status,
    connection.auth_error,
    connection.created_at,
    connection.updated_at,
  );
  try {
    await credentialStore.set(id, { type: "api_key", key: apiKey });
  } catch (error) {
    db.prepare("DELETE FROM llm_connections WHERE id = ?").run(id);
    throw error;
  }
  return sendJson(response, 200, {
    connection: publicConnection(connection, true),
  });
}

async function runtimeCredential(connection: ConnectionRow) {
  if (connection.provider !== "openai-codex") {
    return credentialStore.get(connection.id);
  }

  const credential = await chatGptRefreshCoordinator.resolve(
    connection.id,
    async () => {
      const result = await credentialStore.getResult(connection.id);
      if (result.issue) throw new Error(result.issue.message);
      if (result.credential?.type !== "oauth") return undefined;
      return result.credential;
    },
    async (refreshed) => credentialStore.set(connection.id, {
      type: "oauth",
      ...refreshed,
    }),
  );
  return credential
    ? { type: "oauth" as const, ...credential }
    : undefined;
}

function oauthRefreshFailureMessage(error: unknown) {
  const detail = error instanceof Error ? error.message : "";
  return /timed out/i.test(detail)
    ? "ChatGPT authorization refresh timed out. Reconnect the provider and try again."
    : "ChatGPT authorization expired and could not be refreshed. Reconnect the provider.";
}

async function handleConnectionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  connectionId: string,
  action?: string,
) {
  const connection = db
    .prepare("SELECT * FROM llm_connections WHERE id = ?")
    .get(connectionId) as unknown as ConnectionRow | undefined;
  if (!connection) return sendJson(response, 404, { error: "Connection not found" });

  if (action === "models" || action === "refresh") {
    if (request.method !== "POST") {
      return sendJson(response, 405, { error: "Method not allowed" });
    }
    const automaticallySynced = connection.model_selection_mode === "automatically-synced";
    const credentialResult = await credentialStore.getResult(connection.id);
    const hasCredential = connectionCredentialIsUsable(connection, credentialResult.credential);
    const credentialError = credentialResult.issue?.message || (
      credentialResult.credential && !hasCredential
        ? "This provider credential has an incompatible authentication type. Reconnect it."
        : null
    );
    if (automaticallySynced && (!hasCredential || credentialResult.issue)) {
      return sendJson(response, 409, {
        error: credentialError || "Reconnect this provider before refreshing its model catalog",
        connection: publicConnection(connection, false, credentialError),
        refresh: {
          source: "sdk",
          refreshedAt: connection.models_refreshed_at,
          changed: false,
        },
      });
    }
    const refreshed = publicConnection(
      automaticallySynced ? refreshConnectionModels(connection, true) : connection,
      hasCredential,
    );
    return sendJson(response, 200, {
      connection: refreshed,
      refresh: {
        source: automaticallySynced ? "sdk" : "user-defined",
        refreshedAt: refreshed.models_refreshed_at,
        changed: automaticallySynced,
      },
      settings: readAppSettings(),
    });
  }

  if (action === "test") {
    if (request.method !== "POST") {
      return sendJson(response, 405, { error: "Method not allowed" });
    }
    const credentialResult = await credentialStore.getResult(connection.id);
    const usableCredential = connectionCredentialIsUsable(connection, credentialResult.credential);
    const refreshed = publicConnection(
      connection,
      usableCredential,
      credentialResult.issue?.message || null,
    );
    const success = usableCredential && !credentialResult.issue && refreshed.models.some(
      (model) => model.id === refreshed.default_model,
    );
    const checkedAt = new Date().toISOString();
    const error = credentialResult.issue?.message || (!usableCredential
      ? "Connection is not authenticated"
      : success
        ? null
        : "Default model is not in the available model catalog");
    db.prepare(
      "UPDATE llm_connections SET status = ?, auth_error = ?, updated_at = ? WHERE id = ?",
    ).run(success ? "connected" : "error", error, checkedAt, connection.id);
    return sendJson(response, success ? 200 : 409, {
      success,
      status: success ? "connected" : "error",
      error,
      checkedAt,
      probe: "configuration",
    });
  }

  if (action === "runtime") {
    if (request.method !== "GET") {
      return sendJson(response, 405, { error: "Method not allowed" });
    }
    const credentialResult = await credentialStore.getResult(connection.id);
    if (
      credentialResult.issue ||
      !connectionCredentialIsUsable(connection, credentialResult.credential) ||
      connection.status !== "connected"
    ) {
      return sendJson(response, 409, {
        error: credentialResult.issue?.message ||
          "Connection is not ready; check its configuration or reconnect it",
      });
    }
    let credential: StoredCredential | undefined;
    try {
      credential = await runtimeCredential(connection);
    } catch (error) {
      const message = oauthRefreshFailureMessage(error);
      const updatedAt = new Date().toISOString();
      db.prepare(
        "UPDATE llm_connections SET status = 'error', auth_error = ?, updated_at = ? WHERE id = ?",
      ).run(message, updatedAt, connection.id);
      return sendJson(response, 409, { error: message });
    }
    if (!credential) {
      return sendJson(response, 409, { error: "Connection is not authenticated" });
    }
    const latestConnection = db
      .prepare("SELECT * FROM llm_connections WHERE id = ?")
      .get(connection.id) as unknown as ConnectionRow;
    const refreshed = publicConnection(latestConnection, true);
    return sendJson(response, 200, { connection: { ...refreshed, credential } });
  }

  if (request.method === "GET") {
    const credentialResult = await credentialStore.getResult(connection.id);
    const usableCredential = connectionCredentialIsUsable(connection, credentialResult.credential);
    return sendJson(response, 200, {
      connection: publicConnection(
        connection,
        usableCredential,
        credentialResult.issue?.message || (credentialResult.credential && !usableCredential
          ? "This provider credential has an incompatible authentication type. Reconnect it."
          : null),
      ),
    });
  }
  if (request.method !== "DELETE") {
    return sendJson(response, 405, { error: "Method not allowed" });
  }

  const inspectDeletionGuard = () => {
    const exists = Boolean(db.prepare(
      "SELECT 1 FROM llm_connections WHERE id = ?",
    ).get(connectionId));
    const inUseByAgents = Number((db.prepare(
      "SELECT count(*) AS count FROM agents WHERE connection_id = ?",
    ).get(connectionId) as { count: number }).count);
    const isDefault = Boolean(db.prepare(
      "SELECT 1 FROM app_settings WHERE key = 'default_connection_id' AND value = ?",
    ).get(connectionId));
    return { exists, inUseByAgents, isDefault };
  };
  const deletion = await deleteConnectionSafely(connectionId, {
    inspectGuard: inspectDeletionGuard,
    deleteCredential: () => credentialStore.delete(connectionId),
    deleteRowIfUnguarded: () => {
      const result = db.prepare(
        `DELETE FROM llm_connections
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM agents WHERE connection_id = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM app_settings
               WHERE key = 'default_connection_id' AND value = ?
            )`,
      ).run(connectionId, connectionId, connectionId);
      return result.changes === 1;
    },
    markNeedsAuth: () => {
      db.prepare(
        `UPDATE llm_connections
            SET status = 'needs-auth', auth_error = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(new Date().toISOString(), connectionId);
    },
  });

  if (deletion.kind === "not-found") {
    return sendJson(response, 404, { error: "Connection not found" });
  }
  if (deletion.kind === "blocked") {
    const retained = deletion.credentialRemoved
      ? db.prepare("SELECT * FROM llm_connections WHERE id = ?").get(connectionId) as
        | ConnectionRow
        | undefined
      : undefined;
    return sendJson(response, 409, {
      error: deletion.credentialRemoved
        ? "The connection became active while it was being removed. Reconnect it before using it again."
        : deletion.isDefault
        ? "Choose another default model connection before removing this one"
        : "Reassign agents that use this connection before removing it",
      inUseByAgents: deletion.inUseByAgents,
      isDefault: deletion.isDefault,
      credentialRemoved: deletion.credentialRemoved,
      recoverable: deletion.credentialRemoved,
      connection: retained ? publicConnection(retained, false) : undefined,
    });
  }
  if (deletion.kind === "credential-error") {
    console.error("Could not remove model connection credential:", deletion.error);
    return sendJson(response, 500, {
      error: "Could not remove the connection credential. The connection was left unchanged.",
      recoverable: true,
    });
  }
  if (deletion.kind === "database-error") {
    console.error("Could not remove model connection metadata:", deletion.error);
    const retained = db.prepare(
      "SELECT * FROM llm_connections WHERE id = ?",
    ).get(connectionId) as unknown as ConnectionRow | undefined;
    return sendJson(response, 500, {
      error: "The credential was removed, but the connection record could not be deleted. Reconnect it or retry removal.",
      connection: retained ? publicConnection(retained, false) : undefined,
      credentialRemoved: true,
      recoverable: true,
    });
  }
  return sendJson(response, 200, { success: true });
}

async function saveChatGptConnection(credential: StoredCredential) {
  const now = new Date().toISOString();
  const catalog = CHATGPT_MODEL_CATALOG
    .filter((model) => !CHATGPT_OAUTH_UNAVAILABLE_MODELS.has(model.id))
    .map((model) => ({
      id: model.id,
      name: model.name || model.id,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: [...model.input],
      supportsImages: model.input.includes("image"),
      cost: { ...model.cost },
    }));
  const catalogIds = catalog.map((model) => model.id);
  const defaultModel = CHATGPT_OAUTH_PREFERRED_MODELS.find((candidate) =>
    catalogIds.includes(candidate),
  ) || catalogIds[0];
  if (!defaultModel) throw new Error("No supported ChatGPT models are available");
  db.prepare(
    `INSERT INTO llm_connections
      (id, name, provider, auth_type, base_url, api_format, default_model, models_json,
       model_selection_mode, models_refreshed_at, status, auth_error, created_at, updated_at)
     VALUES (?, ?, 'openai-codex', 'oauth', NULL, 'openai-codex-responses', ?, ?,
             'automatically-synced', ?, 'connected', NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       default_model = excluded.default_model,
       models_json = excluded.models_json,
       model_selection_mode = excluded.model_selection_mode,
       models_refreshed_at = excluded.models_refreshed_at,
       status = excluded.status,
       auth_error = NULL,
       updated_at = excluded.updated_at`,
  ).run(
    CHATGPT_CONNECTION_ID,
    "ChatGPT Plus / Pro",
    defaultModel,
    JSON.stringify(catalog),
    now,
    now,
    now,
  );
  const savedConnection = db.prepare("SELECT * FROM llm_connections WHERE id = ?")
    .get(CHATGPT_CONNECTION_ID) as unknown as ConnectionRow;
  try {
    await credentialStore.set(CHATGPT_CONNECTION_ID, credential);
  } catch (error) {
    db.prepare(
      "UPDATE llm_connections SET status = 'error', auth_error = ?, updated_at = ? WHERE id = ?",
    ).run("Could not securely save the OAuth credential", new Date().toISOString(), CHATGPT_CONNECTION_ID);
    throw error;
  }
  refreshConnectionModels(savedConnection, true);
}

async function startChatGptOAuth() {
  if (pendingOAuthFlow?.status === "starting" || pendingOAuthFlow?.status === "waiting") {
    return pendingOAuthFlow;
  }

  let resolveAuthUrl: (url: string) => void = () => undefined;
  let rejectManualInput: (error: Error) => void = () => undefined;
  const authUrlReady = new Promise<string>((resolveUrl) => {
    resolveAuthUrl = resolveUrl;
  });
  const manualInput = new Promise<string>((_resolve, reject) => {
    rejectManualInput = reject;
  });
  pendingOAuthFlow = {
    status: "starting",
    cancel: () => rejectManualInput(new Error("OAuth login canceled")),
  };
  const flowTimeout = setTimeout(() => {
    pendingOAuthFlow?.cancel?.();
  }, 5 * 60_000);

  void loginOpenAICodex({
    originator: "teammate",
    onAuth: ({ url }) => {
      if (!pendingOAuthFlow) return;
      pendingOAuthFlow.status = "waiting";
      pendingOAuthFlow.authUrl = url;
      resolveAuthUrl(url);
    },
    onManualCodeInput: async () => manualInput,
  }).then(async (tokens) => {
    clearTimeout(flowTimeout);
    await saveChatGptConnection({
      type: "oauth",
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
      accountId: typeof tokens.accountId === "string"
        ? tokens.accountId
        : undefined,
    });
    pendingOAuthFlow = { status: "complete" };
  }).catch((error) => {
    clearTimeout(flowTimeout);
    pendingOAuthFlow = {
      status: "error",
      error: error instanceof Error ? error.message : "OAuth login failed",
    };
  });

  const authUrl = await Promise.race([
    authUrlReady,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("OAuth callback server did not start")), 5000);
    }),
  ]);
  return { ...pendingOAuthFlow, authUrl };
}

async function handleChatGptOAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  action: string,
) {
  if (action === "start" && request.method === "POST") {
    const flow = await startChatGptOAuth();
    return sendJson(response, 200, {
      status: flow.status,
      authUrl: flow.authUrl,
    });
  }
  if (action === "status" && request.method === "GET") {
    const connected = Boolean(await credentialStore.get(CHATGPT_CONNECTION_ID));
    return sendJson(response, 200, {
      status: pendingOAuthFlow?.status || (connected ? "complete" : "idle"),
      error: pendingOAuthFlow?.error,
      connected,
      connectionId: connected ? CHATGPT_CONNECTION_ID : null,
    });
  }
  if (action === "cancel" && request.method === "POST") {
    pendingOAuthFlow?.cancel?.();
    return sendJson(response, 200, { success: true });
  }
  return sendJson(response, 405, { error: "Method not allowed" });
}

function readAppSettings() {
  const rows = db.prepare("SELECT key, value FROM app_settings").all() as Array<{
    key: string;
    value: string;
  }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const defaultRuntime = normalizeRuntime(values.get("default_runtime"));
  const defaultConnectionId = values.get("default_connection_id") || null;
  return {
    language: values.get("language") || "zh-CN",
    theme: values.get("theme") || "system",
    defaultRuntime,
    defaultModel: normalizeModel(defaultRuntime, values.get("default_model")),
    defaultConnectionId,
    defaultThinkingLevel: normalizeThinkingLevel(values.get("default_thinking_level")),
    showActivityDetails: values.get("show_activity_details") !== "false",
    messageSounds: values.get("message_sounds") !== "false",
  };
}

async function handleServersRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (request.method === "GET") {
    const servers = db
      .prepare(
        `SELECT s.*
         FROM servers s
         JOIN server_members sm ON sm.server_id = s.id
         WHERE sm.member_id = ? AND sm.member_type = 'human'
         ORDER BY s.created_at`,
      )
      .all(LOCAL_USER_ID);
    return sendJson(response, 200, { servers });
  }

  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Method not allowed" });
  }

  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return sendJson(response, 400, { error: "Request body must be valid JSON" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendJson(response, 400, { error: "Request body must be an object" });
  }

  const input = body as Record<string, unknown>;
  if (typeof input.name !== "string") {
    return sendJson(response, 400, { error: "name is required" });
  }
  const name = input.name.trim();
  if (!name || name.length > 80) {
    return sendJson(response, 400, {
      error: "name must be between 1 and 80 characters",
    });
  }

  if (
    input.slug !== undefined &&
    input.slug !== null &&
    typeof input.slug !== "string"
  ) {
    return sendJson(response, 400, { error: "slug must be a string" });
  }
  const requestedSlug = typeof input.slug === "string" ? input.slug.trim() : "";
  const slug = (requestedSlug || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (
    !slug ||
    slug.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
  ) {
    return sendJson(response, 400, {
      error: "slug must contain only lowercase letters, numbers, and single hyphens",
    });
  }
  if (requestedSlug && requestedSlug !== slug) {
    return sendJson(response, 400, {
      error: "slug must contain only lowercase letters, numbers, and single hyphens",
    });
  }

  if (
    input.description !== undefined &&
    input.description !== null &&
    typeof input.description !== "string"
  ) {
    return sendJson(response, 400, { error: "description must be a string or null" });
  }
  const description = typeof input.description === "string"
    ? input.description.trim() || null
    : null;
  if (description && description.length > 500) {
    return sendJson(response, 400, {
      error: "description must be 500 characters or fewer",
    });
  }

  const existing = db.prepare("SELECT id FROM servers WHERE slug = ?").get(slug);
  if (existing) {
    return sendJson(response, 409, { error: "This slug is already in use" });
  }

  const now = new Date().toISOString();
  const serverId = randomUUID();
  const channelId = randomUUID();

  try {
    const result = runAtomicMutationTransaction("server", () => {
      const server = queryData({
        table: "servers",
        action: "insert",
        single: true,
        values: {
          id: serverId,
          name,
          slug,
          description,
          owner_id: LOCAL_USER_ID,
          created_at: now,
        },
      }) as DbRow;
      queryData({
        table: "server_members",
        action: "insert",
        single: true,
        values: {
          server_id: serverId,
          member_id: LOCAL_USER_ID,
          member_type: "human",
          role: "owner",
          joined_at: now,
        },
      });
      const channel = queryData({
        table: "channels",
        action: "insert",
        single: true,
        values: {
          id: channelId,
          name: "general",
          description: "General workspace discussion",
          type: "public",
          created_by: LOCAL_USER_ID,
          server_id: serverId,
          created_at: now,
        },
      }) as DbRow;
      queryData({
        table: "channel_members",
        action: "insert",
        single: true,
        values: {
          channel_id: channelId,
          member_id: LOCAL_USER_ID,
          member_type: "human",
          joined_at: now,
        },
      });
      return { server, channel };
    });
    return sendJson(response, 201, result);
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed:\s*servers\.slug/i.test(error.message)
    ) {
      return sendJson(response, 409, { error: "This slug is already in use" });
    }
    console.error("[local-server] Failed to create workspace:", error);
    return sendJson(response, 500, { error: "Failed to create workspace" });
  }
}

type SelectedChannelMember = {
  member_id: string;
  member_type: "human" | "agent";
};

function requireRpcArguments(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalRequestError(400, "RPC arguments must be an object");
  }
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => !allowedKeys.includes(key))) {
    throw new LocalRequestError(400, "RPC arguments contain unsupported fields");
  }
  return args;
}

function rpcUuid(value: unknown, field: string): string;
function rpcUuid(value: unknown, field: string, nullable: false): string;
function rpcUuid(value: unknown, field: string, nullable: true): string | null;
function rpcUuid(value: unknown, field: string, nullable = false): string | null {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new LocalRequestError(400, `${field} must be a valid UUID`);
  }
  return value;
}

function rpcTimestamp(value: unknown, field: string) {
  if (
    typeof value !== "string" ||
    !value ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new LocalRequestError(400, `${field} must be an ISO timestamp`);
  }
  return value;
}

function taskTextLength(value: string) {
  return Array.from(value).length;
}

function truncateTaskText(value: string, maxLength: number) {
  return Array.from(value).slice(0, maxLength).join("");
}

function timestampsMatch(left: unknown, right: string) {
  return typeof left === "string" && Date.parse(left) === Date.parse(right);
}

function nextMonotonicTimestamp(...previousValues: unknown[]) {
  const latestPrevious = previousValues.reduce<number>((latest, value) => {
    if (typeof value !== "string") return latest;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, 0);
  return new Date(Math.max(Date.now(), latestPrevious + 1)).toISOString();
}

function parseSelectedChannelMembers(value: unknown): SelectedChannelMember[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new LocalRequestError(400, "selected_members must be an array of at most 100 members");
  }
  const members = value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new LocalRequestError(400, "Invalid selected channel member");
    }
    const record = candidate as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      !("member_id" in record) ||
      !("member_type" in record)
    ) {
      throw new LocalRequestError(400, "Invalid selected channel member");
    }
    const memberId = rpcUuid(record.member_id, "member_id");
    if (record.member_type !== "human" && record.member_type !== "agent") {
      throw new LocalRequestError(400, "Invalid selected channel member type");
    }
    const memberType = record.member_type as SelectedChannelMember["member_type"];
    if (memberId === LOCAL_USER_ID) {
      throw new LocalRequestError(400, "selected_members must exclude the creator");
    }
    return { member_id: memberId, member_type: memberType };
  });
  if (new Set(members.map((member) => member.member_id)).size !== members.length) {
    throw new LocalRequestError(400, "Selected channel members must be unique");
  }
  return members;
}

function parseAgentIds(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new LocalRequestError(400, "agent_ids must be an array of at most 100 UUIDs");
  }
  const ids = value.map((id) => rpcUuid(id, "agent_id"));
  if (new Set(ids).size !== ids.length) {
    throw new LocalRequestError(400, "Agent ids must be unique");
  }
  return ids;
}

function localListWorkspaceAgentDirectory(argsValue: unknown) {
  const args = requireRpcArguments(argsValue, ["server_uuid"]);
  const serverId = rpcUuid(args.server_uuid, "server_uuid");
  if (!localRowExists(
    `SELECT 1
       FROM server_members member
       JOIN profiles profile ON profile.id = member.member_id
      WHERE member.server_id = ?
        AND member.member_id = ?
        AND member.member_type = 'human'`,
    serverId,
    LOCAL_USER_ID,
  )) {
    throw new LocalRequestError(403, "Workspace access denied");
  }

  return db.prepare(
    `SELECT
       agent.id,
       agent.name,
       agent.display_name,
       agent.description,
       agent.avatar_url,
       agent.status
     FROM agents agent
     JOIN server_members agent_membership
       ON agent_membership.server_id = agent.server_id
      AND agent_membership.member_id = agent.id
      AND agent_membership.member_type = 'agent'
     WHERE agent.server_id = ?
     ORDER BY agent.created_at, agent.id`,
  ).all(serverId);
}

function localListWorkspaceHumanMembers(argsValue: unknown) {
  const args = requireRpcArguments(argsValue, ["server_uuid"]);
  const serverId = rpcUuid(args.server_uuid, "server_uuid");
  if (!localUserCanAccessServer(serverId)) {
    throw new LocalRequestError(403, "Workspace access denied");
  }

  const members = db.prepare(
    `SELECT
       profile.id,
       profile.display_name,
       profile.avatar_url,
       membership.role,
       membership.joined_at,
       count(agent.id) AS agent_count,
       profile.id = ? AS is_current_user
     FROM server_members membership
     JOIN profiles profile ON profile.id = membership.member_id
     LEFT JOIN agents agent
       ON agent.server_id = membership.server_id
      AND agent.owner_id = membership.member_id
     WHERE membership.server_id = ?
       AND membership.member_type = 'human'
     GROUP BY
       profile.id,
       profile.display_name,
       profile.avatar_url,
       membership.role,
       membership.joined_at
     ORDER BY
       CASE membership.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
       membership.joined_at,
       profile.id`,
  ).all(LOCAL_USER_ID, serverId) as Array<DbRow & { is_current_user: number }>;

  return members.map((member) => ({
    ...member,
    is_current_user: Boolean(member.is_current_user),
  }));
}

function localListWorkspaceHumanDirectory(argsValue: unknown) {
  const args = requireRpcArguments(argsValue, ["server_uuid"]);
  const serverId = rpcUuid(args.server_uuid, "server_uuid");
  if (!localUserCanAccessServer(serverId)) {
    throw new LocalRequestError(403, "Workspace access denied");
  }

  return db.prepare(
    `SELECT profile.id, profile.display_name, profile.avatar_url
       FROM server_members membership
       JOIN profiles profile ON profile.id = membership.member_id
      WHERE membership.server_id = ?
        AND membership.member_type = 'human'
      ORDER BY profile.display_name, profile.id`,
  ).all(serverId);
}

function localCreateCurrentUserMachineKey(argsValue: unknown) {
  const args = requireRpcArguments(argsValue, [
    "server_uuid",
    "machine_key_prefix",
    "machine_key_hash",
    "machine_key_name",
  ]);
  const serverId = rpcUuid(args.server_uuid, "server_uuid");
  const keyPrefix = typeof args.machine_key_prefix === "string"
    ? args.machine_key_prefix
    : "";
  const keyHash = typeof args.machine_key_hash === "string"
    ? args.machine_key_hash
    : "";
  const keyName = typeof args.machine_key_name === "string"
    ? args.machine_key_name.trim()
    : "";
  if (
    !/^tm_[0-9a-f]{8}$/.test(keyPrefix) ||
    !/^[0-9a-f]{64}$/.test(keyHash) ||
    !keyName ||
    keyName.length > 100
  ) {
    throw new LocalRequestError(400, "Invalid runtime key");
  }
  return runAtomicMutationTransaction("key", () => {
    // BEGIN IMMEDIATE serializes this membership check and insert with the
    // local member-eviction transaction.
    if (!localUserCanAccessServer(serverId)) {
      throw new LocalRequestError(403, "Workspace access denied");
    }
    const createdAt = new Date().toISOString();
    const createdKey = queryData({
      table: "machine_keys",
      action: "insert",
      single: true,
      values: {
        id: randomUUID(),
        key_prefix: keyPrefix,
        key_hash: keyHash,
        key_value: null,
        user_id: LOCAL_USER_ID,
        server_id: serverId,
        name: keyName,
        created_at: createdAt,
        last_used_at: null,
      },
    }) as DbRow;
    return {
      id: createdKey.id,
      key_prefix: createdKey.key_prefix,
      name: createdKey.name,
      created_at: createdKey.created_at,
    };
  });
}

function localRemoveServerHumanMember(argsValue: unknown) {
  const args = requireRpcArguments(argsValue, ["server_uuid", "human_uuid"]);
  const serverId = rpcUuid(args.server_uuid, "server_uuid");
  const humanId = rpcUuid(args.human_uuid, "human_uuid");
  const workspace = db.prepare("SELECT owner_id FROM servers WHERE id = ?").get(serverId) as
    | { owner_id: string }
    | undefined;
  if (!workspace || workspace.owner_id !== LOCAL_USER_ID) {
    throw new LocalRequestError(403, "Only the workspace owner can remove members");
  }
  if (humanId === workspace.owner_id) {
    throw new LocalRequestError(400, "The workspace owner cannot be removed");
  }

  let revokedAgentIds: string[] = [];
  const result = runAtomicMutationTransaction("membership", () => {
    const targetAgents = db.prepare(
      "SELECT id FROM agents WHERE server_id = ? AND owner_id = ? ORDER BY id",
    ).all(serverId, humanId) as Array<{ id: string }>;
    const targetAgentIds = targetAgents.map((agent) => agent.id);
    revokedAgentIds = targetAgentIds;
    for (const agentId of targetAgentIds) agentDeletionIds.add(agentId);

    try {
      const channelRows = db.prepare(
        "SELECT id FROM channels WHERE server_id = ? ORDER BY id",
      ).all(serverId) as Array<{ id: string }>;
      const channelIds = channelRows.map((channel) => channel.id);
      const targetDmRows = db.prepare(
        `SELECT DISTINCT channel.id
           FROM channels channel
           JOIN channel_members member ON member.channel_id = channel.id
          WHERE channel.server_id = ?
            AND channel.type = 'dm'
            AND (
              (member.member_id = ? AND member.member_type = 'human')
              OR (member.member_type = 'agent' AND member.member_id IN (
                SELECT agent.id FROM agents agent
                 WHERE agent.server_id = ? AND agent.owner_id = ?
              ))
            )
          ORDER BY channel.id`,
      ).all(serverId, humanId, serverId, humanId) as Array<{ id: string }>;
      const targetDmIds = targetDmRows.map((channel) => channel.id);
      const deliveryCount = targetAgentIds.length === 0
        ? 0
        : Number((db.prepare(
          `SELECT count(*) AS count FROM message_deliveries
            WHERE server_id = ? AND agent_id IN (${targetAgentIds.map(() => "?").join(", ")})`,
        ).get(serverId, ...targetAgentIds) as { count: number }).count);

      if (targetDmIds.length > 0) {
        executeQuery({
          table: "channels",
          action: "delete",
          filters: [{ column: "id", operator: "in", value: targetDmIds }],
        });
      }

      let clearedTaskAssignments = 0;
      if (channelIds.length > 0) {
        clearedTaskAssignments += executeQuery({
          table: "tasks",
          action: "update",
          values: { assignee_id: null, assignee_type: null },
          filters: [
            { column: "channel_id", operator: "in", value: channelIds },
            { column: "assignee_id", operator: "eq", value: humanId },
            { column: "assignee_type", operator: "eq", value: "human" },
          ],
        }).count || 0;
        for (const agentId of targetAgentIds) {
          clearedTaskAssignments += executeQuery({
            table: "tasks",
            action: "update",
            values: { assignee_id: null, assignee_type: null },
            filters: [
              { column: "channel_id", operator: "in", value: channelIds },
              { column: "assignee_id", operator: "eq", value: agentId },
              { column: "assignee_type", operator: "eq", value: "agent" },
            ],
          }).count || 0;
        }

        executeQuery({
          table: "channel_members",
          action: "delete",
          filters: [
            { column: "channel_id", operator: "in", value: channelIds },
            { column: "member_id", operator: "eq", value: humanId },
            { column: "member_type", operator: "eq", value: "human" },
          ],
        });
      }

      if (targetAgentIds.length > 0) {
        executeQuery({
          table: "agents",
          action: "delete",
          filters: [{ column: "id", operator: "in", value: targetAgentIds }],
        });
      }
      const revokedMachineKeys = executeQuery({
        table: "machine_keys",
        action: "delete",
        filters: [
          { column: "server_id", operator: "eq", value: serverId },
          { column: "user_id", operator: "eq", value: humanId },
        ],
      }).count || 0;
      const removedHumanMembership = executeQuery({
        table: "server_members",
        action: "delete",
        filters: [
          { column: "server_id", operator: "eq", value: serverId },
          { column: "member_id", operator: "eq", value: humanId },
          { column: "member_type", operator: "eq", value: "human" },
        ],
      }).count || 0;

      return {
        removed: removedHumanMembership === 1,
        agents_removed: targetAgentIds.length,
        machine_keys_revoked: revokedMachineKeys,
        dm_channels_removed: targetDmIds.length,
        task_assignments_cleared: clearedTaskAssignments,
        deliveries_removed: deliveryCount,
      };
    } finally {
      for (const agentId of targetAgentIds) agentDeletionIds.delete(agentId);
    }
  });
  for (const agentId of revokedAgentIds) deleteAgentCapabilities(agentId);
  return result;
}

function localCreateChannelWithMembers(argsValue: unknown) {
  const args = requireRpcArguments(argsValue, [
    "server_uuid",
    "channel_name",
    "channel_description",
    "channel_type",
    "selected_members",
  ]);
  const serverId = rpcUuid(args.server_uuid, "server_uuid");
  const name = typeof args.channel_name === "string" ? args.channel_name.trim() : "";
  const description = args.channel_description === null || args.channel_description === undefined
    ? ""
    : typeof args.channel_description === "string"
      ? args.channel_description
      : "";
  if (!name || name.length > 100 || description.length > 1000) {
    throw new LocalRequestError(400, "Invalid channel configuration");
  }
  if (args.channel_type !== "public" && args.channel_type !== "private") {
    throw new LocalRequestError(400, "Channel type must be public or private");
  }
  const selectedMembers = parseSelectedChannelMembers(args.selected_members);
  if (!localRowExists(
    `SELECT 1
       FROM server_members member
       JOIN profiles profile ON profile.id = member.member_id
      WHERE member.server_id = ?
        AND member.member_id = ?
        AND member.member_type = 'human'`,
    serverId,
    LOCAL_USER_ID,
  )) {
    throw new LocalRequestError(403, "Workspace access denied");
  }

  try {
    return runAtomicMutationTransaction("channel", () => {
      const channel = queryData({
        table: "channels",
        action: "insert",
        single: true,
        values: {
          name,
          description: description.trim() || null,
          type: args.channel_type,
          created_by: LOCAL_USER_ID,
          server_id: serverId,
        },
      }) as DbRow;
      queryData({
        table: "channel_members",
        action: "insert",
        values: {
          channel_id: channel.id,
          member_id: LOCAL_USER_ID,
          member_type: "human",
        },
      });
      for (const member of selectedMembers) {
        queryData({
          table: "channel_members",
          action: "insert",
          values: {
            channel_id: channel.id,
            member_id: member.member_id,
            member_type: member.member_type,
          },
        });
      }
      const members = db
        .prepare("SELECT * FROM channel_members WHERE channel_id = ? ORDER BY joined_at, member_id")
        .all(toSqlValue(channel.id));
      return { channel, members };
    });
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed:\s*channels\.server_id,\s*channels\.name/i.test(error.message)) {
      throw new LocalRequestError(409, "A channel with this name already exists");
    }
    throw error;
  }
}

function localSetChannelAgentMembers(argsValue: unknown) {
  const args = requireRpcArguments(argsValue, [
    "channel_uuid",
    "agent_ids",
    "channel_name",
    "channel_description",
    "expected_agent_ids",
    "expected_channel_name",
    "expected_channel_description",
  ]);
  const channelId = rpcUuid(args.channel_uuid, "channel_uuid");
  const agentIds = parseAgentIds(args.agent_ids);
  const expectedAgentIds = parseAgentIds(args.expected_agent_ids);
  if (typeof args.expected_channel_name !== "string") {
    throw new LocalRequestError(400, "expected_channel_name is required");
  }
  if (
    args.expected_channel_description !== null &&
    typeof args.expected_channel_description !== "string"
  ) {
    throw new LocalRequestError(400, "expected_channel_description must be a string or null");
  }
  const expectedChannelName = args.expected_channel_name;
  const expectedChannelDescription = args.expected_channel_description;
  const name = typeof args.channel_name === "string" ? args.channel_name.trim() : "";
  const description = args.channel_description === null || args.channel_description === undefined
    ? ""
    : typeof args.channel_description === "string"
      ? args.channel_description
      : "";
  if (!name || name.length > 100 || description.length > 1000) {
    throw new LocalRequestError(400, "Invalid channel configuration");
  }
  const channel = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as DbRow | undefined;
  if (!channel) throw new LocalRequestError(404, "Channel not found");
  if (!localUserCanManageChannel(channelId)) {
    throw new LocalRequestError(403, "Channel management access denied");
  }
  if (channel.type !== "public" && channel.type !== "private") {
    throw new LocalRequestError(400, "Direct-message membership is managed with its agent");
  }

  try {
    return runAtomicMutationTransaction("channel", () => {
      const lockedChannel = db.prepare("SELECT name, description FROM channels WHERE id = ?").get(channelId) as
        | { name: string; description: string | null }
        | undefined;
      if (
        !lockedChannel ||
        lockedChannel.name !== expectedChannelName ||
        lockedChannel.description !== expectedChannelDescription
      ) {
        throw new LocalRequestError(409, "Channel details changed; refresh and retry");
      }
      const currentAgentIds = (db.prepare(
        "SELECT member_id FROM channel_members WHERE channel_id = ? AND member_type = 'agent'",
      ).all(channelId) as Array<{ member_id: string }>).map((member) => member.member_id);
      const expectedSet = new Set(expectedAgentIds);
      if (
        currentAgentIds.length !== expectedSet.size ||
        currentAgentIds.some((agentId) => !expectedSet.has(agentId))
      ) {
        throw new LocalRequestError(409, "Channel membership changed; refresh and retry");
      }
      const savedChannel = queryData({
        table: "channels",
        action: "update",
        single: true,
        values: { name, description: description.trim() || null },
        filters: [{ column: "id", operator: "eq", value: channelId }],
      }) as DbRow;
      const desiredSet = new Set(agentIds);
      const currentSet = new Set(currentAgentIds);
      const assignedTasks = db.prepare(
        "SELECT id, assignee_id FROM tasks WHERE channel_id = ? AND assignee_type = 'agent'",
      ).all(channelId) as Array<{ id: string; assignee_id: string }>;
      for (const assignedTask of assignedTasks) {
        if (desiredSet.has(assignedTask.assignee_id)) continue;
        queryData({
          table: "tasks",
          action: "update",
          values: { assignee_id: null, assignee_type: null },
          filters: [{ column: "id", operator: "eq", value: assignedTask.id }],
        });
      }
      for (const currentAgentId of currentAgentIds) {
        if (desiredSet.has(currentAgentId)) continue;
        executeQuery({
          table: "channel_members",
          action: "delete",
          filters: [
            { column: "channel_id", operator: "eq", value: channelId },
            { column: "member_id", operator: "eq", value: currentAgentId },
            { column: "member_type", operator: "eq", value: "agent" },
          ],
        });
      }
      for (const agentId of agentIds) {
        if (currentSet.has(agentId)) continue;
        queryData({
          table: "channel_members",
          action: "insert",
          values: {
            channel_id: channelId,
            member_id: agentId,
            member_type: "agent",
          },
        });
      }
      return { channel: savedChannel, agent_ids: agentIds };
    });
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed:\s*channels\.server_id,\s*channels\.name/i.test(error.message)) {
      throw new LocalRequestError(409, "A channel with this name already exists");
    }
    throw error;
  }
}

function parseTaskAssignee(args: Record<string, unknown>) {
  const assigneeId = rpcUuid(args.assignee_uuid, "assignee_uuid", true);
  const assigneeType = args.assignee_type === null || args.assignee_type === undefined
    ? null
    : args.assignee_type;
  if (
    (assigneeId === null) !== (assigneeType === null) ||
    (assigneeType !== null && assigneeType !== "human" && assigneeType !== "agent")
  ) {
    throw new LocalRequestError(400, "Invalid task assignee");
  }
  const mentionName = args.assignee_mention_name === null || args.assignee_mention_name === undefined
    ? null
    : typeof args.assignee_mention_name === "string"
      ? args.assignee_mention_name.trim()
      : "";
  if (assigneeType === "agent" && (!mentionName || mentionName.length > 100)) {
    throw new LocalRequestError(400, "Agent assignment requires a mention name");
  }
  if (assigneeType !== "agent" && mentionName) {
    throw new LocalRequestError(400, "Only agent assignments can include a mention name");
  }
  return {
    assigneeId,
    assigneeType: assigneeType as "human" | "agent" | null,
    mentionName,
  };
}

function requireUniqueLocalAgentMention(
  channelId: string,
  assigneeId: string,
  mentionName: string,
) {
  const candidates = db.prepare(
    `SELECT agent.id, agent.name, agent.display_name
       FROM agents agent
       JOIN channel_members channel_member
         ON channel_member.member_id = agent.id
        AND channel_member.member_type = 'agent'
        AND channel_member.channel_id = ?
       JOIN channels channel
         ON channel.id = channel_member.channel_id
        AND channel.server_id = agent.server_id
       JOIN server_members workspace_member
         ON workspace_member.server_id = channel.server_id
        AND workspace_member.member_id = agent.id
        AND workspace_member.member_type = 'agent'
      WHERE channel_member.channel_id = ?`,
  ).all(channelId, channelId) as Array<{
    id: string;
    name: string;
    display_name: string;
  }>;
  const normalizedMention = mentionName.toLocaleLowerCase();
  const stableMatches = candidates.filter(
    (candidate) => candidate.name.toLocaleLowerCase() === normalizedMention,
  );
  const matches = stableMatches.length > 0
    ? stableMatches
    : candidates.filter(
        (candidate) => candidate.display_name.toLocaleLowerCase() === normalizedMention,
      );
  if (matches.length !== 1 || matches[0].id !== assigneeId) {
    throw new LocalRequestError(
      400,
      "Agent mention name must uniquely identify the assignee in this channel",
    );
  }
}

function localCreateTaskWithMessage(argsValue: unknown) {
  const args = requireRpcArguments(argsValue, [
    "channel_uuid",
    "task_title",
    "parent_task_uuid",
    "assignee_uuid",
    "assignee_type",
    "assignee_mention_name",
    "sender_agent_uuid",
  ]);
  if (!("sender_agent_uuid" in args)) {
    throw new LocalRequestError(400, "sender_agent_uuid is required");
  }
  const channelId = rpcUuid(args.channel_uuid, "channel_uuid");
  const parentTaskId = rpcUuid(args.parent_task_uuid, "parent_task_uuid", true);
  const senderAgentId = rpcUuid(args.sender_agent_uuid, "sender_agent_uuid", true);
  const title = typeof args.task_title === "string" ? args.task_title.trim() : "";
  if (!title || taskTextLength(title) > 500) {
    throw new LocalRequestError(400, "Invalid task title");
  }
  const assignee = parseTaskAssignee(args);
  const canSend = senderAgentId === null
    ? localMemberBelongsToChannel(channelId, LOCAL_USER_ID, "human")
    : localUserOwnsAgentInChannel(senderAgentId, channelId);
  if (!canSend) {
    throw new LocalRequestError(403, "Channel access denied");
  }

  return runAtomicMutationTransaction("task", () => {
    const message = queryData({
      table: "messages",
      action: "insert",
      single: true,
      values: {
        channel_id: channelId,
        sender_id: senderAgentId || LOCAL_USER_ID,
        sender_type: senderAgentId ? "agent" : "system",
        content: title,
      },
    }) as DbRow;
    const task = queryData({
      table: "tasks",
      action: "insert",
      single: true,
      values: {
        message_id: message.id,
        channel_id: channelId,
        title,
        parent_task_id: parentTaskId,
        assignee_id: assignee.assigneeId,
        assignee_type: assignee.assigneeType,
      },
    }) as DbRow;
    let notification: DbRow | null = null;
    if (
      assignee.assigneeType === "agent" &&
      senderAgentId !== assignee.assigneeId
    ) {
      requireUniqueLocalAgentMention(
        channelId,
        assignee.assigneeId!,
        assignee.mentionName!,
      );
      const content = `@${assignee.mentionName} Task #${task.task_number} assigned to you: ${title}`;
      if (content.length > 100_000) {
        throw new LocalRequestError(400, "Task notification is too long");
      }
      notification = queryData({
        table: "messages",
        action: "insert",
        single: true,
        values: {
          channel_id: channelId,
          sender_id: senderAgentId || LOCAL_USER_ID,
          sender_type: senderAgentId ? "agent" : "human",
          content,
        },
      }) as DbRow;
      if (senderAgentId) {
        const channel = db.prepare("SELECT server_id FROM channels WHERE id = ?").get(channelId) as
          | { server_id: string }
          | undefined;
        if (!channel) throw new LocalRequestError(404, "Channel not found");
        queryData({
          table: "message_deliveries",
          action: "insert",
          single: true,
          values: {
            message_id: notification.id,
            agent_id: assignee.assigneeId,
            server_id: channel.server_id,
            channel_id: channelId,
          },
        });
      }
    }
    return { message, task, notification };
  });
}

function localAssignTaskWithNotification(argsValue: unknown) {
  const args = requireRpcArguments(argsValue, [
    "task_uuid",
    "assignee_uuid",
    "assignee_type",
    "assignee_mention_name",
    "sender_agent_uuid",
    "expected_updated_at",
  ]);
  if (!("sender_agent_uuid" in args)) {
    throw new LocalRequestError(400, "sender_agent_uuid is required");
  }
  const taskId = rpcUuid(args.task_uuid, "task_uuid");
  const senderAgentId = rpcUuid(args.sender_agent_uuid, "sender_agent_uuid", true);
  const expectedUpdatedAt = rpcTimestamp(args.expected_updated_at, "expected_updated_at");
  const assignee = parseTaskAssignee(args);

  return runAtomicMutationTransaction("task", () => {
    const currentTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as DbRow | undefined;
    const canAssign = currentTask && (
      senderAgentId === null
        ? localMemberBelongsToChannel(String(currentTask.channel_id), LOCAL_USER_ID, "human")
        : localUserOwnsAgentInChannel(senderAgentId, String(currentTask.channel_id))
    );
    if (!currentTask || !canAssign) {
      throw new LocalRequestError(404, "Task not found");
    }
    if (!timestampsMatch(currentTask.updated_at, expectedUpdatedAt)) {
      throw new LocalRequestError(409, "Task changed; refresh and retry");
    }
    if (currentTask.archived_at !== null) {
      throw new LocalRequestError(400, "Archived tasks cannot be reassigned");
    }
    const changed = (currentTask.assignee_id ?? null) !== assignee.assigneeId ||
      (currentTask.assignee_type ?? null) !== assignee.assigneeType;
    if (!changed) return { task: currentTask, notification: null };

    const task = queryData({
      table: "tasks",
      action: "update",
      single: true,
      values: {
        assignee_id: assignee.assigneeId,
        assignee_type: assignee.assigneeType,
      },
      filters: [{ column: "id", operator: "eq", value: taskId }],
    }) as DbRow;
    let notification: DbRow | null = null;
    if (
      assignee.assigneeType === "agent" &&
      senderAgentId !== assignee.assigneeId
    ) {
      requireUniqueLocalAgentMention(
        String(task.channel_id),
        assignee.assigneeId!,
        assignee.mentionName!,
      );
      const content = `@${assignee.mentionName} Task #${task.task_number} assigned to you: ${task.title}`;
      if (content.length > 100_000) {
        throw new LocalRequestError(400, "Task notification is too long");
      }
      notification = queryData({
        table: "messages",
        action: "insert",
        single: true,
        values: {
          channel_id: task.channel_id,
          sender_id: senderAgentId || LOCAL_USER_ID,
          sender_type: senderAgentId ? "agent" : "human",
          content,
        },
      }) as DbRow;
      if (senderAgentId) {
        const channel = db.prepare("SELECT server_id FROM channels WHERE id = ?").get(toSqlValue(task.channel_id)) as
          | { server_id: string }
          | undefined;
        if (!channel) throw new LocalRequestError(404, "Channel not found");
        queryData({
          table: "message_deliveries",
          action: "insert",
          single: true,
          values: {
            message_id: notification.id,
            agent_id: assignee.assigneeId,
            server_id: channel.server_id,
            channel_id: task.channel_id,
          },
        });
      }
    }
    return { task, notification };
  });
}

function localUpdateTaskStatus(argsValue: unknown) {
  const args = requireRpcArguments(argsValue, [
    "task_uuid",
    "task_status",
    "sender_agent_uuid",
    "expected_updated_at",
  ]);
  if (!("sender_agent_uuid" in args)) {
    throw new LocalRequestError(400, "sender_agent_uuid is required");
  }
  const taskId = rpcUuid(args.task_uuid, "task_uuid");
  const senderAgentId = rpcUuid(args.sender_agent_uuid, "sender_agent_uuid", true);
  const expectedUpdatedAt = rpcTimestamp(args.expected_updated_at, "expected_updated_at");
  if (
    args.task_status !== "todo" &&
    args.task_status !== "in_progress" &&
    args.task_status !== "in_review" &&
    args.task_status !== "done"
  ) {
    throw new LocalRequestError(400, "Invalid task status update");
  }
  return runAtomicMutationTransaction("task", () => {
    const currentTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as DbRow | undefined;
    const canUpdate = currentTask && (
      senderAgentId === null
        ? localMemberBelongsToChannel(String(currentTask.channel_id), LOCAL_USER_ID, "human")
        : localUserOwnsAgentInChannel(senderAgentId, String(currentTask.channel_id))
    );
    if (!currentTask || !canUpdate) throw new LocalRequestError(404, "Task not found");
    if (!timestampsMatch(currentTask.updated_at, expectedUpdatedAt)) {
      throw new LocalRequestError(409, "Task changed; refresh and retry");
    }
    if (currentTask.archived_at !== null) {
      throw new LocalRequestError(400, "Archived tasks cannot change status");
    }
    const task = queryData({
      table: "tasks",
      action: "update",
      single: true,
      values: { status: args.task_status },
      filters: [{ column: "id", operator: "eq", value: taskId }],
    }) as DbRow;
    return { task };
  });
}

function localClaimTask(argsValue: unknown) {
  const args = requireRpcArguments(argsValue, [
    "task_uuid",
    "sender_agent_uuid",
    "expected_updated_at",
  ]);
  const taskId = rpcUuid(args.task_uuid, "task_uuid");
  const senderAgentId = rpcUuid(args.sender_agent_uuid, "sender_agent_uuid");
  const expectedUpdatedAt = rpcTimestamp(args.expected_updated_at, "expected_updated_at");
  return runAtomicMutationTransaction("task", () => {
    const currentTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as DbRow | undefined;
    if (
      !currentTask ||
      !localUserOwnsAgentInChannel(senderAgentId, String(currentTask.channel_id))
    ) {
      throw new LocalRequestError(404, "Task not found");
    }
    if (
      !timestampsMatch(currentTask.updated_at, expectedUpdatedAt) ||
      currentTask.archived_at !== null ||
      currentTask.status === "done" ||
      (currentTask.assignee_id !== null &&
        (currentTask.assignee_id !== senderAgentId || currentTask.assignee_type !== "agent"))
    ) {
      throw new LocalRequestError(409, "Task changed or was claimed; refresh and retry");
    }
    const task = queryData({
      table: "tasks",
      action: "update",
      single: true,
      values: {
        assignee_id: senderAgentId,
        assignee_type: "agent",
        status: "in_progress",
      },
      filters: [{ column: "id", operator: "eq", value: taskId }],
    }) as DbRow;
    return { task };
  });
}

function localUnclaimTask(argsValue: unknown) {
  const args = requireRpcArguments(argsValue, [
    "task_uuid",
    "sender_agent_uuid",
    "expected_updated_at",
  ]);
  const taskId = rpcUuid(args.task_uuid, "task_uuid");
  const senderAgentId = rpcUuid(args.sender_agent_uuid, "sender_agent_uuid");
  const expectedUpdatedAt = rpcTimestamp(args.expected_updated_at, "expected_updated_at");
  return runAtomicMutationTransaction("task", () => {
    const currentTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as DbRow | undefined;
    if (
      !currentTask ||
      !localUserOwnsAgentInChannel(senderAgentId, String(currentTask.channel_id))
    ) {
      throw new LocalRequestError(404, "Task not found");
    }
    if (
      !timestampsMatch(currentTask.updated_at, expectedUpdatedAt) ||
      currentTask.archived_at !== null ||
      currentTask.assignee_id !== senderAgentId ||
      currentTask.assignee_type !== "agent"
    ) {
      throw new LocalRequestError(409, "Task assignment changed; refresh and retry");
    }
    const task = queryData({
      table: "tasks",
      action: "update",
      single: true,
      values: { assignee_id: null, assignee_type: null },
      filters: [{ column: "id", operator: "eq", value: taskId }],
    }) as DbRow;
    return { task };
  });
}

function localTaskActorCanAccessChannel(
  principal: LocalPrincipal,
  senderAgentId: string | null,
  channelId: string,
) {
  if (principal.kind === "human") {
    return senderAgentId === null &&
      principal.humanId === LOCAL_USER_ID &&
      localMemberBelongsToChannel(channelId, principal.humanId, "human");
  }
  if (senderAgentId !== principal.agentId) return false;
  const channel = db.prepare("SELECT server_id FROM channels WHERE id = ?").get(channelId) as
    | { server_id: string }
    | undefined;
  return channel?.server_id === principal.serverId &&
    localUserOwnsAgentInChannel(principal.agentId, channelId);
}

function localClaimMessageAsTask(argsValue: unknown, principal: LocalPrincipal) {
  const args = requireRpcArguments(argsValue, [
    "message_uuid",
    "sender_agent_uuid",
    "expected_message_updated_at",
  ]);
  const messageId = rpcUuid(args.message_uuid, "message_uuid");
  const senderAgentId = rpcUuid(args.sender_agent_uuid, "sender_agent_uuid");
  const expectedMessageUpdatedAt = rpcTimestamp(
    args.expected_message_updated_at,
    "expected_message_updated_at",
  );
  if (principal.kind !== "agent" || senderAgentId !== principal.agentId) {
    throw new LocalRequestError(403, "Agent authentication required");
  }

  return runAtomicMutationTransaction("task", () => {
    const message = db.prepare(
      `SELECT message.*, channel.server_id
         FROM messages message
         JOIN channels channel ON channel.id = message.channel_id
        WHERE message.id = ?`,
    ).get(messageId) as DbRow | undefined;
    if (
      !message ||
      message.server_id !== principal.serverId ||
      !localTaskActorCanAccessChannel(
        principal,
        senderAgentId,
        String(message.channel_id),
      )
    ) {
      throw new LocalRequestError(404, "Message not found");
    }
    if (message.thread_parent_id !== null) {
      throw new LocalRequestError(400, "Thread replies cannot become tasks");
    }
    if (message.sender_type === "system") {
      throw new LocalRequestError(400, "System messages cannot become tasks");
    }
    if (!timestampsMatch(message.updated_at, expectedMessageUpdatedAt)) {
      throw new LocalRequestError(409, "Message changed; refresh and retry");
    }

    const currentTask = db.prepare("SELECT * FROM tasks WHERE message_id = ?").get(messageId) as
      | DbRow
      | undefined;
    if (currentTask) {
      if (
        currentTask.archived_at !== null ||
        currentTask.status === "done" ||
        (currentTask.assignee_id !== null &&
          (currentTask.assignee_id !== senderAgentId || currentTask.assignee_type !== "agent"))
      ) {
        return {
          outcome: "conflict",
          created: false,
          claimed: false,
          task: currentTask,
        };
      }
      if (
        currentTask.assignee_id === senderAgentId &&
        currentTask.assignee_type === "agent" &&
        currentTask.status === "in_progress"
      ) {
        return {
          outcome: "already_claimed",
          created: false,
          claimed: false,
          task: currentTask,
        };
      }
      const task = queryData({
        table: "tasks",
        action: "update",
        single: true,
        values: {
          assignee_id: senderAgentId,
          assignee_type: "agent",
          status: "in_progress",
        },
        filters: [{ column: "id", operator: "eq", value: currentTask.id }],
      }) as DbRow;
      return {
        outcome: "claimed_existing",
        created: false,
        claimed: true,
        task,
      };
    }

    const title = String(message.content)
      .replaceAll("\r\n", "\n")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (!title) {
      throw new LocalRequestError(400, "Message has no task title");
    }
    const task = queryData({
      table: "tasks",
      action: "insert",
      single: true,
      values: {
        message_id: message.id,
        channel_id: message.channel_id,
        title: truncateTaskText(title, 500),
        status: "in_progress",
        assignee_id: senderAgentId,
        assignee_type: "agent",
      },
    }) as DbRow;
    return {
      outcome: "claimed_new",
      created: true,
      claimed: true,
      task,
    };
  });
}

function localUpdateTaskDetails(argsValue: unknown, principal: LocalPrincipal) {
  const args = requireRpcArguments(argsValue, [
    "task_uuid",
    "task_title",
    "task_description",
    "parent_task_uuid",
    "sender_agent_uuid",
    "expected_updated_at",
  ]);
  if (!("sender_agent_uuid" in args)) {
    throw new LocalRequestError(400, "sender_agent_uuid is required");
  }
  const taskId = rpcUuid(args.task_uuid, "task_uuid");
  const senderAgentId = rpcUuid(args.sender_agent_uuid, "sender_agent_uuid", true);
  const parentTaskId = rpcUuid(args.parent_task_uuid, "parent_task_uuid", true);
  const expectedUpdatedAt = rpcTimestamp(args.expected_updated_at, "expected_updated_at");
  const title = typeof args.task_title === "string" ? args.task_title.trim() : "";
  const description = args.task_description === null || args.task_description === undefined
    ? ""
    : typeof args.task_description === "string"
      ? args.task_description
      : null;
  if (!title || taskTextLength(title) > 500) {
    throw new LocalRequestError(400, "Invalid task title");
  }
  if (description === null || taskTextLength(description) > 100_000) {
    throw new LocalRequestError(400, "Invalid task details");
  }

  return runAtomicMutationTransaction("task", () => {
    const currentTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | DbRow
      | undefined;
    if (
      !currentTask ||
      !localTaskActorCanAccessChannel(
        principal,
        senderAgentId,
        String(currentTask.channel_id),
      )
    ) {
      throw new LocalRequestError(404, "Task not found");
    }
    if (!localRowExists(
      "SELECT 1 FROM messages WHERE id = ? AND channel_id = ?",
      toSqlValue(currentTask.message_id),
      toSqlValue(currentTask.channel_id),
    )) {
      throw new LocalRequestError(400, "Task message is missing");
    }
    if (!timestampsMatch(currentTask.updated_at, expectedUpdatedAt)) {
      throw new LocalRequestError(409, "Task changed; refresh and retry");
    }

    if (parentTaskId !== null) {
      if (parentTaskId === taskId) {
        throw new LocalRequestError(400, "A task cannot be its own parent");
      }
      const parentTask = db.prepare(
        "SELECT * FROM tasks WHERE id = ? AND channel_id = ?",
      ).get(parentTaskId, toSqlValue(currentTask.channel_id)) as DbRow | undefined;
      if (!parentTask) {
        throw new LocalRequestError(400, "Parent task must belong to the same channel");
      }
      if (
        currentTask.archived_at === null &&
        localRowExists(
          `WITH RECURSIVE ancestors(id, parent_task_id, archived_at) AS (
             SELECT id, parent_task_id, archived_at FROM tasks WHERE id = ?
             UNION
             SELECT task.id, task.parent_task_id, task.archived_at
               FROM tasks task
               JOIN ancestors child ON task.id = child.parent_task_id
           )
           SELECT 1 FROM ancestors WHERE archived_at IS NOT NULL`,
          parentTaskId,
        )
      ) {
        throw new LocalRequestError(400, "An active task cannot use an archived parent");
      }
      if (localRowExists(
        `WITH RECURSIVE ancestors(id, parent_task_id) AS (
           SELECT id, parent_task_id FROM tasks WHERE id = ?
           UNION
           SELECT task.id, task.parent_task_id
             FROM tasks task
             JOIN ancestors child ON task.id = child.parent_task_id
         )
         SELECT 1 FROM ancestors WHERE id = ?`,
        parentTaskId,
        taskId,
      )) {
        throw new LocalRequestError(400, "Task hierarchy cannot contain a cycle");
      }
    }

    if (
      currentTask.title === title &&
      currentTask.description === description &&
      (currentTask.parent_task_id ?? null) === parentTaskId
    ) {
      return { task: currentTask };
    }
    const task = queryData({
      table: "tasks",
      action: "update",
      single: true,
      values: {
        title,
        description,
        parent_task_id: parentTaskId,
      },
      filters: [{ column: "id", operator: "eq", value: taskId }],
    }) as DbRow;
    return { task };
  });
}

function localSetTaskArchived(argsValue: unknown, principal: LocalPrincipal) {
  const args = requireRpcArguments(argsValue, [
    "task_uuid",
    "archived",
    "sender_agent_uuid",
    "expected_updated_at",
  ]);
  if (!("sender_agent_uuid" in args)) {
    throw new LocalRequestError(400, "sender_agent_uuid is required");
  }
  const taskId = rpcUuid(args.task_uuid, "task_uuid");
  const senderAgentId = rpcUuid(args.sender_agent_uuid, "sender_agent_uuid", true);
  const expectedUpdatedAt = rpcTimestamp(args.expected_updated_at, "expected_updated_at");
  if (typeof args.archived !== "boolean") {
    throw new LocalRequestError(400, "Invalid task archive request");
  }
  const archived = args.archived;

  return runAtomicMutationTransaction("task", () => {
    const currentTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | DbRow
      | undefined;
    if (
      !currentTask ||
      !localTaskActorCanAccessChannel(
        principal,
        senderAgentId,
        String(currentTask.channel_id),
      )
    ) {
      throw new LocalRequestError(404, "Task not found");
    }
    if (!timestampsMatch(currentTask.updated_at, expectedUpdatedAt)) {
      throw new LocalRequestError(409, "Task changed; refresh and retry");
    }
    if (
      !archived &&
      localRowExists(
        `WITH RECURSIVE ancestors(id, parent_task_id, archived_at) AS (
           SELECT id, parent_task_id, archived_at FROM tasks WHERE id = ?
           UNION
           SELECT task.id, task.parent_task_id, task.archived_at
             FROM tasks task
             JOIN ancestors child ON task.id = child.parent_task_id
         )
         SELECT 1 FROM ancestors WHERE archived_at IS NOT NULL`,
        toSqlValue(currentTask.parent_task_id),
      )
    ) {
      throw new LocalRequestError(
        400,
        "Restore the archived ancestor before restoring this task",
      );
    }

    const descendants = db.prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM tasks WHERE id = ?
         UNION
         SELECT child.id
           FROM tasks child
           JOIN descendants parent ON child.parent_task_id = parent.id
          WHERE child.channel_id = ?
       )
       SELECT task.*
         FROM tasks task
         JOIN descendants ON descendants.id = task.id
        ORDER BY task.task_number`,
    ).all(taskId, toSqlValue(currentTask.channel_id)) as DbRow[];
    const updatedAt = nextMonotonicTimestamp(
      ...descendants.map((task) => task.updated_at),
    );
    const tasks = queryData({
      table: "tasks",
      action: "update",
      values: {
        archived_at: archived ? updatedAt : null,
        updated_at: updatedAt,
      },
      filters: [{
        column: "id",
        operator: "in",
        value: descendants.map((task) => task.id),
      }],
    }) as DbRow[];
    tasks.sort((left, right) => Number(left.task_number) - Number(right.task_number));
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new LocalRequestError(404, "Task not found");
    return { task, tasks, affected_count: descendants.length };
  });
}

function localDeleteArchivedTask(argsValue: unknown, principal: LocalPrincipal) {
  const args = requireRpcArguments(argsValue, ["task_uuid", "expected_updated_at"]);
  const taskId = rpcUuid(args.task_uuid, "task_uuid");
  const expectedUpdatedAt = rpcTimestamp(args.expected_updated_at, "expected_updated_at");
  if (principal.kind !== "human" || principal.humanId !== LOCAL_USER_ID) {
    throw new LocalRequestError(403, "Human authentication required");
  }

  return runAtomicMutationTransaction("task", () => {
    const currentTask = db.prepare(
      `SELECT task.*, channel.server_id
         FROM tasks task
         JOIN channels channel ON channel.id = task.channel_id
        WHERE task.id = ?`,
    ).get(taskId) as DbRow | undefined;
    if (
      !currentTask ||
      !localUserCanManageChannel(String(currentTask.channel_id)) ||
      !localRowExists(
        `SELECT 1 FROM server_members
          WHERE server_id = ?
            AND member_id = ?
            AND member_type = 'human'`,
        toSqlValue(currentTask.server_id),
        principal.humanId,
      )
    ) {
      throw new LocalRequestError(404, "Task not found");
    }
    if (!timestampsMatch(currentTask.updated_at, expectedUpdatedAt)) {
      throw new LocalRequestError(409, "Task changed; refresh and retry");
    }
    if (currentTask.archived_at === null) {
      throw new LocalRequestError(400, "Archive the task before deleting it");
    }
    if (localRowExists("SELECT 1 FROM tasks WHERE parent_task_id = ?", taskId)) {
      throw new LocalRequestError(400, "Delete or reparent child tasks first");
    }
    const task = queryData({
      table: "tasks",
      action: "delete",
      single: true,
      filters: [{ column: "id", operator: "eq", value: taskId }],
    }) as DbRow;
    return {
      deleted: true,
      task,
      message_id: currentTask.message_id,
    };
  });
}

function localTouchCurrentBridgeMachineKey(argsValue: unknown) {
  requireRpcArguments(argsValue, []);
  return runDatabaseTransaction(() => {
    const result = queryData({
      table: "machine_keys",
      action: "update",
      single: true,
      values: { last_used_at: new Date().toISOString() },
      filters: [{ column: "id", operator: "eq", value: LOCAL_KEY_ID }],
    }) as DbRow | null;
    if (!result) throw new LocalRequestError(403, "Bridge machine key is not active");
    return result.last_used_at;
  });
}

function localListChannelAgentMentions(argsValue: unknown) {
  const args = requireRpcArguments(argsValue, ["channel_uuid"]);
  const channelId = rpcUuid(args.channel_uuid, "channel_uuid");
  if (!localUserCanAccessChannel(channelId)) {
    throw new LocalRequestError(403, "Channel access denied");
  }
  const agents = db.prepare(
    `SELECT
       agent.id,
       agent.name,
       agent.display_name,
       agent.description,
       agent.avatar_url,
       agent.status,
       agent.owner_id = ? AS is_owner
       FROM channel_members channel_member
       JOIN channels channel ON channel.id = channel_member.channel_id
       JOIN agents agent
         ON agent.id = channel_member.member_id
        AND agent.server_id = channel.server_id
       JOIN server_members workspace_member
         ON workspace_member.server_id = channel.server_id
        AND workspace_member.member_id = agent.id
        AND workspace_member.member_type = 'agent'
      WHERE channel_member.channel_id = ?
        AND channel_member.member_type = 'agent'
      ORDER BY agent.name, agent.id`,
  ).all(LOCAL_USER_ID, channelId) as Array<DbRow & { is_owner: number }>;
  return agents.map((agent) => ({
    ...agent,
    is_owner: Boolean(agent.is_owner),
  }));
}

async function handleRpcRequest(
  request: IncomingMessage,
  response: ServerResponse,
  functionName: string,
  principal: LocalPrincipal,
) {
  const args = await readJson(request);
  authorizeLocalRpc(principal, functionName, args);
  let data: unknown;
  switch (functionName) {
    case "list_workspace_agent_directory":
      data = localListWorkspaceAgentDirectory(args);
      break;
    case "list_workspace_human_members":
      data = localListWorkspaceHumanMembers(args);
      break;
    case "list_workspace_human_directory":
      data = localListWorkspaceHumanDirectory(args);
      break;
    case "remove_server_human_member":
      data = localRemoveServerHumanMember(args);
      break;
    case "create_current_user_machine_key":
      data = localCreateCurrentUserMachineKey(args);
      break;
    case "create_channel_with_members":
      data = localCreateChannelWithMembers(args);
      break;
    case "set_channel_agent_members":
      data = localSetChannelAgentMembers(args);
      break;
    case "create_task_with_message":
      data = localCreateTaskWithMessage(args);
      break;
    case "assign_task_with_notification":
      data = localAssignTaskWithNotification(args);
      break;
    case "update_task_status":
      data = localUpdateTaskStatus(args);
      break;
    case "claim_task":
      data = localClaimTask(args);
      break;
    case "unclaim_task":
      data = localUnclaimTask(args);
      break;
    case "claim_message_as_task":
      data = localClaimMessageAsTask(args, principal);
      break;
    case "update_task_details":
      data = localUpdateTaskDetails(args, principal);
      break;
    case "set_task_archived":
      data = localSetTaskArchived(args, principal);
      break;
    case "delete_archived_task":
      data = localDeleteArchivedTask(args, principal);
      break;
    case "touch_current_bridge_machine_key":
      data = localTouchCurrentBridgeMachineKey(args);
      break;
    case "list_channel_agent_mentions":
      data = localListChannelAgentMentions(args);
      break;
    default:
      throw new LocalRequestError(404, "Unknown local RPC");
  }
  return sendJson(response, 200, { data, error: null, count: null });
}

function authorizeLocalRpc(
  principal: LocalPrincipal,
  functionName: string,
  argsValue: unknown,
) {
  if (principal.kind === "human") return;
  if (!argsValue || typeof argsValue !== "object" || Array.isArray(argsValue)) {
    throw new LocalRequestError(400, "RPC arguments must be an object");
  }
  const args = argsValue as Record<string, unknown>;
  const workspaceDirectoryFunctions = new Set([
    "list_workspace_agent_directory",
    "list_workspace_human_directory",
  ]);
  if (workspaceDirectoryFunctions.has(functionName)) {
    if (args.server_uuid !== principal.serverId) {
      throw new LocalRequestError(403, "Local capability is bound to another workspace");
    }
    return;
  }
  if (functionName === "list_channel_agent_mentions") {
    const channelId = rpcUuid(args.channel_uuid, "channel_uuid");
    if (!localMemberBelongsToChannel(channelId, principal.agentId, "agent")) {
      throw new LocalRequestError(403, "Channel access denied");
    }
    return;
  }

  const agentTaskFunctions = new Set([
    "create_task_with_message",
    "assign_task_with_notification",
    "update_task_status",
    "claim_task",
    "unclaim_task",
    "claim_message_as_task",
    "update_task_details",
    "set_task_archived",
  ]);
  if (agentTaskFunctions.has(functionName)) {
    if (args.sender_agent_uuid !== principal.agentId) {
      throw new LocalRequestError(403, "RPC agent identity does not match the local capability");
    }
    return;
  }

  throw new LocalRequestError(403, "This local RPC requires the human controller");
}

async function handleProfileRequest(request: IncomingMessage, response: ServerResponse) {
  const profile = db
    .prepare("SELECT id, email, display_name, avatar_url, created_at FROM profiles WHERE id = ?")
    .get(LOCAL_USER_ID) as DbRow | undefined;
  if (!profile) return sendJson(response, 404, { error: "Profile not found" });

  if (request.method === "GET") {
    return sendJson(response, 200, { profile });
  }
  if (request.method !== "PUT") {
    return sendJson(response, 405, { error: "Method not allowed" });
  }

  const body = (await readJson(request)) as Record<string, unknown>;
  const updates: DbRow = {};
  if (body.display_name !== undefined) {
    const displayName = String(body.display_name).trim();
    if (!displayName) {
      return sendJson(response, 400, { error: "display_name cannot be empty" });
    }
    if (displayName.length > 80) {
      return sendJson(response, 400, { error: "display_name must be 80 characters or fewer" });
    }
    updates.display_name = displayName;
  }

  if (body.avatar_data !== undefined) {
    try {
      updates.avatar_url = await persistAgentAvatar(LOCAL_USER_ID, body.avatar_data);
    } catch (error) {
      return sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid avatar image",
      });
    }
  } else if (body.avatar_url !== undefined) {
    const avatarUrl = normalizeAvatarUrl(body.avatar_url, LOCAL_USER_ID);
    if (avatarUrl === undefined) {
      return sendJson(response, 400, { error: "Unsupported avatar URL" });
    }
    updates.avatar_url = avatarUrl;
  }

  if (Object.keys(updates).length === 0) {
    return sendJson(response, 200, { profile });
  }

  const previousAvatarFile = avatarFilePath(profile.avatar_url);
  const updated = queryData({
    table: "profiles",
    action: "update",
    single: true,
    values: updates,
    filters: [{ column: "id", operator: "eq", value: LOCAL_USER_ID }],
  }) as DbRow;
  const nextAvatarFile = avatarFilePath(updated.avatar_url);
  if (previousAvatarFile && previousAvatarFile !== nextAvatarFile) {
    await removeAgentAvatarFile(profile.avatar_url);
  }

  return sendJson(response, 200, { profile: updated });
}

async function handleSettingsRequest(request: IncomingMessage, response: ServerResponse) {
  if (request.method === "GET") {
    return sendJson(response, 200, { settings: readAppSettings() });
  }

  if (request.method !== "PUT") {
    return sendJson(response, 405, { error: "Method not allowed" });
  }

  const body = (await readJson(request)) as {
    language?: string;
    theme?: string;
    defaultRuntime?: string;
    defaultModel?: string;
    defaultConnectionId?: string | null;
    defaultThinkingLevel?: string;
    showActivityDetails?: boolean;
    messageSounds?: boolean;
  };
  const updates: Array<[string, string]> = [];

  if (body.language !== undefined) {
    if (!["zh-CN", "en-US"].includes(body.language)) {
      return sendJson(response, 400, { error: "Unsupported language" });
    }
    updates.push(["language", body.language]);
  }
  if (body.theme !== undefined) {
    if (!["system", "light", "dark"].includes(body.theme)) {
      return sendJson(response, 400, { error: "Unsupported theme" });
    }
    updates.push(["theme", body.theme]);
  }
  if (body.showActivityDetails !== undefined) {
    if (typeof body.showActivityDetails !== "boolean") {
      return sendJson(response, 400, { error: "Invalid activity detail setting" });
    }
    updates.push(["show_activity_details", String(body.showActivityDetails)]);
  }
  if (body.messageSounds !== undefined) {
    if (typeof body.messageSounds !== "boolean") {
      return sendJson(response, 400, { error: "Invalid message sound setting" });
    }
    updates.push(["message_sounds", String(body.messageSounds)]);
  }
  if (body.defaultThinkingLevel !== undefined) {
    if (!isThinkingLevel(body.defaultThinkingLevel)) {
      return sendJson(response, 400, { error: "Unsupported thinking level" });
    }
    updates.push(["default_thinking_level", body.defaultThinkingLevel]);
  }
  if (
    body.defaultRuntime !== undefined ||
    body.defaultModel !== undefined ||
    body.defaultConnectionId !== undefined
  ) {
    const current = readAppSettings();
    const runtime = body.defaultRuntime ?? current.defaultRuntime;
    const resolved = await resolveLocalAgentRuntimeSelection({
      runtime,
      model: body.defaultModel !== undefined
        ? body.defaultModel
        : body.defaultRuntime !== undefined || body.defaultConnectionId !== undefined
          ? undefined
          : current.defaultModel,
      connectionId: body.defaultConnectionId !== undefined
        ? body.defaultConnectionId
        : current.defaultConnectionId,
    });
    if ("error" in resolved) {
      return sendJson(response, 400, { error: resolved.error });
    }
    updates.push(["default_runtime", resolved.selection.runtime]);
    updates.push(["default_model", resolved.selection.model]);
    updates.push(["default_connection_id", resolved.selection.connectionId || ""]);
  }

  const upsert = db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const now = new Date().toISOString();
  for (const [key, value] of updates) upsert.run(key, value, now);

  return sendJson(response, 200, { settings: readAppSettings() });
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
    runtime?: string;
    model?: string;
    connection_id?: string | null;
    thinking_level?: string;
    server_id?: string;
  };
  const displayName = body.display_name?.trim();
  if (!displayName || !body.server_id) {
    return sendJson(response, 400, { error: "display_name and server_id are required" });
  }
  const serverMembership = db
    .prepare(
      `SELECT s.id
       FROM servers s
       JOIN server_members sm
         ON sm.server_id = s.id
        AND sm.member_id = ?
        AND sm.member_type = 'human'
       WHERE s.id = ?`,
    )
    .get(LOCAL_USER_ID, body.server_id);
  if (!serverMembership) {
    return sendJson(response, 404, { error: "Workspace not found" });
  }

  const baseName =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "agent";
  const settings = readAppSettings();
  const requestedRuntime = body.runtime === undefined
    ? settings.defaultRuntime
    : normalizeRuntime(body.runtime);
  if (body.runtime !== undefined && !isAgentRuntime(body.runtime)) {
    return sendJson(response, 400, { error: "Unsupported agent runtime" });
  }
  const resolved = await resolveLocalAgentRuntimeSelection({
    runtime: requestedRuntime,
    model: body.model !== undefined
      ? body.model
      : body.runtime !== undefined || body.connection_id !== undefined
        ? undefined
        : settings.defaultModel,
    connectionId: body.connection_id !== undefined
      ? body.connection_id
      : settings.defaultConnectionId,
  });
  if ("error" in resolved) {
    return sendJson(response, 400, { error: resolved.error });
  }
  const { runtime, model, connectionId } = resolved.selection;
  const thinkingLevel = body.thinking_level === undefined
    ? settings.defaultThinkingLevel
    : isThinkingLevel(body.thinking_level)
      ? body.thinking_level
      : null;
  if (!thinkingLevel) {
    return sendJson(response, 400, { error: "Unsupported thinking level" });
  }
  try {
    const { agent, channel } = runAtomicMutationTransaction("agent", () => {
      const agent = queryData({
        table: "agents",
        action: "insert",
        single: true,
        values: {
          name: `${baseName}-${randomUUID().slice(0, 8)}`,
          display_name: displayName,
          description: body.description?.trim() || null,
          system_prompt: body.system_prompt?.trim() || null,
          runtime,
          model,
          thinking_level: thinkingLevel,
          connection_id: connectionId,
          status: "offline",
          owner_id: LOCAL_USER_ID,
          server_id: body.server_id,
        },
      }) as DbRow;
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
      return { agent, channel };
    });
    return sendJson(response, 200, { agent, channel });
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed:\s*channels\.server_id,\s*channels\.name/i.test(error.message)
    ) {
      return sendJson(response, 409, { error: "A direct-message channel with this name already exists" });
    }
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
         WHERE cm.member_id = ? AND cm.member_type = 'agent'
           AND c.type = 'dm' AND c.server_id = ?`,
      )
      .all(agentId, toSqlValue(agent.server_id)) as Array<{ channel_id: string }>;
    const messagesDeleted = runDatabaseTransaction(() => {
      let deletedCount = 0;
      for (const membership of memberships) {
        const result = executeQuery({
          table: "messages",
          action: "delete",
          filters: [{ column: "channel_id", operator: "eq", value: membership.channel_id }],
        });
        deletedCount += result.count || 0;
      }
      executeQuery({
        table: "agents",
        action: "update",
        values: {
          session_id: null,
          runtime_session_id: null,
          runtime_session_runtime: null,
        },
        filters: [{ column: "id", operator: "eq", value: agentId }],
      });
      return deletedCount;
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
    if (body.thinking_level !== undefined) {
      if (!isThinkingLevel(body.thinking_level)) {
        return sendJson(response, 400, { error: "Unsupported thinking level" });
      }
      updates.thinking_level = body.thinking_level;
    }
    if (body.avatar_data !== undefined) {
      try {
        updates.avatar_url = await persistAgentAvatar(agentId, body.avatar_data);
      } catch (error) {
        return sendJson(response, 400, {
          error: error instanceof Error ? error.message : "Invalid avatar image",
        });
      }
    } else if (body.avatar_url !== undefined) {
      const avatarUrl = normalizeAvatarUrl(body.avatar_url, agentId);
      if (avatarUrl === undefined) {
        return sendJson(response, 400, { error: "Unsupported avatar URL" });
      }
      updates.avatar_url = avatarUrl;
    }
    const currentRuntime = normalizeRuntime(agent.runtime);
    if (
      body.runtime !== undefined ||
      body.model !== undefined ||
      body.connection_id !== undefined
    ) {
      const nextRuntime = body.runtime === undefined ? currentRuntime : body.runtime;
      const resolved = await resolveLocalAgentRuntimeSelection({
        runtime: nextRuntime,
        model: body.model !== undefined
          ? body.model
          : body.runtime !== undefined || body.connection_id !== undefined
            ? undefined
            : agent.model,
        connectionId: body.connection_id !== undefined
          ? body.connection_id
          : agent.connection_id,
      });
      if ("error" in resolved) {
        return sendJson(response, 400, { error: resolved.error });
      }
      updates.runtime = resolved.selection.runtime;
      updates.model = resolved.selection.model;
      updates.connection_id = resolved.selection.connectionId;
      if (resolved.selection.runtime !== currentRuntime) {
        updates.session_id = null;
        updates.runtime_session_id = null;
        updates.runtime_session_runtime = null;
      }
    }
    const updated = queryData({
      table: "agents",
      action: "update",
      values: updates,
      single: true,
      filters: [{ column: "id", operator: "eq", value: agentId }],
    });
    const previousAvatarFile = avatarFilePath(agent.avatar_url);
    const nextAvatarFile = avatarFilePath((updated as DbRow).avatar_url);
    if (previousAvatarFile && previousAvatarFile !== nextAvatarFile) {
      await removeAgentAvatarFile(agent.avatar_url);
    }
    return sendJson(response, 200, { agent: updated });
  }

  if (request.method === "DELETE") {
    runAtomicMutationTransaction("agent", () => {
      executeQuery({
        table: "agents",
        action: "delete",
        filters: [{ column: "id", operator: "eq", value: agentId }],
      });
    });
    deleteAgentCapabilities(agentId);
    await removeAgentAvatarFile(agent.avatar_url);
    return sendJson(response, 200, { success: true });
  }

  return sendJson(response, 405, { error: "Method not allowed" });
}

async function readAgentWorkspace(agent: DbRow, requestedFile: string | null) {
  const configuredRoot =
    typeof agent.workspace_path === "string" && agent.workspace_path
      ? agent.workspace_path
      : join(process.env.TEAMMATE_AGENTS_DIR || ".teammate/agents", String(agent.id));
  const workspaceRoot = resolve(configuredRoot);
  const emptyWorkspace = {
    workspace_path: workspaceRoot,
    files: [] as WorkspaceFileEntry[],
    notes_files: [] as WorkspaceFileEntry[],
  };

  if (requestedFile) {
    const segments = workspacePathSegments(requestedFile);
    const workspaceRealRoot = await resolveWorkspaceRoot(workspaceRoot, false);
    const requestedPath = resolve(workspaceRealRoot, ...segments);
    if (!isWithinWorkspace(workspaceRealRoot, requestedPath)) {
      throw new LocalRequestError(400, "Invalid workspace file path");
    }

    let currentPath = workspaceRealRoot;
    let targetInfo: Awaited<ReturnType<typeof lstat>> | null = null;
    for (const [index, segment] of segments.entries()) {
      currentPath = join(currentPath, segment);
      try {
        targetInfo = await lstat(currentPath);
      } catch (error) {
        if (isMissingPathError(error)) {
          throw new LocalRequestError(404, "Workspace file not found");
        }
        throw error;
      }
      if (targetInfo.isSymbolicLink()) {
        throw new LocalRequestError(400, "Workspace symlinks cannot be opened");
      }
      if (index < segments.length - 1 && !targetInfo.isDirectory()) {
        throw new LocalRequestError(400, "Invalid workspace file path");
      }
    }

    if (!targetInfo?.isFile()) {
      throw new LocalRequestError(400, "Workspace path is not a regular file");
    }

    const requestedRealPath = await realpath(currentPath);
    if (!isWithinWorkspace(workspaceRealRoot, requestedRealPath)) {
      throw new LocalRequestError(400, "Invalid workspace file path");
    }
    if (targetInfo.size > MAX_WORKSPACE_FILE_BYTES) {
      throw new LocalRequestError(413, "Workspace file is too large to open");
    }

    const contents = await readFile(requestedRealPath);
    if (contents.length > MAX_WORKSPACE_FILE_BYTES) {
      throw new LocalRequestError(413, "Workspace file is too large to open");
    }
    return { file: requestedFile, content: decodeWorkspaceText(contents) };
  }

  let workspaceRealRoot: string;
  try {
    workspaceRealRoot = await resolveWorkspaceRoot(workspaceRoot, true);
  } catch (error) {
    if (isMissingPathError(error)) return emptyWorkspace;
    throw error;
  }

  const files = await listWorkspaceDirectory(workspaceRealRoot);
  const notesPath = join(workspaceRealRoot, "notes");
  let notesFiles: WorkspaceFileEntry[] = [];
  try {
    const notesInfo = await lstat(notesPath);
    if (notesInfo.isDirectory() && !notesInfo.isSymbolicLink()) {
      notesFiles = await listWorkspaceDirectory(workspaceRealRoot, "notes");
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  return { workspace_path: workspaceRoot, files, notes_files: notesFiles };
}

interface WorkspaceFileEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  modified: string;
}

function workspacePathSegments(requestedFile: string) {
  if (requestedFile.includes("\0") || isAbsolute(requestedFile)) {
    throw new LocalRequestError(400, "Invalid workspace file path");
  }
  const segments = requestedFile.split(/[\\/]+/);
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === ".." || segment.startsWith("."))
  ) {
    throw new LocalRequestError(400, "Invalid workspace file path");
  }
  return segments;
}

async function resolveWorkspaceRoot(workspaceRoot: string, allowMissing: boolean) {
  let workspaceRealRoot: string;
  try {
    workspaceRealRoot = await realpath(workspaceRoot);
  } catch (error) {
    if (allowMissing && isMissingPathError(error)) throw error;
    if (isMissingPathError(error)) {
      throw new LocalRequestError(404, "Agent workspace not found");
    }
    throw error;
  }
  const rootInfo = await lstat(workspaceRealRoot);
  if (!rootInfo.isDirectory()) {
    throw new LocalRequestError(404, "Agent workspace not found");
  }
  return workspaceRealRoot;
}

function isWithinWorkspace(workspaceRealRoot: string, targetPath: string) {
  const relativePath = relative(workspaceRealRoot, targetPath);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  );
}

async function listWorkspaceDirectory(
  workspaceRealRoot: string,
  directoryName?: string,
) {
  const directoryPath = directoryName
    ? join(workspaceRealRoot, directoryName)
    : workspaceRealRoot;
  const directoryRealPath = await realpath(directoryPath);
  if (!isWithinWorkspace(workspaceRealRoot, directoryRealPath)) {
    throw new LocalRequestError(400, "Invalid workspace directory");
  }

  const entries: WorkspaceFileEntry[] = [];
  for (const name of (await readdir(directoryRealPath)).sort()) {
    if (!name || name.startsWith(".")) continue;
    const entryPath = join(directoryRealPath, name);
    let entryInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      entryInfo = await lstat(entryPath);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    if (entryInfo.isSymbolicLink()) continue;
    if (!entryInfo.isFile() && !entryInfo.isDirectory()) continue;
    if (entryInfo.isFile() && entryInfo.size > MAX_WORKSPACE_FILE_BYTES) continue;
    entries.push({
      name: directoryName ? `${directoryName}/${name}` : name,
      type: entryInfo.isDirectory() ? "directory" : "file",
      size: entryInfo.size,
      modified: entryInfo.mtime.toISOString(),
    });
  }
  return entries;
}

function decodeWorkspaceText(contents: Buffer) {
  if (contents.includes(0)) {
    throw new LocalRequestError(415, "Workspace file is not plain text");
  }
  const sampleLength = Math.min(contents.length, 8192);
  let controlBytes = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = contents[index];
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controlBytes += 1;
  }
  if (controlBytes > Math.max(2, Math.floor(sampleLength * 0.01))) {
    throw new LocalRequestError(415, "Workspace file is not plain text");
  }
  try {
    return workspaceTextDecoder.decode(contents);
  } catch {
    throw new LocalRequestError(415, "Workspace file must be UTF-8 text");
  }
}

function isMissingPathError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function listLocalSkills(runtime: AgentRuntime) {
  const skills: Array<{ name: string; description: string }> = [];
  const skillsRoot = join(
    homedir(),
    runtime === "codex" ? ".codex" : runtime === "pi" ? ".pi" : ".claude",
    ...(runtime === "pi" ? ["agent", "skills"] : ["skills"]),
  );
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
    // Runtime skills are optional.
  }
  return { skills };
}

function queryData(query: QueryRequest) {
  return executeQuery(query).data;
}

function runDatabaseTransaction<T>(operation: () => T): T {
  if (databaseTransactionActive) {
    throw new Error("Nested database transactions are not supported");
  }

  const previousEventCount = emittedEventsSincePrune;
  databaseTransactionActive = true;
  transactionHasEvents = false;
  let transactionStarted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const result = operation();
    db.exec("COMMIT");
    transactionStarted = false;
    const shouldWakeEventWaiters = transactionHasEvents;
    databaseTransactionActive = false;
    transactionHasEvents = false;
    if (shouldWakeEventWaiters) wakeEventWaiters();
    return result;
  } catch (error) {
    try {
      if (transactionStarted) db.exec("ROLLBACK");
    } finally {
      emittedEventsSincePrune = previousEventCount;
      databaseTransactionActive = false;
      transactionHasEvents = false;
    }
    throw error;
  }
}

function runAtomicMutationTransaction<T>(
  scope: AtomicMutationScope,
  operation: () => T,
): T {
  if (atomicMutationScope) {
    throw new Error("Nested atomic mutation scopes are not supported");
  }
  atomicMutationScope = scope;
  try {
    return runDatabaseTransaction(operation);
  } finally {
    atomicMutationScope = null;
  }
}

function localRowExists(sql: string, ...params: SQLInputValue[]) {
  return Boolean(db.prepare(sql).get(...params));
}

function localValue(row: DbRow, column: string) {
  const value = row[column];
  return typeof value === "string" ? value : "";
}

function requireLocalInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LocalRequestError(400, message);
}

function requireImmutableFields(
  table: TableName,
  previous: DbRow,
  next: DbRow,
  fields: string[],
) {
  for (const field of fields) {
    if ((previous[field] ?? null) !== (next[field] ?? null)) {
      throw new LocalRequestError(400, `${table}.${field} is immutable`);
    }
  }
}

function localUserCanAccessServer(serverId: string) {
  return localRowExists(
    `SELECT 1
       FROM servers server
      WHERE server.id = ?
        AND (
          server.owner_id = ?
          OR EXISTS (
            SELECT 1 FROM server_members member
             WHERE member.server_id = server.id
               AND member.member_id = ?
               AND member.member_type = 'human'
          )
        )`,
    serverId,
    LOCAL_USER_ID,
    LOCAL_USER_ID,
  );
}

function localUserCanManageChannel(channelId: string) {
  return localRowExists(
    `SELECT 1
       FROM channels channel
       JOIN servers workspace ON workspace.id = channel.server_id
      WHERE channel.id = ?
        AND (
          workspace.owner_id = ?
          OR EXISTS (
            SELECT 1
              FROM server_members member
              JOIN profiles profile ON profile.id = member.member_id
             WHERE member.server_id = channel.server_id
               AND member.member_id = ?
               AND member.member_type = 'human'
               AND (member.role IN ('owner', 'admin') OR channel.created_by = ?)
          )
        )`,
    channelId,
    LOCAL_USER_ID,
    LOCAL_USER_ID,
    LOCAL_USER_ID,
  );
}

function localUserCanAccessChannel(channelId: string) {
  if (localMemberBelongsToChannel(channelId, LOCAL_USER_ID, "human")) {
    return true;
  }
  return localRowExists(
    `SELECT 1
       FROM channels channel
       JOIN servers workspace ON workspace.id = channel.server_id
       JOIN channel_members channel_member
         ON channel_member.channel_id = channel.id
        AND channel_member.member_type = 'agent'
       JOIN agents agent
         ON agent.id = channel_member.member_id
        AND agent.server_id = channel.server_id
        AND agent.owner_id = ?
       JOIN server_members agent_membership
         ON agent_membership.server_id = channel.server_id
        AND agent_membership.member_id = agent.id
        AND agent_membership.member_type = 'agent'
      WHERE channel.id = ?
        AND (
          workspace.owner_id = ?
          OR EXISTS (
            SELECT 1
              FROM server_members owner_membership
             WHERE owner_membership.server_id = channel.server_id
               AND owner_membership.member_id = ?
               AND owner_membership.member_type = 'human'
          )
        )`,
    LOCAL_USER_ID,
    channelId,
    LOCAL_USER_ID,
    LOCAL_USER_ID,
  );
}

function localUserOwnsAgentInChannel(agentId: string, channelId: string) {
  return localRowExists(
    `SELECT 1
       FROM channels channel
       JOIN servers workspace ON workspace.id = channel.server_id
       JOIN channel_members channel_member
         ON channel_member.channel_id = channel.id
        AND channel_member.member_id = ?
        AND channel_member.member_type = 'agent'
       JOIN agents agent
         ON agent.id = channel_member.member_id
        AND agent.server_id = channel.server_id
        AND agent.owner_id = ?
       JOIN server_members agent_membership
         ON agent_membership.server_id = channel.server_id
        AND agent_membership.member_id = agent.id
        AND agent_membership.member_type = 'agent'
      WHERE channel.id = ?
        AND (
          workspace.owner_id = ?
          OR EXISTS (
            SELECT 1
              FROM server_members owner_membership
             WHERE owner_membership.server_id = channel.server_id
               AND owner_membership.member_id = ?
               AND owner_membership.member_type = 'human'
          )
        )`,
    agentId,
    LOCAL_USER_ID,
    channelId,
    LOCAL_USER_ID,
    LOCAL_USER_ID,
  );
}

function localMemberBelongsToChannel(
  channelId: string,
  memberId: string,
  memberType: string,
) {
  if (memberType === "human") {
    return localRowExists(
      `SELECT 1
         FROM channels channel
         JOIN channel_members channel_member
           ON channel_member.channel_id = channel.id
          AND channel_member.member_id = ?
          AND channel_member.member_type = 'human'
         JOIN server_members workspace_member
           ON workspace_member.server_id = channel.server_id
          AND workspace_member.member_id = channel_member.member_id
          AND workspace_member.member_type = 'human'
         JOIN profiles profile ON profile.id = channel_member.member_id
        WHERE channel.id = ?`,
      memberId,
      channelId,
    );
  }
  if (memberType === "agent") {
    return localRowExists(
      `SELECT 1
         FROM channels channel
         JOIN channel_members channel_member
           ON channel_member.channel_id = channel.id
          AND channel_member.member_id = ?
          AND channel_member.member_type = 'agent'
         JOIN agents agent
           ON agent.id = channel_member.member_id
          AND agent.server_id = channel.server_id
         JOIN server_members workspace_member
           ON workspace_member.server_id = channel.server_id
          AND workspace_member.member_id = agent.id
          AND workspace_member.member_type = 'agent'
        WHERE channel.id = ?`,
      memberId,
      channelId,
    );
  }
  return false;
}

function validateLocalMutation(table: TableName, row: DbRow, previous?: DbRow) {
  if (table === "servers") {
    requireLocalInvariant(localValue(row, "owner_id") === LOCAL_USER_ID, "Workspace owner is invalid");
    if (previous) requireImmutableFields(table, previous, row, ["owner_id"]);
    else requireLocalInvariant(atomicMutationScope === "server", "Create workspaces through the workspace API");
    return;
  }

  if (table === "server_members") {
    if (previous) {
      requireImmutableFields(table, previous, row, ["server_id", "member_id", "member_type"]);
    }
    const serverId = localValue(row, "server_id");
    const memberId = localValue(row, "member_id");
    const memberType = localValue(row, "member_type");
    const role = localValue(row, "role") || "member";
    requireLocalInvariant(["owner", "admin", "member"].includes(role), "Invalid workspace role");
    if (memberType === "human") {
      if (!previous) {
        requireLocalInvariant(
          atomicMutationScope === "server",
          "Create workspace memberships through the workspace API",
        );
      }
      requireLocalInvariant(
        memberId === LOCAL_USER_ID &&
          localRowExists("SELECT 1 FROM profiles WHERE id = ?", memberId) &&
          localRowExists("SELECT 1 FROM servers WHERE id = ?", serverId),
        "Human member does not belong to this workspace",
      );
      if (role === "owner") {
        requireLocalInvariant(
          localRowExists("SELECT 1 FROM servers WHERE id = ? AND owner_id = ?", serverId, memberId),
          "Only the workspace owner can have the owner role",
        );
      }
    } else if (memberType === "agent") {
      if (!previous) {
        requireLocalInvariant(
          atomicMutationScope === "agent",
          "Register agents through the agent API",
        );
      }
      requireLocalInvariant(role === "member", "Agent workspace role must be member");
      requireLocalInvariant(
        localRowExists(
          "SELECT 1 FROM agents WHERE id = ? AND server_id = ? AND owner_id = ?",
          memberId,
          serverId,
          LOCAL_USER_ID,
        ),
        "Agent member does not belong to this workspace",
      );
    } else {
      throw new LocalRequestError(400, "Invalid workspace member type");
    }
    return;
  }

  if (table === "agents") {
    if (previous) {
      requireImmutableFields(table, previous, row, ["owner_id", "server_id"]);
    } else {
      requireLocalInvariant(atomicMutationScope === "agent", "Create agents through the agent API");
      requireLocalInvariant(localValue(row, "owner_id") === LOCAL_USER_ID, "Agent owner is invalid");
      requireLocalInvariant(
        localUserCanAccessServer(localValue(row, "server_id")),
        "Agent workspace access denied",
      );
    }
    requireLocalInvariant(
      ["claude-code", "codex", "pi"].includes(localValue(row, "runtime")),
      "Invalid agent runtime",
    );
    requireLocalInvariant(
      ["online", "sleeping", "offline"].includes(localValue(row, "status")),
      "Invalid agent status",
    );
    return;
  }

  if (table === "channels") {
    if (previous) {
      requireLocalInvariant(
        atomicMutationScope === "channel",
        "Update channels through the atomic channel API",
      );
      requireImmutableFields(table, previous, row, ["server_id", "created_by", "type"]);
    } else {
      const channelType = localValue(row, "type");
      requireLocalInvariant(
        channelType === "dm"
          ? atomicMutationScope === "agent"
          : atomicMutationScope === "channel" || atomicMutationScope === "server",
        "Create channels through the atomic channel API",
      );
      requireLocalInvariant(localValue(row, "created_by") === LOCAL_USER_ID, "Channel creator is invalid");
      requireLocalInvariant(
        localUserCanAccessServer(localValue(row, "server_id")),
        "Channel workspace access denied",
      );
    }
    requireLocalInvariant(
      ["public", "private", "dm"].includes(localValue(row, "type")),
      "Invalid channel type",
    );
    return;
  }

  if (table === "channel_members") {
    if (previous) {
      requireImmutableFields(table, previous, row, ["channel_id", "member_id", "member_type"]);
      return;
    }
    const channelId = localValue(row, "channel_id");
    const memberId = localValue(row, "member_id");
    const memberType = localValue(row, "member_type");
    const channel = db.prepare("SELECT server_id, type FROM channels WHERE id = ?").get(channelId) as
      | { server_id: string; type: string }
      | undefined;
    requireLocalInvariant(channel, "Channel not found");
    if (memberType === "human") {
      requireLocalInvariant(
        atomicMutationScope !== null ||
          (memberId === LOCAL_USER_ID && channel.type === "public"),
        "Only public channels support direct human self-join",
      );
      requireLocalInvariant(
        memberId === LOCAL_USER_ID && localRowExists(
          `SELECT 1 FROM server_members
            WHERE server_id = ? AND member_id = ? AND member_type = 'human'`,
          channel.server_id,
          memberId,
        ),
        "Human channel member does not belong to this workspace",
      );
    } else if (memberType === "agent") {
      requireLocalInvariant(
        atomicMutationScope === "agent" || atomicMutationScope === "channel",
        "Change agent channel members through the atomic channel API",
      );
      requireLocalInvariant(
        localRowExists(
          `SELECT 1
             FROM agents agent
             JOIN server_members member
               ON member.server_id = agent.server_id
              AND member.member_id = agent.id
              AND member.member_type = 'agent'
            WHERE agent.id = ? AND agent.server_id = ?`,
          memberId,
          channel.server_id,
        ),
        "Agent channel member does not belong to this workspace",
      );
    } else {
      throw new LocalRequestError(400, "Invalid channel member type");
    }
    return;
  }

  if (table === "messages") {
    if (previous) {
      requireImmutableFields(table, previous, row, ["channel_id", "sender_id", "sender_type", "seq"]);
    }
    const channelId = localValue(row, "channel_id");
    const senderId = localValue(row, "sender_id");
    const senderType = localValue(row, "sender_type");
    if (!previous && senderType === "system") {
      requireLocalInvariant(
        atomicMutationScope === "task",
        "System messages are created only by the atomic task API",
      );
    }
    requireLocalInvariant(
      (senderType === "agent" && localMemberBelongsToChannel(channelId, senderId, "agent")) ||
        ((senderType === "human" || senderType === "system") &&
          senderId === LOCAL_USER_ID &&
          localMemberBelongsToChannel(channelId, senderId, "human")),
      "Message sender is not a valid channel member",
    );
    const content = localValue(row, "content");
    requireLocalInvariant(content.trim().length > 0 && content.length <= 100_000, "Invalid message content");
    const parentId = row.thread_parent_id;
    if (parentId !== null && parentId !== undefined) {
      requireLocalInvariant(
        parentId !== row.id && localRowExists(
          "SELECT 1 FROM messages WHERE id = ? AND channel_id = ?",
          toSqlValue(parentId),
          channelId,
        ),
        "Thread parent must belong to the same channel",
      );
    }
    return;
  }

  if (table === "message_deliveries") {
    if (previous) {
      requireImmutableFields(table, previous, row, [
        "message_id",
        "agent_id",
        "server_id",
        "channel_id",
      ]);
      return;
    }
    requireLocalInvariant(
      atomicMutationScope === "task",
      "Message deliveries are created only by the task notification API",
    );
    requireLocalInvariant(
      localRowExists(
        `SELECT 1
           FROM messages message
           JOIN channels channel
             ON channel.id = message.channel_id
            AND channel.id = ?
            AND channel.server_id = ?
           JOIN agents agent
             ON agent.id = ?
            AND agent.server_id = channel.server_id
           JOIN channel_members channel_member
             ON channel_member.channel_id = channel.id
            AND channel_member.member_id = agent.id
            AND channel_member.member_type = 'agent'
           JOIN server_members workspace_member
             ON workspace_member.server_id = channel.server_id
            AND workspace_member.member_id = agent.id
            AND workspace_member.member_type = 'agent'
          WHERE message.id = ?`,
        localValue(row, "channel_id"),
        localValue(row, "server_id"),
        localValue(row, "agent_id"),
        localValue(row, "message_id"),
      ),
      "Message delivery must stay inside one agent channel workspace",
    );
    return;
  }

  if (table === "tasks") {
    const channelId = localValue(row, "channel_id");
    if (previous) {
      requireLocalInvariant(
        atomicMutationScope === "task" ||
          atomicMutationScope === "channel" ||
          atomicMutationScope === "agent" ||
          atomicMutationScope === "membership",
        "Update tasks through the actor-scoped task API",
      );
      requireImmutableFields(table, previous, row, ["message_id", "channel_id", "task_number"]);
      requireLocalInvariant(
        typeof row.updated_at === "string" &&
          typeof previous.updated_at === "string" &&
          Date.parse(row.updated_at) > Date.parse(previous.updated_at),
        "Task updated_at must advance monotonically",
      );
    } else {
      requireLocalInvariant(
        atomicMutationScope === "task",
        "Create tasks through the atomic task API",
      );
      requireLocalInvariant(
        localRowExists(
          "SELECT 1 FROM messages WHERE id = ? AND channel_id = ?",
          toSqlValue(row.message_id),
          channelId,
        ),
        "Task message must belong to the same channel",
      );
    }
    requireLocalInvariant(
      ["todo", "in_progress", "in_review", "done"].includes(localValue(row, "status")),
      "Invalid task status",
    );
    const title = localValue(row, "title").trim();
    requireLocalInvariant(
      taskTextLength(title) >= 1 && taskTextLength(title) <= 500,
      "Invalid task title",
    );
    requireLocalInvariant(
      typeof row.description === "string" && taskTextLength(row.description) <= 100_000,
      "Invalid task description",
    );
    requireLocalInvariant(
      row.archived_at === null ||
        row.archived_at === undefined ||
        (typeof row.archived_at === "string" && Number.isFinite(Date.parse(row.archived_at))),
      "Invalid task archive timestamp",
    );

    const parentChanged = !previous || (previous.parent_task_id ?? null) !== (row.parent_task_id ?? null);
    if (parentChanged && row.parent_task_id !== null && row.parent_task_id !== undefined) {
      requireLocalInvariant(
        row.parent_task_id !== row.id && localRowExists(
          `SELECT 1 FROM tasks
            WHERE id = ?
              AND channel_id = ?
              AND (? IS NOT NULL OR archived_at IS NULL)`,
          toSqlValue(row.parent_task_id),
          channelId,
          toSqlValue(row.archived_at),
        ),
        "Parent task must belong to the same channel and an active task cannot use an archived parent",
      );
      if (previous) {
        requireLocalInvariant(
          !localRowExists(
            `WITH RECURSIVE lineage(id, parent_task_id) AS (
               SELECT id, parent_task_id FROM tasks WHERE id = ?
               UNION
               SELECT task.id, task.parent_task_id
                 FROM tasks task
                 JOIN lineage ancestor ON task.id = ancestor.parent_task_id
             )
             SELECT 1 FROM lineage WHERE id = ?`,
            toSqlValue(row.parent_task_id),
            toSqlValue(row.id),
          ),
          "Task hierarchy cannot contain a cycle",
        );
      }
    }

    const assigneeChanged = !previous ||
      (previous.assignee_id ?? null) !== (row.assignee_id ?? null) ||
      (previous.assignee_type ?? null) !== (row.assignee_type ?? null);
    if (assigneeChanged) {
      const assigneeId = row.assignee_id;
      const assigneeType = row.assignee_type;
      requireLocalInvariant(
        (assigneeId === null || assigneeId === undefined) ===
          (assigneeType === null || assigneeType === undefined),
        "Task assignee id and type must be set together",
      );
      if (assigneeId !== null && assigneeId !== undefined) {
        requireLocalInvariant(
          typeof assigneeType === "string" && localMemberBelongsToChannel(
            channelId,
            String(assigneeId),
            assigneeType,
          ),
          "Task assignee must be a valid channel member",
        );
      }
    }
    return;
  }

  if (table === "documents") {
    const serverId = localValue(row, "server_id");
    if (previous) {
      requireImmutableFields(table, previous, row, ["server_id", "created_by"]);
      const generatorChanged = (previous.generated_by_agent_id ?? null) !==
        (row.generated_by_agent_id ?? null);
      requireLocalInvariant(
        !generatorChanged ||
          (row.generated_by_agent_id === null &&
            agentDeletionIds.has(String(previous.generated_by_agent_id))),
        "documents.generated_by_agent_id is immutable",
      );
    } else {
      requireLocalInvariant(
        localValue(row, "created_by") === LOCAL_USER_ID && localUserCanAccessServer(serverId),
        "Document workspace access denied",
      );
      if (row.generated_by_agent_id !== null && row.generated_by_agent_id !== undefined) {
        requireLocalInvariant(
          localRowExists(
            `SELECT 1
               FROM agents agent
               JOIN server_members member
                 ON member.server_id = agent.server_id
                AND member.member_id = agent.id
                AND member.member_type = 'agent'
              WHERE agent.id = ? AND agent.server_id = ? AND agent.owner_id = ?`,
            toSqlValue(row.generated_by_agent_id),
            serverId,
            LOCAL_USER_ID,
          ),
          "Document generator does not belong to this workspace",
        );
      }
    }
    requireLocalInvariant(
      localValue(row, "title").trim().length > 0 && localValue(row, "title").length <= 200,
      "Invalid document title",
    );
    requireLocalInvariant(
      typeof row.content === "string" && row.content.length <= 2_000_000,
      "Invalid document content",
    );
    return;
  }

  if (table === "machine_keys") {
    if (previous) {
      requireImmutableFields(
        table,
        previous,
        row,
        ["user_id", "server_id", "key_prefix", "key_hash", "key_value"],
      );
    } else {
      requireLocalInvariant(
        atomicMutationScope === "key" || atomicMutationScope === "server",
        "Create runtime keys through the atomic runtime key API",
      );
      requireLocalInvariant(
        localValue(row, "user_id") === LOCAL_USER_ID &&
          localUserCanAccessServer(localValue(row, "server_id")) &&
          (row.key_value === null || row.key_value === undefined),
        "Runtime key workspace access denied",
      );
    }
  }
}

function localAgentChannelIds(agentId: string, serverId: string) {
  return (db.prepare(
    `SELECT channel_member.channel_id
       FROM channel_members channel_member
       JOIN channels channel ON channel.id = channel_member.channel_id
       JOIN server_members membership
         ON membership.server_id = channel.server_id
        AND membership.member_id = channel_member.member_id
        AND membership.member_type = 'agent'
      WHERE channel_member.member_id = ?
        AND channel_member.member_type = 'agent'
        AND channel.server_id = ?
      ORDER BY channel_member.channel_id`,
  ).all(agentId, serverId) as Array<{ channel_id: string }>).map((row) => row.channel_id);
}

function localAgentVisibleHumanIds(agentId: string, serverId: string) {
  return (db.prepare(
    `SELECT DISTINCT human.member_id
       FROM channel_members own
       JOIN channels channel ON channel.id = own.channel_id
       JOIN channel_members human
         ON human.channel_id = own.channel_id
        AND human.member_type = 'human'
       JOIN server_members membership
         ON membership.server_id = channel.server_id
        AND membership.member_id = human.member_id
        AND membership.member_type = 'human'
      WHERE own.member_id = ?
        AND own.member_type = 'agent'
        AND channel.server_id = ?
      ORDER BY human.member_id`,
  ).all(agentId, serverId) as Array<{ member_id: string }>).map((row) => row.member_id);
}

function authorizeLocalQuery(
  principal: LocalPrincipal,
  query: QueryRequest,
): QueryRequest {
  if (principal.kind === "human") return query;

  const channelIds = localAgentChannelIds(principal.agentId, principal.serverId);
  const scoped = (column: string, values: string[]): QueryRequest => ({
    ...query,
    filters: [
      ...(query.filters || []),
      { column, operator: "in", value: values },
    ],
  });

  if (query.action === "select") {
    switch (query.table) {
      case "agents":
        return scoped("id", [principal.agentId]);
      case "channels":
        return scoped("id", channelIds);
      case "channel_members":
      case "messages":
      case "tasks":
        return scoped("channel_id", channelIds);
      case "documents":
        return {
          ...query,
          filters: [
            ...(query.filters || []),
            { column: "server_id", operator: "eq", value: principal.serverId },
          ],
        };
      case "profiles":
        return scoped(
          "id",
          localAgentVisibleHumanIds(principal.agentId, principal.serverId),
        );
      default:
        throw new LocalRequestError(403, "The local agent capability cannot read this table");
    }
  }

  if (query.action === "insert" && query.table === "messages") {
    const rows = Array.isArray(query.values) ? query.values : [query.values];
    for (const value of rows) {
      const row = value as DbRow;
      if (
        row.sender_id !== principal.agentId ||
        row.sender_type !== "agent" ||
        typeof row.channel_id !== "string" ||
        !channelIds.includes(row.channel_id)
      ) {
        throw new LocalRequestError(403, "Message identity or channel is outside this local capability");
      }
    }
    return query;
  }

  if (query.action === "insert" && query.table === "documents") {
    const rows = Array.isArray(query.values) ? query.values : [query.values];
    for (const value of rows) {
      const row = value as DbRow;
      if (
        row.server_id !== principal.serverId ||
        row.created_by !== principal.ownerId ||
        row.generated_by_agent_id !== principal.agentId
      ) {
        throw new LocalRequestError(403, "Document identity is outside this local capability");
      }
    }
    return query;
  }

  if (query.action === "update" && query.table === "documents") {
    return {
      ...query,
      filters: [
        ...(query.filters || []),
        { column: "server_id", operator: "eq", value: principal.serverId },
      ],
    };
  }

  throw new LocalRequestError(403, "The local agent capability cannot perform this mutation");
}

function executeQuery(query: QueryRequest): QueryExecutionResult {
  const parsed = parseQueryRequest(query);
  if ("error" in parsed) throw new LocalRequestError(400, parsed.error);
  query = parsed.query;
  const table = assertTable(query.table);
  const filters = query.filters || [];
  if (!QUERY_ACTIONS.has(query.action)) {
    throw new LocalRequestError(400, "Unsupported query action");
  }
  if ((query.action === "update" || query.action === "delete") && filters.length === 0) {
    throw new LocalRequestError(400, `${query.action} requires at least one filter`);
  }
  const { clause: whereClause, params: whereParams } = buildWhere(table, filters);

  if (
    !databaseTransactionActive &&
    ((query.action === "insert" && Array.isArray(query.values) && query.values.length > 1) ||
      (query.action === "delete" && [
        "servers",
        "server_members",
        "agents",
        "channels",
        "channel_members",
        "messages",
      ].includes(table)))
  ) {
    return runDatabaseTransaction(() => executeQuery(query));
  }

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
      validateLocalMutation(table, row);
      const columns = Object.keys(row).map((column) => assertColumn(table, column));
      const placeholders = columns.map(() => "?").join(", ");
      db.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`
      ).run(...columns.map((column) => toSqlValue(row[column])));
      const stored = fetchInsertedRow(table, row);
      inserted.push(stored);
      emitDatabaseEvent("INSERT", table, stored);
      if (table === "messages" && stored.sender_type === "human") {
        const deliveries = db
          .prepare("SELECT * FROM message_deliveries WHERE message_id = ?")
          .all(toSqlValue(stored.id)) as DbRow[];
        for (const delivery of deliveries) {
          emitDatabaseEvent("INSERT", "message_deliveries", delivery);
        }
      }
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
    const previousRows = db
      .prepare(`SELECT * FROM ${table}${whereClause}`)
      .all(...whereParams) as DbRow[];
    if (
      (tableColumns[table] as readonly string[]).includes("updated_at") &&
      values.updated_at === undefined
    ) {
      values.updated_at = nextMonotonicTimestamp(
        ...previousRows.map((row) => row.updated_at),
      );
    }
    for (const previous of previousRows) {
      validateLocalMutation(table, { ...previous, ...values }, previous);
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

  if (query.action !== "delete") {
    throw new LocalRequestError(400, "Unsupported query action");
  }

  const deletedTargets = db
    .prepare(`SELECT * FROM ${table}${whereClause}`)
    .all(...whereParams) as DbRow[];

  if (
    table === "tasks" &&
    atomicMutationScope !== "task" &&
    !deletedTargets.every(
      (task) =>
        messageDeletionIds.has(String(task.message_id)) ||
        channelDeletionIds.has(String(task.channel_id)),
    )
  ) {
    throw new LocalRequestError(400, "Delete tasks through the safe archived task API");
  }

  if (
    table === "agents" &&
    atomicMutationScope !== "agent" &&
    atomicMutationScope !== "membership" &&
    !deletedTargets.every((agent) => serverDeletionIds.has(String(agent.server_id)))
  ) {
    throw new LocalRequestError(400, "Delete agents through the agent API");
  }

  if (table === "server_members") {
    for (const member of deletedTargets) {
      if (
        member.member_type === "agent" &&
        !agentDeletionIds.has(String(member.member_id))
      ) {
        throw new LocalRequestError(400, "Delete the agent instead of removing its workspace membership");
      }
      if (
        member.member_type === "human" &&
        !serverDeletionIds.has(String(member.server_id)) &&
        localRowExists(
          "SELECT 1 FROM servers WHERE id = ? AND owner_id = ?",
          toSqlValue(member.server_id),
          toSqlValue(member.member_id),
        )
      ) {
        throw new LocalRequestError(400, "The workspace owner membership cannot be removed");
      }
    }

    for (const member of deletedTargets) {
      if (member.member_type !== "human" || serverDeletionIds.has(String(member.server_id))) {
        continue;
      }
      executeQuery({
        table: "machine_keys",
        action: "delete",
        filters: [
          { column: "server_id", operator: "eq", value: member.server_id },
          { column: "user_id", operator: "eq", value: member.member_id },
        ],
      });
      const channelIds = db.prepare(
        `SELECT channel_member.channel_id
           FROM channel_members channel_member
           JOIN channels channel ON channel.id = channel_member.channel_id
          WHERE channel.server_id = ?
            AND channel_member.member_id = ?
            AND channel_member.member_type = 'human'`,
      ).all(
        toSqlValue(member.server_id),
        toSqlValue(member.member_id),
      ) as Array<{ channel_id: string }>;
      if (channelIds.length > 0) {
        const previousScope = atomicMutationScope;
        if (!previousScope) atomicMutationScope = "membership";
        try {
          executeQuery({
            table: "channel_members",
            action: "delete",
            filters: [
              { column: "channel_id", operator: "in", value: channelIds.map((row) => row.channel_id) },
              { column: "member_id", operator: "eq", value: member.member_id },
              { column: "member_type", operator: "eq", value: "human" },
            ],
          });
        } finally {
          if (!previousScope) atomicMutationScope = null;
        }
      }
    }
  }

  if (table === "channel_members") {
    for (const member of deletedTargets) {
      const channel = db.prepare("SELECT server_id, type FROM channels WHERE id = ?").get(
        toSqlValue(member.channel_id),
      ) as { server_id?: string; type?: string } | undefined;
      if (
        member.member_type === "agent" &&
        atomicMutationScope !== "agent" &&
        atomicMutationScope !== "channel" &&
        atomicMutationScope !== "membership" &&
        !channelDeletionIds.has(String(member.channel_id)) &&
        !serverDeletionIds.has(
          String(
            (db.prepare("SELECT server_id FROM channels WHERE id = ?").get(
              toSqlValue(member.channel_id),
            ) as { server_id?: string } | undefined)?.server_id || "",
          ),
        )
      ) {
        throw new LocalRequestError(
          400,
          "Change agent channel members through the atomic channel API",
        );
      }
      if (
        member.member_type === "human" &&
        channel?.type === "dm" &&
        atomicMutationScope !== "membership" &&
        !channelDeletionIds.has(String(member.channel_id)) &&
        !serverDeletionIds.has(String(channel.server_id || ""))
      ) {
        throw new LocalRequestError(400, "Direct-message membership follows the agent lifecycle");
      }
    }
    const previousScope = atomicMutationScope;
    if (!previousScope) atomicMutationScope = "membership";
    try {
      for (const member of deletedTargets) {
        queryData({
          table: "tasks",
          action: "update",
          values: { assignee_id: null, assignee_type: null },
          filters: [
            { column: "channel_id", operator: "eq", value: member.channel_id },
            { column: "assignee_id", operator: "eq", value: member.member_id },
            { column: "assignee_type", operator: "eq", value: member.member_type },
          ],
        });
      }
    } finally {
      if (!previousScope) atomicMutationScope = null;
    }
  }

  if (table === "messages" && deletedTargets.length > 0) {
    const messageIds = deletedTargets.map((row) => row.id);
    for (const messageId of messageIds) messageDeletionIds.add(String(messageId));
    try {
      executeQuery({
        table: "message_deliveries",
        action: "delete",
        filters: [{ column: "message_id", operator: "in", value: messageIds }],
      });
      executeQuery({
        table: "tasks",
        action: "delete",
        filters: [{ column: "message_id", operator: "in", value: messageIds }],
      });
    } finally {
      for (const messageId of messageIds) messageDeletionIds.delete(String(messageId));
    }
  }

  if (table === "channels" && deletedTargets.length > 0) {
    const channelIds = deletedTargets.map((row) => row.id);
    for (const channelId of channelIds) channelDeletionIds.add(String(channelId));
    try {
      executeQuery({
        table: "tasks",
        action: "delete",
        filters: [{ column: "channel_id", operator: "in", value: channelIds }],
      });
      executeQuery({
        table: "messages",
        action: "delete",
        filters: [{ column: "channel_id", operator: "in", value: channelIds }],
      });
      executeQuery({
        table: "channel_members",
        action: "delete",
        filters: [{ column: "channel_id", operator: "in", value: channelIds }],
      });
    } finally {
      for (const channelId of channelIds) channelDeletionIds.delete(String(channelId));
    }
  }

  if (table === "agents" && deletedTargets.length > 0) {
    for (const agent of deletedTargets) agentDeletionIds.add(String(agent.id));
    try {
      for (const agent of deletedTargets) {
        const workspaceChannels = db.prepare(
          "SELECT id FROM channels WHERE server_id = ? ORDER BY id",
        ).all(toSqlValue(agent.server_id)) as Array<{ id: string }>;
        const workspaceChannelIds = workspaceChannels.map((channel) => channel.id);
        const dmChannels = db.prepare(
          `SELECT channel.id
             FROM channels channel
             JOIN channel_members member ON member.channel_id = channel.id
            WHERE channel.server_id = ? AND channel.type = 'dm'
              AND member.member_id = ? AND member.member_type = 'agent'`,
        ).all(toSqlValue(agent.server_id), toSqlValue(agent.id)) as Array<{ id: string }>;
        if (dmChannels.length > 0) {
          executeQuery({
            table: "channels",
            action: "delete",
            filters: [{ column: "id", operator: "in", value: dmChannels.map((channel) => channel.id) }],
          });
        }
        if (workspaceChannelIds.length > 0) {
          executeQuery({
            table: "channel_members",
            action: "delete",
            filters: [
              { column: "channel_id", operator: "in", value: workspaceChannelIds },
              { column: "member_id", operator: "eq", value: agent.id },
              { column: "member_type", operator: "eq", value: "agent" },
            ],
          });
        }
        executeQuery({
          table: "server_members",
          action: "delete",
          filters: [
            { column: "server_id", operator: "eq", value: agent.server_id },
            { column: "member_id", operator: "eq", value: agent.id },
            { column: "member_type", operator: "eq", value: "agent" },
          ],
        });
        if (workspaceChannelIds.length > 0) {
          executeQuery({
            table: "tasks",
            action: "update",
            values: { assignee_id: null, assignee_type: null },
            filters: [
              { column: "channel_id", operator: "in", value: workspaceChannelIds },
              { column: "assignee_id", operator: "eq", value: agent.id },
              { column: "assignee_type", operator: "eq", value: "agent" },
            ],
          });
        }
        executeQuery({
          table: "documents",
          action: "update",
          values: { generated_by_agent_id: null },
          filters: [
            { column: "server_id", operator: "eq", value: agent.server_id },
            { column: "generated_by_agent_id", operator: "eq", value: agent.id },
          ],
        });
        executeQuery({
          table: "message_deliveries",
          action: "delete",
          filters: [
            { column: "server_id", operator: "eq", value: agent.server_id },
            { column: "agent_id", operator: "eq", value: agent.id },
          ],
        });
      }
    } finally {
      for (const agent of deletedTargets) agentDeletionIds.delete(String(agent.id));
    }
  }

  if (table === "servers" && deletedTargets.length > 0) {
    for (const workspace of deletedTargets) serverDeletionIds.add(String(workspace.id));
    try {
      for (const workspace of deletedTargets) {
        for (const childTable of ["agents", "channels", "documents", "machine_keys"] as const) {
          executeQuery({
            table: childTable,
            action: "delete",
            filters: [{ column: "server_id", operator: "eq", value: workspace.id }],
          });
        }
        executeQuery({
          table: "server_members",
          action: "delete",
          filters: [{ column: "server_id", operator: "eq", value: workspace.id }],
        });
      }
    } finally {
      for (const workspace of deletedTargets) serverDeletionIds.delete(String(workspace.id));
    }
  }

  const rows = db
    .prepare(`DELETE FROM ${table}${whereClause} RETURNING *`)
    .all(...whereParams) as DbRow[];
  if (table === "agents") {
    for (const row of rows) deleteAgentCapabilities(String(row.id));
  }
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
  if (table === "message_deliveries") {
    row.status ??= "pending";
    row.attempts ??= 0;
    row.claim_token ??= null;
    row.claimed_by ??= null;
    row.lease_expires_at ??= null;
    row.next_attempt_at ??= now;
    row.last_error ??= null;
    row.completed_at ??= null;
  }
  if (table === "tasks") {
    if (row.task_number === undefined) {
      const result = db.prepare("SELECT coalesce(max(task_number), 0) + 1 AS next_number FROM tasks").get() as {
        next_number: number;
      };
      row.task_number = result.next_number;
    }
    row.description ??= "";
    row.status ??= "todo";
    row.parent_task_id ??= null;
    row.assignee_id ??= null;
    row.assignee_type ??= null;
    row.archived_at ??= null;
  }
  if (table === "agents") {
    row.runtime ??= "codex";
    row.model ??= "default";
    row.thinking_level ??= "medium";
    row.status ??= "offline";
    row.workspace_path ??= null;
    row.session_id ??= null;
    row.runtime_session_id ??= null;
    row.runtime_session_runtime ??= null;
    row.connection_id ??= null;
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
  if (table === "message_deliveries") {
    return db
      .prepare("SELECT * FROM message_deliveries WHERE message_id = ? AND agent_id = ?")
      .get(toSqlValue(row.message_id), toSqlValue(row.agent_id)) as DbRow;
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

async function getEventsWithWait(afterValue: string | null, waitMs: number) {
  const initial = getEvents(afterValue);
  if (afterValue === null || initial.events.length > 0 || waitMs === 0) return initial;

  return new Promise<ReturnType<typeof getEvents>>((resolveEvents) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (events: ReturnType<typeof getEvents>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      eventWaiters.delete(wake);
      resolveEvents(events);
    };
    const wake = () => {
      const next = getEvents(afterValue);
      if (localServerStopping || next.events.length > 0) finish(next);
    };
    timer = setTimeout(() => finish(getEvents(afterValue)), waitMs);
    eventWaiters.add(wake);
  });
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

  emittedEventsSincePrune += 1;
  if (emittedEventsSincePrune >= 250) {
    db.prepare(
      "DELETE FROM local_events WHERE id <= (SELECT max(id) - 5000 FROM local_events)",
    ).run();
    emittedEventsSincePrune = 0;
  }

  if (databaseTransactionActive) {
    transactionHasEvents = true;
    return;
  }
  wakeEventWaiters();
}

function wakeEventWaiters() {
  for (const wake of [...eventWaiters]) wake();
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
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    request.once("error", () => undefined);
    request.resume();
    throw new LocalRequestError(413, "Request body must be 4 MiB or smaller");
  }

  return new Promise<unknown>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
    };
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        chunks.length = 0;
        request.resume();
        finish(() => rejectBody(
          new LocalRequestError(413, "Request body must be 4 MiB or smaller"),
        ));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => finish(() => {
      if (chunks.length === 0) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as unknown);
      } catch {
        rejectBody(new LocalRequestError(400, "Request body must be valid JSON"));
      }
    });
    const onAborted = () => finish(() => rejectBody(
      new LocalRequestError(400, "Request body was interrupted"),
    ));
    const onError = (error: Error) => finish(() => rejectBody(error));

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
}

function isAllowedLocalOrigin(origin: string | undefined) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === "tauri:" && url.hostname === "localhost") return true;
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "[::1]" ||
        url.hostname === "tauri.localhost")
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function setCors(request: IncomingMessage, response: ServerResponse) {
  const origin = request.headers.origin;
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
