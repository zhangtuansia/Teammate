/**
 * State-machine semantics are adapted from Craft Agents' mid-stream queue and
 * completion handling (Copyright 2026 Craft Docs Ltd., Apache-2.0).
 * This modified implementation is provider-neutral and adds bounded terminal
 * history plus generation/turn fencing. See ../LICENSE and ../NOTICE.
 */

import type {
  ExecutionCancelResult,
  ExecutionFinishResult,
  ExecutionPhase,
  ExecutionSessionDefaults,
  ExecutionSessionSnapshot,
  ExecutionSubmitResult,
  ExecutionTerminal,
  ExecutionTurn,
  ExecutionTurnOptions,
  ExecutionTurnRef,
  MidStreamBehavior,
  ResolvedExecutionTurnOptions,
  SteerOutcome,
} from "./types.js";

const TERMINAL_HISTORY_LIMIT = 64;
const MAX_WATCHDOG_DELAY_MS = 2_147_483_647;

interface QueuedTurn<Payload, ThinkingLevel extends string> {
  payload: Payload;
  options: ResolvedExecutionTurnOptions<ThinkingLevel>;
}

interface ArmedWatchdog {
  turn: ExecutionTurnRef;
  timer: ReturnType<typeof setTimeout>;
  token: object;
}

export interface MidStreamDeliveryOutcome {
  delivery: "queued" | "steered";
  interruptActive: boolean;
}

export function resolveMidStreamDeliveryOutcome(
  behavior: MidStreamBehavior,
  steerOutcome: SteerOutcome = "unsupported",
): MidStreamDeliveryOutcome {
  if (behavior !== "steer") {
    return { delivery: "queued", interruptActive: false };
  }
  if (steerOutcome === "accepted") {
    return { delivery: "steered", interruptActive: false };
  }
  return {
    delivery: "queued",
    interruptActive: steerOutcome === "rejected",
  };
}

export class ExecutionSession<Payload, ThinkingLevel extends string = string> {
  private phaseValue: ExecutionPhase = "idle";
  private generationValue = 1;
  private nextTurnId = 1;
  private activeValue: ExecutionTurn<Payload, ThinkingLevel> | null = null;
  private readonly queue: Array<QueuedTurn<Payload, ThinkingLevel>> = [];
  private readonly terminalKeys = new Set<string>();
  private readonly terminalOrder: string[] = [];
  private defaults: ResolvedExecutionTurnOptions<ThinkingLevel>;
  private watchdog: ArmedWatchdog | null = null;

  constructor(defaults: ExecutionSessionDefaults<ThinkingLevel> = {}) {
    this.defaults = this.resolveOptions(defaults);
  }

  get phase() {
    return this.phaseValue;
  }

  get generation() {
    return this.generationValue;
  }

  get activeTurn(): ExecutionTurn<Payload, ThinkingLevel> | null {
    return this.activeValue;
  }

  get queueLength() {
    return this.queue.length;
  }

  get snapshot(): ExecutionSessionSnapshot {
    return {
      phase: this.phaseValue,
      generation: this.generationValue,
      activeTurn: this.activeValue ? this.refOf(this.activeValue) : null,
      queueLength: this.queue.length,
    };
  }

  updateDefaults(defaults: ExecutionSessionDefaults<ThinkingLevel>) {
    this.defaults = this.resolveOptions({ ...this.defaults, ...defaults });
  }

  submit(
    payload: Payload,
    options: ExecutionTurnOptions<ThinkingLevel> & { steerOutcome?: SteerOutcome } = {},
  ): ExecutionSubmitResult<Payload, ThinkingLevel> {
    if (this.phaseValue === "disposed") {
      return { kind: "rejected", reason: "disposed" };
    }

    const resolved = this.resolveOptions(options);
    if (this.phaseValue === "idle") {
      return { kind: "started", turn: this.startTurn(payload, resolved) };
    }

    if (this.phaseValue === "running" && this.activeValue) {
      const outcome = resolveMidStreamDeliveryOutcome(
        resolved.midStreamBehavior,
        options.steerOutcome,
      );
      if (outcome.delivery === "steered") {
        return { kind: "steered", activeTurn: this.refOf(this.activeValue) };
      }
      this.queue.push({ payload, options: resolved });
      return {
        kind: "queued",
        queueLength: this.queue.length,
        interruptActive: outcome.interruptActive,
      };
    }

    this.queue.push({ payload, options: resolved });
    return {
      kind: "queued",
      queueLength: this.queue.length,
      interruptActive: false,
    };
  }

  enqueue(
    payload: Payload,
    options: ExecutionTurnOptions<ThinkingLevel> = {},
  ): ExecutionSubmitResult<Payload, ThinkingLevel> {
    if (this.phaseValue === "disposed") {
      return { kind: "rejected", reason: "disposed" };
    }
    this.queue.push({ payload, options: this.resolveOptions(options) });
    return {
      kind: "queued",
      queueLength: this.queue.length,
      interruptActive: false,
    };
  }

  dequeue(): { payload: Payload; options: ResolvedExecutionTurnOptions<ThinkingLevel> } | null {
    if (this.phaseValue !== "idle") return null;
    return this.queue.shift() ?? null;
  }

