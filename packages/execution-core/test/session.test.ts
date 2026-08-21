/**
 * The queue/steer cases are adapted from Craft Agents' midstream queue tests
 * (Copyright 2026 Craft Docs Ltd., Apache-2.0) and extended with Teammate's
 * generation and exactly-once terminal requirements.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionSession,
  resolveMidStreamDeliveryOutcome,
} from "../src/index.js";

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

test("queue and steer outcomes preserve the Craft mid-stream contract", () => {
  assert.deepEqual(resolveMidStreamDeliveryOutcome("queue", "unsupported"), {
    delivery: "queued",
    interruptActive: false,
  });
  assert.deepEqual(resolveMidStreamDeliveryOutcome("steer", "accepted"), {
    delivery: "steered",
    interruptActive: false,
  });
  assert.deepEqual(resolveMidStreamDeliveryOutcome("steer", "rejected"), {
    delivery: "queued",
    interruptActive: true,
  });
  assert.deepEqual(resolveMidStreamDeliveryOutcome("steer", "unsupported"), {
    delivery: "queued",
    interruptActive: false,
  });
});

test("queued turns replay in FIFO order with their per-turn config", () => {
  const session = new ExecutionSession<string, "low" | "high">({
    midStreamBehavior: "queue",
    thinkingLevel: "low",
  });
  const first = session.submit("first");
  assert.equal(first.kind, "started");
  assert.equal(session.submit("second", { thinkingLevel: "high" }).kind, "queued");
  assert.equal(session.submit("third").kind, "queued");
  assert.equal(session.queueLength, 2);

  if (first.kind !== "started") return;
  assert.equal(session.finish(first.turn, { status: "completed" }).accepted, true);
  assert.deepEqual(session.dequeue(), {
    payload: "second",
    options: { midStreamBehavior: "queue", thinkingLevel: "high" },
  });
  assert.deepEqual(session.dequeue(), {
    payload: "third",
    options: { midStreamBehavior: "queue", thinkingLevel: "low" },
  });
});

test("peekQueue reads the next payload without draining and honors the idle guard", () => {
  const session = new ExecutionSession<string>();
  const active = session.submit("active");
  assert.equal(active.kind, "started");
  session.enqueue("waiting");
  assert.equal(session.peekQueue(), null);

  if (active.kind !== "started") return;
  session.finish(active.turn, { status: "completed" });
  assert.equal(session.peekQueue(), "waiting");
  assert.equal(session.queueLength, 1);
  assert.equal(session.dequeue()?.payload, "waiting");
  assert.equal(session.peekQueue(), null);
});

test("transport restart can hold a turn without pretending it is active", () => {
  const session = new ExecutionSession<string>();
  assert.deepEqual(session.enqueue("during restart"), {
    kind: "queued",
    queueLength: 1,
    interruptActive: false,
  });
  assert.equal(session.phase, "idle");
  assert.equal(session.activeTurn, null);
  assert.equal(session.dequeue()?.payload, "during restart");
});

test("accepted steer joins the active turn while unsupported steer safely queues", () => {
  const session = new ExecutionSession<string>({ midStreamBehavior: "steer" });
  const first = session.submit("first");
  assert.equal(first.kind, "started");
  const steered = session.submit("steered", { steerOutcome: "accepted" });
  assert.equal(steered.kind, "steered");
  assert.equal(session.queueLength, 0);
  const queued = session.submit("fallback", { steerOutcome: "unsupported" });
  assert.deepEqual(queued, { kind: "queued", queueLength: 1, interruptActive: false });
});

test("a terminal is accepted exactly once and stale turns cannot finish a newer turn", () => {
  const session = new ExecutionSession<string>();
  const first = session.submit("first");
  assert.equal(first.kind, "started");
  if (first.kind !== "started") return;

  assert.equal(session.finish(first.turn, { status: "completed" }).accepted, true);
  assert.deepEqual(session.finish(first.turn, { status: "completed" }), {
    accepted: false,
    reason: "duplicate",
  });

  const second = session.submit("second");
  assert.equal(second.kind, "started");
  if (second.kind !== "started") return;
  assert.deepEqual(session.finish(first.turn, { status: "failed" }), {
    accepted: false,
    reason: "duplicate",
  });
  assert.equal(session.isCurrent(second.turn), true);
});

test("runtime generation rotation fences late events from a replaced backend", () => {
  const session = new ExecutionSession<string>();
  const first = session.submit("first");
  assert.equal(first.kind, "started");
  if (first.kind !== "started") return;
  session.finish(first.turn, { status: "completed" });
  assert.equal(session.rotateGeneration(), 2);
  const second = session.submit("second");
  assert.equal(second.kind, "started");
  if (second.kind !== "started") return;

  assert.deepEqual(session.finish({ generation: 1, turnId: 999 }, { status: "failed" }), {
    accepted: false,
    reason: "stale",
  });
  assert.equal(session.isCurrent(second.turn), true);
});

test("cancel terminalizes the active turn once, clears queued work, and fences late terminal", () => {
  const session = new ExecutionSession<string>();
  const first = session.submit("first");
  assert.equal(first.kind, "started");
  if (first.kind !== "started") return;
  session.submit("second");
  session.submit("third");

  const cancelled = session.cancel("user stop");
  assert.equal(cancelled.activeTurn?.payload, "first");
  assert.deepEqual(cancelled.dropped.map((entry) => entry.payload), ["second", "third"]);
  assert.deepEqual(cancelled.terminal, { status: "cancelled", message: "user stop" });
  assert.equal(session.phase, "cancelling");
  assert.deepEqual(session.finish(first.turn, { status: "completed" }), {
    accepted: false,
    reason: "duplicate",
  });
  session.completeCancellation();
  assert.equal(session.phase, "idle");
});

test("watchdog expires only its current generation and turn", async () => {
  const session = new ExecutionSession<string>();
  const first = session.submit("first");
  assert.equal(first.kind, "started");
  if (first.kind !== "started") return;

  const expired: Array<{ generation: number; turnId: number }> = [];
  assert.equal(session.armWatchdog(first.turn, 10, (turn) => expired.push(turn)), true);
  await delay(30);
  assert.deepEqual(expired, [{ generation: 1, turnId: first.turn.turnId }]);

  const terminal = { status: "timed_out" as const, message: "deadline reached" };
  assert.equal(session.finish(expired[0]!, terminal).accepted, true);
  assert.deepEqual(session.finish(expired[0]!, terminal), {
    accepted: false,
    reason: "duplicate",
  });

  session.rotateGeneration();
  const second = session.submit("second");
  assert.equal(second.kind, "started");
  if (second.kind !== "started") return;
  assert.equal(session.isCurrent(first.turn), false);
  assert.equal(session.isCurrent(second.turn), true);
});

test("a real terminal clears the watchdog before its deadline", async () => {
  const session = new ExecutionSession<string>();
  const started = session.submit("first");
  assert.equal(started.kind, "started");
  if (started.kind !== "started") return;

  let timeoutCalls = 0;
  session.armWatchdog(started.turn, 10, () => {
    timeoutCalls += 1;
  });
  assert.equal(session.finish(started.turn, { status: "completed" }).accepted, true);
  await delay(30);
  assert.equal(timeoutCalls, 0);
});

test("watchdog rejects invalid delays and stale turn references", () => {
  const session = new ExecutionSession<string>();
  const started = session.submit("first");
  assert.equal(started.kind, "started");
  if (started.kind !== "started") return;

  assert.throws(() => session.armWatchdog(started.turn, 0, () => undefined), RangeError);
  assert.equal(
    session.armWatchdog(
      { generation: started.turn.generation, turnId: started.turn.turnId + 1 },
      10,
      () => undefined,
    ),
    false,
  );
});
