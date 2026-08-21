import assert from "node:assert/strict";
import test from "node:test";
import { deleteConnectionSafely } from "./connection-deletion.js";

test("connection deletion serializes duplicate requests and rechecks existence", async () => {
  let exists = true;
  let credentialDeletes = 0;
  let releaseCredentialDelete: (() => void) | undefined;
  const credentialDeleteGate = new Promise<void>((resolve) => {
    releaseCredentialDelete = resolve;
  });
  const events: string[] = [];
  const dependencies = {
    inspectGuard: () => ({ exists, inUseByAgents: 0, isDefault: false }),
    deleteCredential: async () => {
      credentialDeletes += 1;
      events.push("credential");
      if (credentialDeletes === 1) await credentialDeleteGate;
    },
    deleteRowIfUnguarded: () => {
      events.push("row");
      if (!exists) return false;
      exists = false;
      return true;
    },
    markNeedsAuth: () => events.push("needs-auth"),
  };

  const first = deleteConnectionSafely("connection-a", dependencies);
  const second = deleteConnectionSafely("connection-a", dependencies);
  await Promise.resolve();
  assert.deepEqual(events, ["credential"]);
  releaseCredentialDelete?.();

  assert.deepEqual(await first, { kind: "deleted" });
  assert.deepEqual(await second, { kind: "not-found" });
  assert.equal(credentialDeletes, 1);
  assert.deepEqual(events, ["credential", "row"]);
});

test("connection deletion leaves credentials untouched when the rechecked guard blocks", async () => {
  let credentialDeletes = 0;
  const result = await deleteConnectionSafely("connection-b", {
    inspectGuard: () => ({ exists: true, inUseByAgents: 2, isDefault: false }),
    deleteCredential: async () => {
      credentialDeletes += 1;
    },
    deleteRowIfUnguarded: () => {
      throw new Error("must not delete row");
    },
    markNeedsAuth: () => {
      throw new Error("must not change status");
    },
  });

  assert.deepEqual(result, {
    kind: "blocked",
    credentialRemoved: false,
    inUseByAgents: 2,
    isDefault: false,
  });
  assert.equal(credentialDeletes, 0);
});

test("database failure after credential removal retains needs-auth recovery state", async () => {
  const events: string[] = [];
  const injectedFailure = new Error("injected database failure");
  const result = await deleteConnectionSafely("connection-c", {
    inspectGuard: () => ({ exists: true, inUseByAgents: 0, isDefault: false }),
    deleteCredential: async () => {
      events.push("credential");
    },
    deleteRowIfUnguarded: () => {
      events.push("row");
      throw injectedFailure;
    },
    markNeedsAuth: () => events.push("needs-auth"),
  });

  assert.equal(result.kind, "database-error");
  if (result.kind === "database-error") assert.equal(result.error, injectedFailure);
  assert.deepEqual(events, ["credential", "row", "needs-auth"]);
});

test("credential deletion failure leaves the database row unchanged", async () => {
  const events: string[] = [];
  const injectedFailure = new Error("injected credential failure");
  const result = await deleteConnectionSafely("connection-credential-error", {
    inspectGuard: () => ({ exists: true, inUseByAgents: 0, isDefault: false }),
    deleteCredential: async () => {
      events.push("credential");
      throw injectedFailure;
    },
    deleteRowIfUnguarded: () => {
      events.push("row");
      return true;
    },
    markNeedsAuth: () => events.push("needs-auth"),
  });

  assert.equal(result.kind, "credential-error");
  if (result.kind === "credential-error") assert.equal(result.error, injectedFailure);
  assert.deepEqual(events, ["credential"]);
});

test("an atomic guard race retains the row as needs-auth", async () => {
  let inUseByAgents = 0;
  const events: string[] = [];
  const result = await deleteConnectionSafely("connection-d", {
    inspectGuard: () => ({ exists: true, inUseByAgents, isDefault: false }),
    deleteCredential: async () => {
      events.push("credential");
      inUseByAgents = 1;
    },
    deleteRowIfUnguarded: () => {
      events.push("atomic-guard");
      return false;
    },
    markNeedsAuth: () => events.push("needs-auth"),
  });

  assert.deepEqual(result, {
    kind: "blocked",
    credentialRemoved: true,
    inUseByAgents: 1,
    isDefault: false,
  });
  assert.deepEqual(events, ["credential", "atomic-guard", "needs-auth"]);
});
