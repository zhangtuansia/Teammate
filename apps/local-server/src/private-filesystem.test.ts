import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  enforcePrivateFileCreationMask,
  ensurePrivateDirectory,
  restrictSqliteFiles,
} from "./private-filesystem.js";

test("local data and existing SQLite sidecars are private on POSIX", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teammate-private-local-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  ensurePrivateDirectory(dataDir);
  await chmod(dataDir, 0o755);

  const databasePath = join(dataDir, "local.db");
  const sqliteFiles = [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
  ];
  for (const path of sqliteFiles) {
    await writeFile(path, "legacy", { mode: 0o644 });
    await chmod(path, 0o644);
  }

  ensurePrivateDirectory(dataDir);
  restrictSqliteFiles(databasePath);

  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  for (const path of sqliteFiles) {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test("the private umask is POSIX-only", {
  skip: process.platform === "win32",
}, () => {
  const previous = process.umask();
  try {
    process.umask(0o022);
    enforcePrivateFileCreationMask();
    assert.equal(process.umask(), 0o077);
    enforcePrivateFileCreationMask("win32");
    assert.equal(process.umask(), 0o077);
  } finally {
    process.umask(previous);
  }
});

test("Windows compatibility skips POSIX permission mutation", () => {
  assert.doesNotThrow(() => restrictSqliteFiles("Z:\\missing\\local.db", "win32"));
  assert.doesNotThrow(() => enforcePrivateFileCreationMask("win32"));
});
