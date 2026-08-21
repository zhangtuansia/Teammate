/**
 * Queue, mid-stream delivery, cancellation, and terminal semantics are
 * adapted from Craft Agents (Copyright 2026 Craft Docs Ltd., Apache-2.0).
 * Teammate changes isolate a provider-neutral state machine and add explicit
 * generation/turn fencing. See ../LICENSE and ../NOTICE.
 */

export type MidStreamBehavior = "queue" | "steer";
export type SteerOutcome = "accepted" | "rejected" | "unsupported";
export type ExecutionPhase = "idle" | "running" | "cancelling" | "disposed";

export type ExecutionTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "timed_out";

export interface ExecutionTerminal {
  status: ExecutionTerminalStatus;
  message?: string;
  sessionId?: string;
}

export interface ExecutionTurnRef {
  generation: number;
  turnId: number;
}

export interface ExecutionTurnOptions<ThinkingLevel extends string = string> {
  midStreamBehavior?: MidStreamBehavior;
  thinkingLevel?: ThinkingLevel;
}

export interface ResolvedExecutionTurnOptions<ThinkingLevel extends string = string> {
  midStreamBehavior: MidStreamBehavior;
  thinkingLevel?: ThinkingLevel;
}

export interface ExecutionTurn<Payload, ThinkingLevel extends string = string>
  extends ExecutionTurnRef {
  payload: Payload;
  options: ResolvedExecutionTurnOptions<ThinkingLevel>;
}

export interface ExecutionSessionDefaults<ThinkingLevel extends string = string> {
  midStreamBehavior?: MidStreamBehavior;
  thinkingLevel?: ThinkingLevel;
}

export interface ExecutionBackendCapabilities<ThinkingLevel extends string = string> {
  steer: boolean;
  cancel: boolean;
  thinkingLevels?: readonly ThinkingLevel[];
}

export interface ExecutionBackend<Input, ThinkingLevel extends string = string> {
  readonly capabilities: ExecutionBackendCapabilities<ThinkingLevel>;
  /**
   * Dispatches input to the backend. Resolution is only a dispatch-level
   * acknowledgement; completion must arrive as a normalized terminal event.
   */
  send(turn: ExecutionTurn<Input, ThinkingLevel>): Promise<void>;
  steer?(input: Input, activeTurn: ExecutionTurnRef): boolean | Promise<boolean>;
  cancel?(reason: string, activeTurn: ExecutionTurnRef): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export type ExecutionSubmitResult<Payload, ThinkingLevel extends string = string> =
  | {
      kind: "started";
      turn: ExecutionTurn<Payload, ThinkingLevel>;
    }
  | {
      kind: "queued";
      queueLength: number;
      interruptActive: boolean;
    }
  | {
      kind: "steered";
      activeTurn: ExecutionTurnRef;
    }
  | {
      kind: "rejected";
      reason: "disposed";
    };

export type ExecutionFinishResult<Payload, ThinkingLevel extends string = string> =
  | {
      accepted: true;
      turn: ExecutionTurn<Payload, ThinkingLevel>;
      terminal: ExecutionTerminal;
    }
  | {
      accepted: false;
      reason: "duplicate" | "stale" | "no-active-turn" | "disposed";
    };

export interface ExecutionCancelResult<Payload, ThinkingLevel extends string = string> {
  activeTurn: ExecutionTurn<Payload, ThinkingLevel> | null;
  dropped: Array<{
    payload: Payload;
    options: ResolvedExecutionTurnOptions<ThinkingLevel>;
  }>;
  terminal: ExecutionTerminal | null;
}

export interface ExecutionSessionSnapshot {
  phase: ExecutionPhase;
  generation: number;
  activeTurn: ExecutionTurnRef | null;
  queueLength: number;
}

export type NormalizedExecutionEvent<Activity = unknown> =
  | { type: "session"; generation: number; sessionId: string }
  | {
      type: "activity";
      generation: number;
      turn: ExecutionTurnRef | null;
      activity: Activity;
      label: string;
      detail?: string;
    }
  | {
      type: "output";
      generation: number;
      turn: ExecutionTurnRef;
      text: string;
      final: boolean;
    }
  | {
      type: "context-compacting";
      generation: number;
      turn: ExecutionTurnRef;
    }
  | {
      type: "terminal";
      generation: number;
      turn: ExecutionTurnRef;
      terminal: ExecutionTerminal;
    };
