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
import { canEditAsRichText } from "../../web/src/lib/markdown-round-trip.ts";
import {
  collapseBlankLines,
  tightenMarkdownLists,
  unpadMarkdownTables,
} from "../../web/src/lib/markdown-normalize.ts";
import { preferredEmojiForm, reactionKey } from "../../web/src/lib/emoji.ts";
import {
  FOLDER_IMPORT_FILE_LIMIT,
  documentPlacement,
  filesFromDrop,
  formatOf,
  planFolderImport,
} from "../../web/src/lib/folder-import.ts";
import { ancestorPaths, buildDocumentTree } from "../../web/src/lib/document-tree.ts";
import {
  documentIdFromHref,
  documentLinkMarkdown,
} from "../../../packages/shared/src/index.ts";

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

test("rich text editing is offered only where markdown survives the round trip", () => {
  // A person edits what a teammate wrote. The editor holds only what its
  // extensions know, so anything else would come back changed — and a table an
  // agent spent a turn producing must not vanish on someone's first save.
  assert.equal(canEditAsRichText("# 标题\n\n- 一\n- 二\n\n**粗体** 和 `代码`。"), true);
  assert.equal(canEditAsRichText("段落\n\n> 引用\n\n1. 第一\n2. 第二"), true);

  // Tables came off the unsupported list when the table extension went in and
  // the round trip was checked, which is the only way something should leave it.
  assert.equal(canEditAsRichText("| 接口 | 状态 |\n| --- | --- |\n| /a | ok |"), true);
  assert.equal(canEditAsRichText("<div>raw</div>"), false);
  assert.equal(canEditAsRichText("脚注[^1]\n\n[^1]: 说明"), false);
});

test("saving a document does not loosen its lists", () => {
  // The editor writes a blank line between items, which makes the list loose:
  // it renders with extra spacing and every save shows up as a diff to whoever
  // reads the document next through the CLI.
  assert.equal(
    tightenMarkdownLists("- [x] 冒烟测试\n\n- [x] 灰度\n\n- [ ] 全量"),
    "- [x] 冒烟测试\n- [x] 灰度\n- [ ] 全量",
  );
  assert.equal(tightenMarkdownLists("1. 一\n\n2. 二"), "1. 一\n2. 二");

  // Spacing that belongs to the author stays: around the list, and between a
  // list and the prose next to it.
  assert.equal(
    tightenMarkdownLists("段落\n\n- 一\n- 二\n\n下一段"),
    "段落\n\n- 一\n- 二\n\n下一段",
  );
  // A nested item starts a different list, so the blank line is not ours to
  // remove.
  assert.equal(tightenMarkdownLists("- 一\n\n  - 嵌套"), "- 一\n\n  - 嵌套");
});

test("saving a document does not add blank lines to it", () => {
  // The serializer leaves two blank lines where the author wrote one. Markdown
  // reads them the same, but the document is read and rewritten by teammates
  // through the CLI, where the extra line is a diff on every save.
  assert.equal(collapseBlankLines("# 标题\n\n\n正文"), "# 标题\n\n正文");
  assert.equal(collapseBlankLines("a\n\n\n\n\nb"), "a\n\nb");
  assert.equal(collapseBlankLines("a\n\nb"), "a\n\nb");

  // Blank lines inside a fence are content, not layout.
  assert.equal(
    collapseBlankLines("```py\nx = 1\n\n\ny = 2\n```"),
    "```py\nx = 1\n\n\ny = 2\n```",
  );
});

test("saving a document does not repad its tables", () => {
  // One cell is edited; the rest of the table must not show as changed.
  assert.equal(
    unpadMarkdownTables(
      "| 接口         | 状态   |\n| ---------- | ---- |\n| /api/query | 已完成  |",
    ),
    "| 接口 | 状态 |\n| --- | --- |\n| /api/query | 已完成 |",
  );

  // Alignment colons carry meaning and survive.
  assert.equal(unpadMarkdownTables("| :--- | ---: |"), "| :--- | ---: |");

  // Spacing inside a cell is the author's, and a pipe in a code fence is not a
  // table at all.
  assert.equal(unpadMarkdownTables("| a  b | c |"), "| a  b | c |");
  assert.equal(
    unpadMarkdownTables("```\n| not | a  | table |\n```"),
    "```\n| not | a  | table |\n```",
  );
});

