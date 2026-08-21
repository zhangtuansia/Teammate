import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexRuntime } from "../src/runtimes/codex-runtime.js";
import type { RuntimeEvent } from "../src/runtimes/types.js";

test("Codex emits one visible output and never exposes reasoning detail", async () => {
  const fixture = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "fake-codex.mjs",
  );
  chmodSync(fixture, 0o755);
  const previousCommand = process.env.TEAMMATE_CODEX_PATH;
  process.env.TEAMMATE_CODEX_PATH = fixture;
  const events: RuntimeEvent[] = [];

  try {
    const handle = await new CodexRuntime().start(
      {
        agentId: "agent-1",
        displayName: "Test Agent",
        workDir: process.cwd(),
        systemPrompt: "Test prompt",
        model: "default",
        sessionId: null,
        env: { ...process.env },
      },
      (event) => events.push(event),
    );

    await handle.send("hello");
  } finally {
    if (previousCommand === undefined) delete process.env.TEAMMATE_CODEX_PATH;
    else process.env.TEAMMATE_CODEX_PATH = previousCommand;
  }

  assert.deepEqual(
    events.filter((event) => event.type === "output"),
    [{ type: "output", text: "Visible final answer" }],
  );
  assert.equal(
    events.some(
      (event) => event.type === "activity" && event.detail?.includes("private"),
    ),
    false,
  );
  assert.equal(events.at(-1)?.type, "turn-complete");
});
