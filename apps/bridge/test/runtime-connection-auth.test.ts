import assert from "node:assert/strict";
import test from "node:test";
import { AgentManager } from "../src/agent-manager.js";

function bareManager() {
  const manager = Object.create(AgentManager.prototype) as AgentManager;
  Reflect.set(manager, "localServerUrl", "http://127.0.0.1:8787");
  Reflect.set(manager, "runtimeApiKey", "test-runtime-key");
  return manager;
}

function loadRuntimeConnection(manager: AgentManager) {
  return Reflect.get(manager, "loadRuntimeConnection") as (
    connectionId: string,
  ) => Promise<unknown>;
}

test("nested local service errors remain actionable and runtime fetches carry a deadline", async () => {
  const originalFetch = globalThis.fetch;
  let observedSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_input, init) => {
    observedSignal = init?.signal instanceof AbortSignal ? init.signal : null;
    return new Response(JSON.stringify({
      error: {
        message: "ChatGPT authorization expired. Reconnect the provider.",
      },
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const manager = bareManager();
    await assert.rejects(
      loadRuntimeConnection(manager).call(manager, "connection-a"),
      new Error("ChatGPT authorization expired. Reconnect the provider."),
    );
    assert.ok(observedSignal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a malformed runtime response uses a stable fallback instead of leaking JSON parsing errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("not-json", { status: 502 })) as typeof fetch;

  try {
    const manager = bareManager();
    await assert.rejects(
      loadRuntimeConnection(manager).call(manager, "connection-a"),
      new Error("Could not load Pi model connection"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a runtime connection deadline reports a stable retryable error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    const error = new Error("request aborted");
    error.name = "TimeoutError";
    throw error;
  }) as typeof fetch;

  try {
    const manager = bareManager();
    await assert.rejects(
      loadRuntimeConnection(manager).call(manager, "connection-a"),
      new Error("Timed out while loading the model connection. Try again."),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
