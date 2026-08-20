import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const ACCOUNT_CLAIM = "https://api.openai.com/auth";

export interface CodexOAuthCredential {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

interface LoginOptions {
  originator?: string;
  onAuth: (value: { url: string }) => void;
  onManualCodeInput: () => Promise<string>;
}

function accountId(accessToken: string) {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1] || "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const auth = payload[ACCOUNT_CLAIM] as Record<string, unknown> | undefined;
    return typeof auth?.chatgpt_account_id === "string"
      ? auth.chatgpt_account_id
      : undefined;
  } catch {
    return undefined;
  }
}

function authorizationInput(value: string) {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get("code") || undefined,
      state: url.searchParams.get("state") || undefined,
    };
  } catch {
    const [code, state] = trimmed.split("#", 2);
    return { code: code || undefined, state };
  }
}

async function tokenRequest(parameters: URLSearchParams) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: parameters.toString(),
  });
  if (!response.ok) {
    throw new Error(`ChatGPT token request failed with HTTP ${response.status}`);
  }
  const result = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!result.access_token || !result.refresh_token || !result.expires_in) {
    throw new Error("ChatGPT token response is incomplete");
  }
  return {
    access: result.access_token,
    refresh: result.refresh_token,
    expires: Date.now() + result.expires_in * 1000,
    accountId: accountId(result.access_token),
  };
}

function callbackPage(success: boolean, message: string) {
  const title = success ? "Teammate 已连接" : "Teammate 登录失败";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><body style="font:15px -apple-system,BlinkMacSystemFont,sans-serif;padding:48px;color:#242424"><h2>${title}</h2><p>${message}</p></body></html>`;
}

export async function loginOpenAICodex(
  options: LoginOptions,
): Promise<CodexOAuthCredential> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("hex");
  const authorize = new URL(AUTHORIZE_URL);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: options.originator || "teammate",
  })) {
    authorize.searchParams.set(key, value);
  }

  let resolveCallback: (value: string) => void = () => undefined;
  let rejectCallback: (error: Error) => void = () => undefined;
  const callback = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost:1455");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.pathname !== "/auth/callback") {
      response.writeHead(404);
      response.end(callbackPage(false, "回调地址不正确。"));
      return;
    }
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400);
      response.end(callbackPage(false, "安全校验失败，请重新发起登录。"));
      rejectCallback(new Error("OAuth state mismatch"));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      response.writeHead(400);
      response.end(callbackPage(false, "没有收到授权码。"));
      rejectCallback(new Error("OAuth callback did not include a code"));
      return;
    }
    response.writeHead(200);
    response.end(callbackPage(true, "登录已完成，可以关闭这个页面并返回 Teammate。"));
    resolveCallback(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => reject(
      new Error(`Could not start OAuth callback on port 1455: ${error.message}`),
    ));
    server.listen(1455, "127.0.0.1", resolve);
  });
  options.onAuth({ url: authorize.toString() });

  try {
    const result = await Promise.race([
      callback.then((code) => ({ code, state })),
      options.onManualCodeInput().then(authorizationInput),
    ]);
    if (!result.code) throw new Error("OAuth login was canceled");
    if (result.state && result.state !== state) throw new Error("OAuth state mismatch");
    return tokenRequest(new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: result.code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }));
  } finally {
    server.close();
  }
}

export async function refreshOpenAICodexToken(refreshToken: string) {
  return tokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  }));
}
