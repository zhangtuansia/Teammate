import { createHmac } from "crypto";

/**
 * Sign a minimal Supabase-compatible JWT using HMAC-SHA256.
 * This produces a token that auth.uid() in RLS policies will recognize.
 */
export function signBridgeJwt(userId: string, expiresInSeconds = 7 * 24 * 3600): string {
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