test("one emoji is one reaction however it is spelled", () => {
  // The variation selector is invisible, so two spellings would otherwise show
  // as two identical chips side by side on the same message.
  assert.equal(reactionKey("\u{1F44D}️"), reactionKey("\u{1F44D}"));
  assert.equal(reactionKey("❤️"), "❤");

  // Different emoji stay different, and a flag's zero-width joiner is content.
  assert.notEqual(reactionKey("\u{1F44D}"), reactionKey("\u{1F44E}"));
  assert.equal(
    reactionKey("\u{1F3F3}️‍\u{1F308}"),
    "\u{1F3F3}‍\u{1F308}",
  );

  // Of two spellings, the chip shows the one that renders in colour.
  assert.equal(preferredEmojiForm("❤", "❤️"), "❤️");
  assert.equal(preferredEmojiForm("❤️", "❤"), "❤️");
});

test("adding a local folder takes the notes and leaves everything else", () => {
  const file = (path: string, size = 10) =>
    Object.assign(new File(["x".repeat(size)], path.split("/").pop() ?? path), {
      webkitRelativePath: `notes/${path}`,
    });

  const plan = planFolderImport([
    file("readme.md"),
    file("deep/api.markdown"),
    file("photo.png"),
    file(".git/COMMIT_EDITMSG"),
    file("node_modules/pkg/readme.md"),
    file("empty.md", 0),
  ]);

  assert.deepEqual(
    plan.candidates.map((candidate) => candidate.path),
    ["deep/api.markdown", "readme.md"],
  );
  assert.equal(plan.skippedOverLimit, 0);

  // A nested note keeps the folder it came in, rather than having it pressed
  // flat into the title.
  assert.deepEqual(documentPlacement("deep/api.markdown"), {
    folder: "deep",
    format: "markdown",
    title: "api",
  });
  assert.deepEqual(documentPlacement("readme.md"), {
    folder: "",
    format: "markdown",
    title: "readme",
  });

  // Pointing at a huge folder takes a capped number and says how many it left.
  const many = Array.from({ length: FOLDER_IMPORT_FILE_LIMIT + 5 }, (_, index) =>
    file(`note-${String(index).padStart(4, "0")}.md`),
  );
  const capped = planFolderImport(many);
  assert.equal(capped.candidates.length, FOLDER_IMPORT_FILE_LIMIT);
  assert.equal(capped.skippedOverLimit, 5);
});

test("folders in the sidebar are the paths the documents claim", () => {
  const at = (id: string, folder: string, pinnedAt: string | null = null) => ({
    folder_path: folder,
    id,
    pinned_at: pinnedAt,
    title: id,
    updated_at: "2026-08-22 10:00:00",
  });

  const tree = buildDocumentTree([
    at("errors", "api/v2"),
    at("readme", ""),
    at("overview", "api"),
    at("changes", "api/v2"),
  ]);

  // Loose documents stay out of the tree rather than being filed somewhere.
  assert.deepEqual(tree.loose.map((document) => document.id), ["readme"]);

  assert.deepEqual(tree.folders.map((folder) => folder.path), ["api"]);
  const api = tree.folders[0];
  assert.deepEqual(api.documents.map((document) => document.id), ["overview"]);
  // A closed folder still says how much is underneath it, however deep.
  assert.equal(api.totalDocuments, 3);
  assert.deepEqual(api.folders.map((folder) => folder.path), ["api/v2"]);
  assert.equal(api.folders[0].name, "v2");
  assert.equal(api.folders[0].depth, 1);

  // A folder only on the way to another still exists, or the tree would have a
  // branch growing out of nothing.
  const deep = buildDocumentTree([at("only", "a/b/c")]);
  assert.deepEqual(deep.folders.map((folder) => folder.path), ["a"]);
  assert.equal(deep.folders[0].folders[0].folders[0].path, "a/b/c");

  assert.deepEqual(ancestorPaths("api/v2"), ["api", "api/v2"]);
  assert.deepEqual(ancestorPaths(""), []);
});

test("a pinned document is reachable twice, not moved", () => {
  const at = (id: string, folder: string, pinnedAt: string | null = null) => ({
    folder_path: folder,
    id,
    pinned_at: pinnedAt,
    title: id,
    updated_at: "2026-08-22 10:00:00",
  });

  const tree = buildDocumentTree([
    at("errors", "api/v2", "2026-08-22T09:00:00.000Z"),
    at("readme", ""),
    at("overview", "api", "2026-08-22T08:00:00.000Z"),
  ]);

  // Oldest pin first, so pinning something does not shuffle what is already up
  // there out from under the pointer.
  assert.deepEqual(tree.pinned.map((document) => document.id), ["overview", "errors"]);

  // Pinning is a second way to reach a document, so it stays filed where it is.
  assert.equal(tree.folders[0].totalDocuments, 2);
  assert.deepEqual(tree.folders[0].documents.map((document) => document.id), ["overview"]);
  assert.deepEqual(tree.loose.map((document) => document.id), ["readme"]);

  assert.deepEqual(buildDocumentTree([at("readme", "")]).pinned, []);
});

