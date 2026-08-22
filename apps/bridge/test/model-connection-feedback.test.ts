import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  resolveAgentRuntimeSelection,
  type RuntimeModelConnection,
} from "../../web/src/lib/agent-runtime.ts";
import { parseRuntimeError } from "../../web/src/lib/runtime-error.ts";
import { formatMessageClock, parseMessageTime } from "../../web/src/lib/message-time.ts";
import { isBlockedAddress, parseLinkMetadata } from "../../local-server/src/link-preview.ts";
import { remarkChatBreaks, type MdastNode } from "../../web/src/lib/markdown-breaks.ts";
import { documentPreview } from "../../web/src/lib/document-preview.ts";

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
  // A custom endpoint is asked for its own catalog rather than making someone
  // type model ids, and the discovered list keeps the selected default.
  assert.match(server, /fetch\(`\$\{baseUrl\}\/models`/);
  assert.match(server, /modelIds\.includes\(connection\.default_model\)\s*\n\s*\? connection\.default_model/);
  assert.match(server, /source: automaticallySynced \? "sdk" : "endpoint"/);
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
  assert.doesNotMatch(
    server.match(/function publicConnection[\s\S]*?\n}\n/)?.[0] || "",
    /refreshConnectionModels/,
  );

  assert.match(manager, /model === "default" \|\| !model/);
  assert.match(manager, /connection\.models\.some\(\(candidate\) => candidate\.id === model\)/);
  assert.match(manager, /storedModel === "default"[\s\S]*current\.model/);
  assert.match(manager, /AbortSignal\.timeout\(15_000\)/);
  assert.match(worker, /reasoning: definition\.reasoning \?\? inferReasoningModel\(id\)/);
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
  // Refreshing the model catalog is offered for every connection: a custom
  // endpoint can be asked what it runs, not only provider-synced ones.
  assert.match(connections, /settings\.refreshModels/);
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

test("message timestamps parse the same way on every engine", () => {
  const iso = parseMessageTime("2026-08-21T03:25:39.271Z");
  assert.ok(iso);
  assert.equal(iso.toISOString(), "2026-08-21T03:25:39.271Z");

  // The space-separated SQL form is what older rows carry. Chrome reads it as
  // local time and Safari refuses it outright, so the desktop shell showed
  // "Invalid Date" where the browser looked fine. Both must land on the same
  // UTC instant as the rest of the data.
  const sql = parseMessageTime("2026-08-21 09:56:00");
  assert.ok(sql, "a space-separated SQL timestamp must still parse");
  assert.equal(sql.toISOString(), "2026-08-21T09:56:00.000Z");

  // Genuinely unusable values report themselves instead of becoming a Date
  // that renders as "Invalid Date" and splits the transcript around itself.
  assert.equal(parseMessageTime("2026-08-21T10:16:50.3NZ"), null);
  assert.equal(parseMessageTime(""), null);
  assert.equal(parseMessageTime(null), null);
  assert.equal(formatMessageClock("2026-08-21T10:16:50.3NZ"), "");
});

test("link previews refuse to reach anything but the public internet", () => {
  // Fetching a URL out of a message means this machine makes the request, so
  // the only addresses worth reaching are ones any stranger could reach too.
  for (const address of [
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // carrier-grade NAT
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1", // a v4 loopback wearing a v6 hat
    "not-an-address",
  ]) {
    assert.equal(isBlockedAddress(address), true, `${address} must be refused`);
  }

  for (const address of ["1.1.1.1", "93.184.216.34", "2606:2800:220:1::1"]) {
    assert.equal(isBlockedAddress(address), false, `${address} should be reachable`);
  }
});

test("link metadata prefers Open Graph and falls back to the title tag", () => {
  const og = parseLinkMetadata(
    "https://example.com/a",
    `<html><head><title>Ignored</title>
     <meta property="og:title" content="Real &amp; proper title">
     <meta property="og:description" content="A blurb">
     <meta property="og:site_name" content="Example">
     </head></html>`,
  );
  assert.equal(og.title, "Real & proper title");
  assert.equal(og.description, "A blurb");
  assert.equal(og.siteName, "Example");

  const bare = parseLinkMetadata(
    "https://example.com/b",
    "<html><head><title>Just a title</title></head></html>",
  );
  assert.equal(bare.title, "Just a title");
  assert.equal(bare.description, null);
});

test("a newline in a message is a line break, except inside code", () => {
  // Shift+Enter has to survive the round trip. CommonMark folds a single
  // newline into a space, which turned a two-line message into a run-on line.
  const tree: MdastNode = {
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "text", value: "first\nsecond" }] },
      { type: "code", value: "const a = 1;\nconst b = 2;" },
      { type: "paragraph", children: [{ type: "inlineCode", value: "a\nb" }] },
    ],
  };
  remarkChatBreaks()(tree);

  const paragraph = tree.children![0];
  assert.deepEqual(
    paragraph.children!.map((child) => child.type),
    ["text", "break", "text"],
  );
  assert.equal(paragraph.children![0].value, "first");
  assert.equal(paragraph.children![2].value, "second");

  // Code keeps its newlines: they are content, not layout.
  assert.equal(tree.children![1].value, "const a = 1;\nconst b = 2;");
  assert.equal(tree.children![2].children![0].value, "a\nb");
});

test("a document preview reads as prose, not as markup", () => {
  const preview = documentPreview(
    "# 下周排期\n\n- 周一：需求评审\n- 周三：设计评审\n\n有 **冲突** 提前说。",
  );
  assert.equal(preview, "下周排期 · 周一：需求评审 · 周三：设计评审 · 有 冲突 提前说。");

  // A code fence says less about the document than its prose does.
  assert.equal(
    documentPreview("部署步骤\n```bash\nrm -rf /\n```\n完成后通知我"),
    "部署步骤 · 完成后通知我",
  );

  // Links keep their text; the URL is unreadable at this size.
  assert.equal(documentPreview("见 [排期表](https://example.com/a)"), "见 排期表");

  // Rules and table separators carry nothing to read.
  assert.equal(documentPreview("标题\n---\n正文"), "标题 · 正文");
  assert.equal(documentPreview(""), "");
});
