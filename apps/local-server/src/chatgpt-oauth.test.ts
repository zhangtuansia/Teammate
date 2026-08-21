import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CodexOAuthRefreshCoordinator,
  refreshOpenAICodexToken,
  type CodexOAuthCredential,
} from "./chatgpt-oauth.js";

test("OAuth refreshes are single-flight per connection and retain a rotated-away refresh token", async () => {
  let refreshCalls = 0;
  let writes = 0;
  let releaseRefresh: () => void = () => undefined;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let stored: CodexOAuthCredential = {
    access: "expired-access",
    refresh: "stable-refresh",
    expires: 1,
    accountId: "account-a",
  };
  const coordinator = new CodexOAuthRefreshCoordinator(async () => {
    refreshCalls += 1;
    await refreshGate;
    return {
      access: "fresh-access",
      expires: 10_000_000,
    };
  }, () => 1_000);

  const requests = Array.from({ length: 8 }, () => coordinator.resolve(
    "connection-a",
    async () => stored,
    async (credential) => {
      writes += 1;
      stored = credential;
    },
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls, 1);
  releaseRefresh();

  const credentials = await Promise.all(requests);
  assert.equal(writes, 1);
  assert.equal(credentials.every((credential) => credential?.access === "fresh-access"), true);
  assert.equal(stored.refresh, "stable-refresh");
  assert.equal(stored.accountId, "account-a");
});

test("the refresh winner re-reads the credential after acquiring single-flight ownership", async () => {
  let reads = 0;
  let refreshCalls = 0;
  const expired: CodexOAuthCredential = {
    access: "expired",
    refresh: "refresh",
    expires: 1,
  };
  const alreadyRefreshed: CodexOAuthCredential = {
    access: "already-fresh",
    refresh: "new-refresh",
    expires: 10_000_000,
  };
  const coordinator = new CodexOAuthRefreshCoordinator(async () => {
    refreshCalls += 1;
    return { access: "unexpected", expires: 10_000_000 };
  }, () => 1_000);

  const result = await coordinator.resolve(
    "connection-a",
    async () => (++reads === 1 ? expired : alreadyRefreshed),
    async () => assert.fail("a fresh credential must not be overwritten"),
  );

  assert.equal(reads, 2);
  assert.equal(refreshCalls, 0);
  assert.equal(result, alreadyRefreshed);
});

test("token refresh accepts providers that omit refresh_token and applies a request deadline", async () => {
  const originalFetch = globalThis.fetch;
  let observedSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_input, init) => {
    observedSignal = init?.signal instanceof AbortSignal ? init.signal : null;
    return new Response(JSON.stringify({
      access_token: "fresh-access",
      expires_in: 3600,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const refreshed = await refreshOpenAICodexToken("existing-refresh");
    assert.equal(refreshed.access, "fresh-access");
    assert.equal(refreshed.refresh, undefined);
    assert.ok(observedSignal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("token request deadlines surface an actionable timeout", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    const error = new Error("request aborted");
    error.name = "TimeoutError";
    throw error;
  }) as typeof fetch;

  try {
    await assert.rejects(
      refreshOpenAICodexToken("existing-refresh"),
      /ChatGPT token request timed out\. Try again\./,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime refresh failures persist an auth error and return a flat 409 contract", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /new CodexOAuthRefreshCoordinator\(\)/);
  assert.match(
    source,
    /UPDATE llm_connections SET status = 'error', auth_error = \?, updated_at = \? WHERE id = \?/,
  );
  assert.match(source, /return sendJson\(response, 409, \{ error: message \}\)/);
});
