import type {
  ExecutionBackendCapabilities,
  ExecutionTurnRef,
  NormalizedExecutionEvent,
  SteerOutcome,
} from "@teammate/execution-core";
import type {
  AgentRuntimeHandle,
  RuntimeActivity,
  RuntimeEvent,
} from "./runtimes/types.js";

export interface RuntimeExecutionCapabilityDeclaration<
  ThinkingLevel extends string = string,
> {
  steer?: true;
  cancel?: true;
  thinkingLevels?: readonly ThinkingLevel[];
}

export interface ExecutionCapableRuntimeHandle<ThinkingLevel extends string = string>
  extends AgentRuntimeHandle {
  readonly executionCapabilities?: RuntimeExecutionCapabilityDeclaration<ThinkingLevel>;
  steer?(message: string, activeTurn: ExecutionTurnRef): boolean | Promise<boolean>;
  cancel?(reason: string, activeTurn: ExecutionTurnRef): void | Promise<void>;
}

function sameTurn(left: ExecutionTurnRef | null, right: ExecutionTurnRef) {
  return left?.generation === right.generation && left.turnId === right.turnId;
}

function copyTurn(turn: ExecutionTurnRef): ExecutionTurnRef {
  return { generation: turn.generation, turnId: turn.turnId };
}

/**
 * Tags the legacy runtime event stream with one execution generation and turn.
 * A terminal claims and clears that turn synchronously, before asynchronous DB
 * work, so duplicate terminal events cannot drain the queue twice.
 */
export class ExecutionRuntimeAdapter<ThinkingLevel extends string = string> {
  private handle: ExecutionCapableRuntimeHandle<ThinkingLevel> | null = null;
  private activeTurn: ExecutionTurnRef | null = null;

  constructor(readonly generation: number) {}

  attach(handle: AgentRuntimeHandle) {
    this.handle = handle as ExecutionCapableRuntimeHandle<ThinkingLevel>;
  }

  get capabilities(): ExecutionBackendCapabilities<ThinkingLevel> {
    const declaration = this.handle?.executionCapabilities;
    return {
      steer: declaration?.steer === true && typeof this.handle?.steer === "function",
      cancel: declaration?.cancel === true && typeof this.handle?.cancel === "function",
      ...(declaration?.thinkingLevels
        ? { thinkingLevels: declaration.thinkingLevels }
        : {}),
    };
  }

  bindTurn(turn: ExecutionTurnRef) {
    if (turn.generation !== this.generation) {
      throw new Error("Cannot bind a turn from a different runtime generation");
    }
    if (this.activeTurn) {
      throw new Error("Cannot bind a second turn while the runtime is active");
    }
    this.activeTurn = copyTurn(turn);
  }

  releaseTurn(turn: ExecutionTurnRef) {
    if (sameTurn(this.activeTurn, turn)) this.activeTurn = null;
  }

  async trySteer(message: string, turn: ExecutionTurnRef): Promise<SteerOutcome> {
    if (!sameTurn(this.activeTurn, turn) || !this.capabilities.steer || !this.handle?.steer) {
      return "unsupported";
    }
    try {
      return await this.handle.steer(message, turn) ? "accepted" : "rejected";
    } catch {
      return "rejected";
    }
  }

  async cancel(reason: string, turn: ExecutionTurnRef) {
    if (!sameTurn(this.activeTurn, turn) || !this.capabilities.cancel || !this.handle?.cancel) {
      return false;
    }
    this.activeTurn = null;
    await this.handle.cancel(reason, turn);
    return true;
  }

  normalize(event: RuntimeEvent): NormalizedExecutionEvent<RuntimeActivity> | null {
    if (event.type === "session") {
      return { type: "session", generation: this.generation, sessionId: event.sessionId };
    }
    if (event.type === "activity") {
      return {
        type: "activity",
        generation: this.generation,
        turn: this.activeTurn ? copyTurn(this.activeTurn) : null,
        activity: event.activity,
        label: event.label,
        ...(event.detail ? { detail: event.detail } : {}),
      };
    }
    if (!this.activeTurn) return null;
    const turn = copyTurn(this.activeTurn);
    if (event.type === "output") {
      return {
        type: "output",
        generation: this.generation,
        turn,
        text: event.text,
        final: false,
      };
    }
    if (event.type === "context-compacting") {
      return { type: "context-compacting", generation: this.generation, turn };
    }

    this.activeTurn = null;
    if (event.type === "turn-complete") {
      return {
        type: "terminal",
        generation: this.generation,
        turn,
        terminal: {
          status: "completed",
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        },
      };
    }
    return {
      type: "terminal",
      generation: this.generation,
      turn,
      terminal: { status: "failed", message: event.message },
    };
  }

  normalizeDispatchFailure(
    turn: ExecutionTurnRef,
    error: unknown,
  ): NormalizedExecutionEvent<RuntimeActivity> | null {
    if (!sameTurn(this.activeTurn, turn)) return null;
    this.activeTurn = null;
    return {
      type: "terminal",
      generation: this.generation,
      turn: copyTurn(turn),
      terminal: {
        status: "failed",
        message: error instanceof Error ? error.message : "Runtime dispatch failed",
      },
    };
  }

  normalizeTimeout(
    turn: ExecutionTurnRef,
    message: string,
  ): NormalizedExecutionEvent<RuntimeActivity> | null {
    if (!sameTurn(this.activeTurn, turn)) return null;
    this.activeTurn = null;
    return {
      type: "terminal",
      generation: this.generation,
      turn: copyTurn(turn),
      terminal: {
        status: "timed_out",
        message,
      },
    };
  }
}
