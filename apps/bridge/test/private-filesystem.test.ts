import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AgentManager } from "../src/agent-manager.js";

function supabaseStub() {
  return {
    channel: () => ({ subscribe: () => undefined }),
    from: () => ({
      update: () => ({
        eq: async () => ({ data: null, error: null }),
      }),
    }),
  } as unknown as SupabaseClient;
}

test("existing agent workspaces and memory converge to private POSIX modes", {
  skip: process.platform === "win32",
}, async (t) => {
  const previousUmask = process.umask();
  t.after(() => process.umask(previousUmask));
  const root = await mkdtemp(join(tmpdir(), "teammate-private-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentsDir = join(root, "agents");
  const agentId = "00000000-0000-4000-8000-000000000001";
  const workDir = join(agentsDir, agentId);
  const notesDir = join(workDir, "notes");
  const memoryPath = join(workDir, "MEMORY.md");
  await mkdir(notesDir, { recursive: true, mode: 0o755 });
  await writeFile(memoryPath, "legacy private memory", { mode: 0o644 });
  for (const path of [agentsDir, workDir, notesDir]) await chmod(path, 0o755);
  await chmod(memoryPath, 0o644);

  const manager = new AgentManager(agentsDir, supabaseStub(), "", "");
  await manager.initAgent(agentId, {
    id: agentId,
    name: "local-assistant",
    display_name: "Local Assistant",
    description: null,
    system_prompt: null,
    runtime: "codex",
    model: "default",
    status: "offline",
  });

  for (const path of [agentsDir, workDir, notesDir]) {
    assert.equal((await stat(path)).mode & 0o777, 0o700);
  }
  assert.equal((await stat(memoryPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(memoryPath, "utf8"), "legacy private memory");
  assert.equal(process.umask(), 0o077);
});

test("a new agent memory file starts private", {
  skip: process.platform === "win32",
}, async (t) => {
  const previousUmask = process.umask();
  t.after(() => process.umask(previousUmask));
  const root = await mkdtemp(join(tmpdir(), "teammate-private-new-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentsDir = join(root, "agents");
  const agentId = "00000000-0000-4000-8000-000000000002";
  const manager = new AgentManager(agentsDir, supabaseStub(), "", "");

  await manager.initAgent(agentId, {
    id: agentId,
    name: "new-agent",
    display_name: "New Agent",
    description: "Testing",
    system_prompt: null,
    runtime: "codex",
    model: "default",
    status: "offline",
  });

  assert.equal((await stat(join(agentsDir, agentId))).mode & 0o777, 0o700);
  assert.equal((await stat(join(agentsDir, agentId, "MEMORY.md"))).mode & 0o777, 0o600);
});
