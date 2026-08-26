import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { curateMemoryFile, MEMORY_FILE } from "../src/memory-curator.js";

test("memory curation deduplicates facts without discarding prose after them", () => {
  const workDir = mkdtempSync(join(tmpdir(), "teammate-memory-curator-"));
  try {
    const memoryPath = join(workDir, MEMORY_FILE);
    writeFileSync(
      memoryPath,
      [
        "# Agent memory",
        "",
        "- (2026-08-24) Prefer concise status updates",
        "- (2026-08-25) prefer   concise status updates",
        "- (2026-08-26) Keep document links clickable",
        "",
        "## Active context",
        "The release checklist is still in progress.",
        "",
      ].join("\n"),
    );

    const outcome = curateMemoryFile(workDir);
    const curated = readFileSync(memoryPath, "utf8");

    assert.equal(outcome.duplicateCount, 1);
    assert.doesNotMatch(curated, /2026-08-24/);
    assert.match(curated, /2026-08-25/);
    assert.match(curated, /## Active context\nThe release checklist is still in progress\./);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
