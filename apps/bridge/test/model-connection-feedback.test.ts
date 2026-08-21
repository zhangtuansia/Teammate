import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  resolveAgentRuntimeSelection,
  type RuntimeModelConnection,
} from "../../web/src/lib/agent-runtime.ts";
import { parseRuntimeError } from "../../web/src/lib/runtime-error.ts";

const appFile = (path: string) => new URL(`../../${path}`, import.meta.url);

const managedConnection: RuntimeModelConnection = {
  id: "chatgpt",
  provider: "openai-codex",
  default_model: "gpt-5.2",
  models: [{ id: "gpt-5.2" }, { id: "gpt-5.4" }],
  hasCredential: true,
  status: "connected",
};

test("runtime selection accepts only the active connection catalog and switches atomically", () => {
  const repaired = resolveAgentRuntimeSelection({
    runtime: "pi",
    connectionId: managedConnection.id,
    model: "gpt-5.3-codex",
  }, [managedConnection]);
  assert.equal(repaired.issue, "unsupported-model");
  assert.deepEqual(repaired.selection, {
    runtime: "pi",
    connectionId: managedConnection.id,
    model: managedConnection.default_model,
  });

  const switched = resolveAgentRuntimeSelection({
    runtime: "pi",
    connectionId: managedConnection.id,
  }, [managedConnection]);
  assert.equal(switched.issue, null);
  assert.equal(switched.selection.model, managedConnection.default_model);

  for (const unavailable of [
    { ...managedConnection, hasCredential: false },
    { ...managedConnection, status: "error" as const },
  ]) {
    const rejected = resolveAgentRuntimeSelection({
      runtime: "pi",
      connectionId: unavailable.id,
    }, [unavailable]);
    assert.equal(rejected.issue, "connection-unavailable");
  }

  const inventedCodexModel = resolveAgentRuntimeSelection({
    runtime: "codex",
    model: "future-model-from-free-input",
  });
  assert.equal(inventedCodexModel.issue, "unsupported-model");
  assert.equal(inventedCodexModel.selection.model, "default");

  const unavailableRuntime = resolveAgentRuntimeSelection({
    runtime: "codex",
  }, [], ["pi"]);
  assert.equal(unavailableRuntime.issue, "runtime-unavailable");
});

test("nested provider payloads become actionable runtime errors instead of raw JSON", () => {
  const parsed = parseRuntimeError(JSON.stringify({
    error: { detail: { message: "Model gpt-5.3-codex is not supported for this account" } },
  }));
  assert.deepEqual(parsed, { kind: "unsupported-model", detail: "" });
  assert.equal(parseRuntimeError('{"opaque":{"code":42}}').detail, "");
});

