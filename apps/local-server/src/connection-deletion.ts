export interface ConnectionDeletionGuard {
  exists: boolean;
  inUseByAgents: number;
  isDefault: boolean;
}

export interface ConnectionDeletionDependencies {
  inspectGuard: () => ConnectionDeletionGuard;
  deleteCredential: () => Promise<void>;
  deleteRowIfUnguarded: () => boolean;
  markNeedsAuth: () => void;
}

export type ConnectionDeletionResult =
  | { kind: "deleted" }
  | { kind: "not-found" }
  | {
      kind: "blocked";
      credentialRemoved: boolean;
      inUseByAgents: number;
      isDefault: boolean;
    }
  | { kind: "credential-error"; error: unknown }
  | { kind: "database-error"; error: unknown };

const deletionQueues = new Map<string, Promise<void>>();

async function withConnectionDeletionLock<T>(
  connectionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = deletionQueues.get(connectionId) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  deletionQueues.set(connectionId, settled);
  try {
    return await current;
  } finally {
    if (deletionQueues.get(connectionId) === settled) {
      deletionQueues.delete(connectionId);
    }
  }
}

/**
 * Removes secrets before metadata while preserving a recoverable row whenever
 * the metadata deletion cannot be completed. The database callback must make
 * its guard and deletion one atomic statement/transaction.
 */
export async function deleteConnectionSafely(
  connectionId: string,
  dependencies: ConnectionDeletionDependencies,
): Promise<ConnectionDeletionResult> {
  return withConnectionDeletionLock(connectionId, async () => {
    const initialGuard = dependencies.inspectGuard();
    if (!initialGuard.exists) return { kind: "not-found" };
    if (initialGuard.inUseByAgents > 0 || initialGuard.isDefault) {
      return {
        kind: "blocked",
        credentialRemoved: false,
        inUseByAgents: initialGuard.inUseByAgents,
        isDefault: initialGuard.isDefault,
      };
    }

    try {
      await dependencies.deleteCredential();
    } catch (error) {
      return { kind: "credential-error", error };
    }

    try {
      if (dependencies.deleteRowIfUnguarded()) return { kind: "deleted" };

      const finalGuard = dependencies.inspectGuard();
      if (!finalGuard.exists) return { kind: "deleted" };
      dependencies.markNeedsAuth();
      return {
        kind: "blocked",
        credentialRemoved: true,
        inUseByAgents: finalGuard.inUseByAgents,
        isDefault: finalGuard.isDefault,
      };
    } catch (error) {
      try {
        dependencies.markNeedsAuth();
      } catch {
        // The missing credential still makes the retained row read as needs-auth.
      }
      return { kind: "database-error", error };
    }
  });
}
