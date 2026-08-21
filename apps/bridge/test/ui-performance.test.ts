import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createTrailingRefreshScheduler } from "../../web/src/lib/trailing-refresh.ts";

const webFile = (path: string) => new URL(`../../web/src/${path}`, import.meta.url);
const desktopFile = (path: string) => new URL(`../../desktop/src/${path}`, import.meta.url);

function section(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing section: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Missing section terminator: ${endMarker}`);
  return source.slice(start, end);
}

test("500 agent UPDATE events do not reload home counts or the channel directory", async () => {
  const [home, messageArea] = await Promise.all([
    readFile(webFile("app/s/[slug]/page.tsx"), "utf8"),
    readFile(webFile("components/message-area.tsx"), "utf8"),
  ]);
  const homeRealtime = section(home, ".channel(`server-home:", ".subscribe(");
  const agentRealtime = section(
    messageArea,
    "const agentSubscription = supabase",
    ".subscribe((status: string) => handleRealtimeStatus('agents'",
  );

  let countReloads = 0;
  let directoryReloads = 0;
  for (let index = 0; index < 500; index += 1) {
    if (homeRealtime.includes('event: "UPDATE"')) countReloads += 1;
    if (/loadAgentMembers|agentDirectoryRefresh/.test(agentRealtime)) directoryReloads += 1;
  }

  assert.equal(countReloads, 0);
  assert.equal(directoryReloads, 0);
  assert.match(agentRealtime, /channelAgentsRef\.current\.has\(update\.id\)/);
  assert.match(agentRealtime, /patchAgentInfo\(existing, update\)/);
});

test("500 sidebar refresh requests collapse into one trailing single-flight run", async () => {
  let refreshes = 0;
  const refresh = createTrailingRefreshScheduler(() => {
    refreshes += 1;
  }, 5);

  for (let index = 0; index < 500; index += 1) refresh.schedule();
  await new Promise((resolve) => setTimeout(resolve, 25));
  refresh.cancel();
  assert.equal(refreshes, 1);

  const sidebar = await readFile(webFile("components/sidebar.tsx"), "utf8");
  const realtime = section(sidebar, "const realtimeSub = supabase", ".subscribe();");
  assert.match(realtime, /workspaceViewRef\.current/);
  assert.match(realtime, /currentChannelIdsRef\.current\.has\(channelId\)/);
  assert.match(realtime, /scheduleSidebarRefresh\(\)/);
});

test("task assignee options are grouped once and popup items mount lazily", async () => {
  const workspace = await readFile(desktopFile("workspace-section.tsx"), "utf8");
  const grouping = section(
    workspace,
    "const { assigneeItemsByChannel, assigneeOptionsByChannel }",
    "const effectiveCreateChannelId",
  );

  assert.match(grouping, /for \(const membership of channelMemberships\)/);
  assert.doesNotMatch(grouping, /channelMemberships\.flatMap/);
  assert.doesNotMatch(workspace, /taskAssigneeOptions\.map/);
  assert.match(workspace, /open && items\.map/);
});

test("setup polling and agent creation have bounded single-flight lifecycles", async () => {
  const setupWizard = await readFile(webFile("components/setup-wizard.tsx"), "utf8");
  const polling = section(
    setupWizard,
    "// Poll for bridge connection",
    "const npxCommand",
  );
  const createAgent = section(
    setupWizard,
    "async function handleCreateAgent",
    "function handleSkip",
  );

  assert.doesNotMatch(polling, /setInterval/);
  assert.match(polling, /new AbortController\(\)/);
  assert.match(polling, /signal: controller\.signal/);
  assert.match(polling, /controller\.abort\(\)/);
  assert.match(createAgent, /creatingAgentRef\.current/);
  assert.match(createAgent, /window\.setTimeout\(\(\) => controller\.abort\(\), 15_000\)/);
  assert.match(createAgent, /createAgentControllerRef\.current !== controller/);
  assert.match(createAgent, /if \(mountedRef\.current\) setCreatingAgent\(false\)/);
});

test("task board keeps four columns and commits each drop once", async () => {
  const workspace = await readFile(desktopFile("workspace-section.tsx"), "utf8");
  const grouping = section(
    workspace,
    "const TASK_STATUSES",
    "interface TaskViewModel",
  );
  const dropHandler = section(
    workspace,
    "function handleTaskDrop",
    "async function createTask",
  );
  const board = section(
    workspace,
    '<ScrollArea className="min-h-0 flex-1"',
    '<Dialog open={createOpen}',
  );

  assert.match(grouping, /\["todo", "in_progress", "in_review", "done"\]/);
  assert.match(board, /groups\.map\(\(group\)/);
  assert.match(board, /w-72 min-w-72/);
  assert.match(board, /data-drop-target/);
  assert.match(board, /draggable=\{!isUpdating\}/);
  assert.match(board, /items=\{taskAssigneeItems\}/);
  assert.match(board, /items=\{statusItems\}/);
  assert.match(dropHandler, /if \(!session \|\| session\.submitted\) return/);
  assert.match(dropHandler, /session\.submitted = true/);
  assert.equal((dropHandler.match(/void updateTask\(task, \{ status \}\)/g) || []).length, 1);
});