test("local connection contract preserves capability metadata and safe destructive guards", async () => {
  const [server, catalog, deletion, manager, worker] = await Promise.all([
    readFile(appFile("local-server/src/index.ts"), "utf8"),
    readFile(appFile("local-server/src/chatgpt-model-catalog.ts"), "utf8"),
    readFile(appFile("local-server/src/connection-deletion.ts"), "utf8"),
    readFile(appFile("bridge/src/agent-manager.ts"), "utf8"),
    readFile(appFile("bridge/src/runtimes/pi-worker.ts"), "utf8"),
  ]);

  assert.match(server, /CHATGPT_OAUTH_UNAVAILABLE_MODELS = new Set\(\["gpt-5\.3-codex"\]\)/);
  assert.match(server, /maxTokens: model\.maxTokens/);
  assert.match(server, /input: \[\.\.\.model\.input\]/);
  assert.match(catalog, /input: ReadonlyArray<"text" \| "image">/);
  assert.match(catalog, /input: \["text", "image"\]/);
  assert.match(server, /probe: "configuration"/);
  assert.match(server, /if \(!isInstalledAgentRuntime\(runtime\)\)/);
  assert.match(server, /listAgentRuntimes\(\)\.some/);
  assert.match(server, /deleteConnectionSafely\(connectionId/);
  assert.match(server, /DELETE FROM llm_connections[\s\S]*NOT EXISTS[\s\S]*agents[\s\S]*app_settings/);
  assert.match(server, /Choose another default model connection before removing this one/);
  assert.match(deletion, /initialGuard\.inUseByAgents > 0 \|\| initialGuard\.isDefault/);
  assert.match(deletion, /await dependencies\.deleteCredential\(\)[\s\S]*deleteRowIfUnguarded\(\)/);
  assert.match(deletion, /dependencies\.markNeedsAuth\(\)/);
  assert.match(
    server,
    /void reconcileAutoSyncedConnectionsAtStartup\(\)[\s\S]*?\.finally\(\(\) => \{[\s\S]*?server\.listen/,
  );
  assert.match(server, /model_selection_mode !== "automatically-synced"/);
  assert.match(server, /connectionCredentialIsUsable\(connection, credentialResult\.credential\)/);
  assert.match(server, /session_id: null,[\s\S]*runtime_session_id: null/);
  assert.match(server, /source: automaticallySynced \? "sdk" : "user-defined"/);
  assert.match(server, /changed: automaticallySynced/);
  assert.doesNotMatch(
    server.match(/function publicConnection[\s\S]*?\n}\n/)?.[0] || "",
    /refreshConnectionModels/,
  );

  assert.match(manager, /model === "default" \|\| !model/);
  assert.match(manager, /connection\.models\.some\(\(candidate\) => candidate\.id === model\)/);
  assert.match(manager, /storedModel === "default"[\s\S]*current\.model/);
  assert.match(manager, /AbortSignal\.timeout\(15_000\)/);
  assert.match(worker, /reasoning: definition\.reasoning === true/);
  assert.match(worker, /thinkingLevel: selectedModel\.reasoning \? config\.thinkingLevel : "off"/);
  assert.match(worker, /definition\.contextWindow/);
  assert.match(worker, /definition\.maxTokens/);
});

test("Pi connections use the public provider dispatcher", async () => {
  const worker = await readFile(
    new URL("../src/runtimes/pi-worker.ts", import.meta.url),
    "utf8",
  );

  assert.match(worker, /streamSimple,/);
  assert.match(worker, /from "@mariozechner\/pi-ai"/);
  assert.doesNotMatch(worker, /node_modules\/@mariozechner\/pi-ai\/dist\/providers/);
  assert.doesNotMatch(worker, /streamSimple(?:Anthropic|OpenAICodexResponses|OpenAICompletions)/);
});

test("AI settings follows the connection-first IA and disables missing local runtimes", async () => {
  const [settings, connections, translations, createAgent, editAgent, providers] = await Promise.all([
    readFile(appFile("desktop/src/settings.tsx"), "utf8"),
    readFile(appFile("desktop/src/model-connections.tsx"), "utf8"),
    readFile(appFile("web/src/hooks/use-app-settings.tsx"), "utf8"),
    readFile(appFile("web/src/components/create-agent-dialog.tsx"), "utf8"),
    readFile(appFile("web/src/components/agent-settings-panel.tsx"), "utf8"),
    readFile(appFile("web/src/lib/model-provider-registry.ts"), "utf8"),
  ]);

  assert.match(translations, /"settings\.navModels": "AI"/);
  assert.match(settings, /settings\.defaultSettings/);
  assert.match(settings, /settings\.thinkingLevel/);
  assert.match(settings, /workspaceServer\.name/);
  assert.match(settings, /settings\.workspaceInherited/);
  assert.doesNotMatch(settings, /Local Workspace<\/p>/);
  assert.match(connections, /<Dialog/);
  assert.match(connections, /settings\.addConnectionTitle/);
  assert.match(connections, /settings\.configurationCheck/);
  assert.match(connections, /connection\.model_selection_mode === "automatically-synced"/);
  assert.match(settings, /disabled=\{item\.disabled\}/);
  assert.match(settings, /installedAgentRuntimeIds\(runtimes\)/);
  assert.match(createAgent, /loadAgentRuntimes\(controller\.signal\)/);
  assert.match(createAgent, /disabled=\{item\.disabled\}/);
  assert.match(editAgent, /loadAgentRuntimes\(controller\.signal\)/);
  assert.match(editAgent, /disabled=\{item\.disabled\}/);
  assert.match(providers, /Not installed/);
  assert.doesNotMatch(connections, /<Collapsible/);
  assert.doesNotMatch(connections, /connectivity test|model test/i);
});
