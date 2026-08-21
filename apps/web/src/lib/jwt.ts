import { createHmac, randomUUID } from "crypto";

const AGENT_TOKEN_VERSION = 2;

/**
 * Sign a Supabase-compatible JWT for one runtime machine in one workspace.
 * The authenticated role keeps existing Bridge table policies working while
 * the custom claims let Realtime distinguish the runtime from a browser user.
 */
export function signBridgeJwt(
  userId: string,
  serverId: string,
  machineKeyId: string,
  expiresInSeconds = 60 * 60,
): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error("Missing SUPABASE_JWT_SECRET env var");
  }

  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
    iss: "supabase",
    teammate_bridge: true,
    teammate_server_id: serverId,
    teammate_machine_key_id: machineKeyId,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(payload)),
  ];

  const signingInput = segments.join(".");
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");

  return `${signingInput}.${signature}`;
}

/**
 * Sign a short-lived JWT for exactly one agent process. The agent UUID is the
 * Supabase principal; the human owner is a separate claim used only after the
 * database has verified the live machine key and workspace memberships.
 */
export function signAgentJwt(
  agentId: string,
  ownerId: string,
  serverId: string,
  machineKeyId: string,
  expiresInSeconds = 60 * 60,
): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error("Missing SUPABASE_JWT_SECRET env var");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: agentId,
    role: "authenticated",
    aud: "authenticated",
    iss: "supabase",
    teammate_agent: true,
    teammate_agent_id: agentId,
    teammate_owner_id: ownerId,
    teammate_server_id: serverId,
    teammate_machine_key_id: machineKeyId,
    teammate_token_version: AGENT_TOKEN_VERSION,
    jti: randomUUID(),
    iat: now,
    exp: now + expiresInSeconds,
  };
  const segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(payload)),
  ];
  const signingInput = segments.join(".");
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");

  return `${signingInput}.${signature}`;
}

function base64url(str: string): string {
  return Buffer.from(str, "utf-8").toString("base64url");
}