test("dropping a folder reads what is inside it", async () => {
  // dataTransfer.files is empty for a dropped directory — a directory is not a
  // file — so the entries have to be walked instead.
  const fileEntry = (name: string) => ({
    file: (resolve: (file: File) => void) => resolve(new File(["body"], name)),
    isDirectory: false,
    isFile: true,
    name,
  });
  const dirEntry = (name: string, children: unknown[]) => {
    let drained = false;
    return {
      createReader: () => ({
        // readEntries returns a batch at a time and must be called until dry.
        readEntries: (resolve: (entries: unknown[]) => void) => {
          resolve(drained ? [] : children);
          drained = true;
        },
      }),
      isDirectory: true,
      isFile: false,
      name,
    };
  };

  const tree = dirEntry("库", [
    fileEntry("readme.md"),
    dirEntry("接口", [fileEntry("v2.md")]),
  ]);
  const dropped = await filesFromDrop({
    files: [],
    items: [{ kind: "file", webkitGetAsEntry: () => tree }],
  } as unknown as DataTransfer);

  assert.deepEqual(
    dropped.map((file) => (file as File & { webkitRelativePath: string }).webkitRelativePath),
    ["库/readme.md", "库/接口/v2.md"],
  );

  // The dropped folder's own name is stripped, the same way a chosen folder's
  // is, so a note lands in the same place whichever way it arrived.
  const plan = planFolderImport(dropped);
  assert.deepEqual(
    plan.candidates.map((candidate) => documentPlacement(candidate.path)),
    // Sorted by path, so the Latin name sorts ahead of the CJK folder.
    [
      { folder: "", format: "markdown", title: "readme" },
      { folder: "接口", format: "markdown", title: "v2" },
    ],
  );

  // Plain files dropped on their own have no entries to walk.
  const loose = await filesFromDrop({
    files: [new File(["x"], "note.md")],
    items: [{ kind: "file", webkitGetAsEntry: () => null }],
  } as unknown as DataTransfer);
  assert.deepEqual(loose.map((file) => file.name), ["note.md"]);
});

test("a document reference is one format across chat, documents and the CLI", () => {
  // The CLI prints this for an agent to paste and the renderer reads it back,
  // so the two have to agree exactly — they are different processes.
  assert.equal(
    documentLinkMarkdown("02ea4fb3", "关于会议场景的一些看法"),
    "[关于会议场景的一些看法](teammate:document/02ea4fb3)",
  );
  assert.equal(documentIdFromHref("teammate:document/02ea4fb3"), "02ea4fb3");

  // Brackets in a title would end the link text early and break the reference.
  assert.equal(
    documentLinkMarkdown("abc123", "Q3 [draft] plan"),
    "[Q3 draft plan](teammate:document/abc123)",
  );
  assert.equal(documentLinkMarkdown("abc123", ""), "[Untitled](teammate:document/abc123)");

  // Anything that is not one of ours stays out of the document renderer, which
  // navigates without asking. A crafted href must not reach it.
  for (const href of [
    "https://example.com",
    "teammate:document/../../etc",
    "teammate:document/<script>",
    "teammate:agent/02ea4fb3",
    "javascript:alert(1)",
    "",
    undefined,
  ]) {
    assert.equal(documentIdFromHref(href), null, `should not resolve: ${String(href)}`);
  }
});

test("a page saved elsewhere imports as html, notes stay markdown", () => {
  assert.equal(formatOf("wireframe.html"), "html");
  assert.equal(formatOf("legacy/index.htm"), "html");
  assert.equal(formatOf("notes/plan.md"), "markdown");
  assert.equal(formatOf("README"), "markdown");

  // The extension comes off the title whichever it was, so a document is not
  // called "wireframe.html" in a list that already knows its format.
  assert.deepEqual(documentPlacement("design/wireframe.html"), {
    folder: "design",
    format: "html",
    title: "wireframe",
  });
  assert.deepEqual(documentPlacement("notes/plan.md"), {
    folder: "notes",
    format: "markdown",
    title: "plan",
  });

  // An .html file is now taken rather than skipped as "not text".
  const file = (name: string) =>
    Object.assign(new File(["<h1>hi</h1>"], name), { webkitRelativePath: `root/${name}` });
  assert.deepEqual(
    planFolderImport([file("page.html"), file("photo.png"), file("plan.md")])
      .candidates.map((candidate) => candidate.path),
    ["page.html", "plan.md"],
  );
});
