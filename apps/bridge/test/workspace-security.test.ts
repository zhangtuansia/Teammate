import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Bridge } from "../src/bridge.js";

function bareBridge() {
  return Object.create(Bridge.prototype) as Bridge;
}

test("workspace browsing contains reads and exposes only safe entries", async (t) => {
  const tempPath = await mkdtemp(join(tmpdir(), "teammate-workspace-security-"));
  t.after(() => rm(tempPath, { force: true, recursive: true }));

  const workspacePath = join(tempPath, "workspace");
  const samePrefixPath = join(tempPath, "workspace-copy");
  const notesPath = join(workspacePath, "notes");
  const hiddenPath = join(workspacePath, ".private");
  await Promise.all([
    mkdir(notesPath, { recursive: true }),
    mkdir(hiddenPath, { recursive: true }),
    mkdir(samePrefixPath, { recursive: true }),
  ]);

  const outsidePath = join(tempPath, "outside.txt");
  await Promise.all([
    writeFile(join(workspacePath, "README.md"), "safe workspace text\n"),
    writeFile(join(notesPath, "today.md"), "a safe note\n"),
    writeFile(join(hiddenPath, "secret.md"), "hidden\n"),
    writeFile(join(samePrefixPath, "secret.md"), "same-prefix sibling\n"),
    writeFile(outsidePath, "outside\n"),
    writeFile(join(workspacePath, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 65)),
    writeFile(join(workspacePath, "binary.dat"), Buffer.from([0, 1, 2, 3, 4, 5])),
  ]);
  await symlink(outsidePath, join(workspacePath, "outside-link.txt"), "file");

  const bridge = bareBridge();
  const readWorkspaceFile = Reflect.get(bridge, "readWorkspaceFile") as (
    workDir: string,
    filePath: string,
  ) => Promise<{ file: string; content: string }>;
  const listWorkspaceFiles = Reflect.get(bridge, "listWorkspaceFiles") as (
    workDir: string,
  ) => Promise<{
    files: Array<{ name: string }>;
    notes_files: Array<{ name: string }>;
  }>;

  assert.deepEqual(await readWorkspaceFile.call(bridge, workspacePath, "README.md"), {
    file: "README.md",
    content: "safe workspace text\n",
  });
  assert.deepEqual(await readWorkspaceFile.call(bridge, workspacePath, "notes/today.md"), {
    file: "notes/today.md",
    content: "a safe note\n",
  });

  await assert.rejects(
    readWorkspaceFile.call(bridge, workspacePath, "../outside.txt"),
    /Invalid file path/,
  );
  await assert.rejects(
    readWorkspaceFile.call(bridge, workspacePath, "../workspace-copy/secret.md"),
    /Invalid file path/,
  );
  await assert.rejects(
    readWorkspaceFile.call(bridge, workspacePath, "outside-link.txt"),
    /Symbolic links are not allowed/,
  );
  await assert.rejects(
    readWorkspaceFile.call(bridge, workspacePath, ".private/secret.md"),
    /Invalid file path/,
  );
  await assert.rejects(
    readWorkspaceFile.call(bridge, workspacePath, "notes"),
    /Only regular files can be read/,
  );
  await assert.rejects(
    readWorkspaceFile.call(bridge, workspacePath, "large.txt"),
    /File is too large/,
  );
  await assert.rejects(
    readWorkspaceFile.call(bridge, workspacePath, "binary.dat"),
    /Binary files are not supported/,
  );

  const listing = await listWorkspaceFiles.call(bridge, workspacePath);
  assert.ok(listing.files.some((entry) => entry.name === "README.md"));
  assert.ok(listing.files.some((entry) => entry.name === "notes"));
  assert.ok(!listing.files.some((entry) => entry.name === ".private"));
  assert.ok(!listing.files.some((entry) => entry.name === "outside-link.txt"));
  assert.ok(listing.notes_files.some((entry) => entry.name === "notes/today.md"));
});

test("hosted workspace browsing never reads agent-controlled paths on the web server", async () => {
  const route = await readFile(
    new URL(
      "../../web/src/app/api/agents/[id]/workspace/route.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(route, /error: "remote_workspace"/);
  assert.match(route, /status: 422/);
  assert.doesNotMatch(route, /from "(?:node:)?fs/);
  assert.doesNotMatch(route, /readFile\(/);
  assert.doesNotMatch(route, /realpath\(/);
});