  /** Read the next queued payload without removing it. Null when the session
   * is not idle, mirroring dequeue's guard. */
  peekQueue(): Payload | null {
    if (this.phaseValue !== "idle") return null;
    return this.queue[0]?.payload ?? null;
  }

  armWatchdog(
    turn: ExecutionTurnRef,
    timeoutMs: number,
    onTimeout: (turn: ExecutionTurnRef) => void,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WATCHDOG_DELAY_MS) {
      throw new RangeError("Execution watchdog timeout must be between 1 and 2147483647 ms");
    }
    if (!this.isCurrent(turn)) return false;

    this.clearWatchdog();
    const turnRef = this.refOf(turn);
    const token = {};
    const timer = setTimeout(() => {
      if (this.watchdog?.token !== token) return;
      this.watchdog = null;
      if (!this.isCurrent(turnRef)) return;
      onTimeout(this.refOf(turnRef));
    }, Math.floor(timeoutMs));
    timer.unref?.();
    this.watchdog = { turn: turnRef, timer, token };
    return true;
  }

  clearWatchdog(turn?: ExecutionTurnRef) {
    if (!this.watchdog) return false;
    if (turn && !this.matches(this.watchdog.turn, turn)) return false;
    clearTimeout(this.watchdog.timer);
    this.watchdog = null;
    return true;
  }

  finish(
    turn: ExecutionTurnRef,
    terminal: ExecutionTerminal,
  ): ExecutionFinishResult<Payload, ThinkingLevel> {
    const key = this.turnKey(turn);
    if (this.phaseValue === "disposed") {
      return { accepted: false, reason: "disposed" };
    }
    if (!this.activeValue) {
      return {
        accepted: false,
        reason: this.terminalKeys.has(key) ? "duplicate" : "no-active-turn",
      };
    }
    if (!this.matches(this.activeValue, turn)) {
      return {
        accepted: false,
        reason: this.terminalKeys.has(key) ? "duplicate" : "stale",
      };
    }

    const completed = this.activeValue;
    this.clearWatchdog(turn);
    this.activeValue = null;
    this.phaseValue = "idle";
    this.rememberTerminal(turn);
    return { accepted: true, turn: completed, terminal };
  }

  isCurrent(turn: ExecutionTurnRef) {
    return this.phaseValue === "running" &&
      this.activeValue !== null &&
      this.matches(this.activeValue, turn);
  }

  cancel(reason = "Execution cancelled"): ExecutionCancelResult<Payload, ThinkingLevel> {
    const dropped = this.queue.splice(0);
    const activeTurn = this.activeValue;
    const terminal = activeTurn
      ? { status: "cancelled" as const, message: reason }
      : null;
    if (activeTurn) {
      this.clearWatchdog(activeTurn);
      this.rememberTerminal(activeTurn);
    } else {
      this.clearWatchdog();
    }
    this.activeValue = null;
    if (this.phaseValue !== "disposed") {
      this.phaseValue = activeTurn ? "cancelling" : "idle";
    }
    return { activeTurn, dropped, terminal };
  }

  completeCancellation() {
    if (this.phaseValue === "cancelling") this.phaseValue = "idle";
  }

  rotateGeneration() {
    if (this.phaseValue !== "idle" || this.activeValue) {
      throw new Error("Cannot rotate an execution generation while a turn is active");
    }
    this.clearWatchdog();
    this.generationValue += 1;
    return this.generationValue;
  }

  dispose(reason = "Execution session disposed"): ExecutionCancelResult<Payload, ThinkingLevel> {
    if (this.phaseValue === "disposed") {
      return { activeTurn: null, dropped: [], terminal: null };
    }
    const result = this.cancel(reason);
    this.phaseValue = "disposed";
    return result;
  }

  private startTurn(
    payload: Payload,
    options: ResolvedExecutionTurnOptions<ThinkingLevel>,
  ) {
    this.clearWatchdog();
    const turn: ExecutionTurn<Payload, ThinkingLevel> = {
      generation: this.generationValue,
      turnId: this.nextTurnId++,
      payload,
      options,
    };
    this.activeValue = turn;
    this.phaseValue = "running";
    return turn;
  }

  private resolveOptions(
    options: ExecutionSessionDefaults<ThinkingLevel>,
  ): ResolvedExecutionTurnOptions<ThinkingLevel> {
    const thinkingLevel = options.thinkingLevel ?? this.defaults?.thinkingLevel;
    return {
      midStreamBehavior: options.midStreamBehavior ?? this.defaults?.midStreamBehavior ?? "queue",
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }

  private matches(left: ExecutionTurnRef, right: ExecutionTurnRef) {
    return left.generation === right.generation && left.turnId === right.turnId;
  }

  private refOf(turn: ExecutionTurnRef): ExecutionTurnRef {
    return { generation: turn.generation, turnId: turn.turnId };
  }

  private turnKey(turn: ExecutionTurnRef) {
    return `${turn.generation}:${turn.turnId}`;
  }

  private rememberTerminal(turn: ExecutionTurnRef) {
    const key = this.turnKey(turn);
    if (this.terminalKeys.has(key)) return;
    this.terminalKeys.add(key);
    this.terminalOrder.push(key);
    const expired = this.terminalOrder.length > TERMINAL_HISTORY_LIMIT
      ? this.terminalOrder.shift()
      : undefined;
    if (expired) this.terminalKeys.delete(expired);
  }
}
