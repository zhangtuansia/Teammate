import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionRuntimeAdapter } from "../src/execution-runtime-adapter.js";
import type { AgentRuntimeHandle } from "../src/runtimes/types.js";

function fakeHandle(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: "codex",
    sessionId: null,
    isRunning: () => true,
    send: async () => undefined,
    stop: () => undefined,
    ...overrides,
  } as unknown as AgentRuntimeHandle;
}

test("runtime capabilities must be explicitly declared", () => {
  const undeclared = new ExecutionRuntimeAdapter(1);
  undeclared.attach(fakeHandle({ steer: () => true, cancel: () => undefined }));
  assert.deepEqual(undeclared.capabilities, { steer: false, cancel: false });

  const declared = new ExecutionRuntimeAdapter<"low" | "high">(1);
  declared.attach(fakeHandle({
    executionCapabilities: {
      steer: true,
      cancel: true,
      thinkingLevels: ["low", "high"],
    },
    steer: () => true,
    cancel: () => undefined,
  }));
  assert.deepEqual(declared.capabilities, {
    steer: true,
    cancel: true,
    thinkingLevels: ["low", "high"],
  });
});

test("the adapter claims a runtime terminal exactly once before async handling", () => {
  const adapter = new ExecutionRuntimeAdapter(3);
  adapter.attach(fakeHandle());
  adapter.bindTurn({ generation: 3, turnId: 7 });

  assert.deepEqual(adapter.normalize({ type: "turn-complete", sessionId: "session-a" }), {
    type: "terminal",
    generation: 3,
    turn: { generation: 3, turnId: 7 },
    terminal: { status: "completed", sessionId: "session-a" },
  });
  assert.equal(adapter.normalize({ type: "turn-complete" }), null);
  assert.equal(adapter.normalizeDispatchFailure(
    { generation: 3, turnId: 7 },
    new Error("late rejection"),
  ), null);
});

test("adapter rejects a turn from another runtime generation", () => {
  const adapter = new ExecutionRuntimeAdapter(4);
  assert.throws(
    () => adapter.bindTurn({ generation: 3, turnId: 1 }),
    /different runtime generation/,
  );
});

test("unsupported steer safely reports unsupported without calling a hidden method", async () => {
  let calls = 0;
  const adapter = new ExecutionRuntimeAdapter(1);
  adapter.attach(fakeHandle({
    steer: () => {
      calls += 1;
      return true;
    },
  }));
  adapter.bindTurn({ generation: 1, turnId: 1 });

  assert.equal(await adapter.trySteer("next", { generation: 1, turnId: 1 }), "unsupported");
  assert.equal(calls, 0);
});

test("timeout claims the bound turn once and fences a late backend terminal", () => {
  const adapter = new ExecutionRuntimeAdapter(5);
  adapter.attach(fakeHandle());
  const turn = { generation: 5, turnId: 9 };
  adapter.bindTurn(turn);

  assert.deepEqual(adapter.normalizeTimeout(turn, "deadline reached"), {
    type: "terminal",
    generation: 5,
    turn,
    terminal: { status: "timed_out", message: "deadline reached" },
  });
  assert.equal(adapter.normalizeTimeout(turn, "duplicate timeout"), null);
  assert.equal(adapter.normalize({ type: "turn-complete" }), null);
  assert.equal(
    adapter.normalizeDispatchFailure(turn, new Error("late dispatch rejection")),
    null,
  );
});
