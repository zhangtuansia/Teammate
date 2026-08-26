import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Deterministic curation for an agent's MEMORY.md — no model in the loop.
 *
 * Facts are the `- (YYYY-MM-DD) <fact>` lines agents are prompted to write.
 * Left alone the file only ever grows, duplicates accumulate across turns that
 * restate a settled matter, and the newest context loses to the oldest noise.
 * The curator normalizes, deduplicates, keeps the freshest facts first, and
 * moves whatever overflows the cap into an archive file rather than deleting
 * it. Everything here is mechanical so it can run between turns without
 * anyone's judgment.
 */

export const MEMORY_FILE = "MEMORY.md";
export const MEMORY_ARCHIVE_FILE = "MEMORY.archive.md";
const FACT_LINE = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.+?)\s*$/;
const MAX_FACTS = 120;

function normalizeFact(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function factId(normalized: string): string {
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

interface Fact {
  id: string;
  date: string;
  text: string;
}

function parseFacts(content: string): { facts: Fact[]; preamble: string[]; untouchedTail: string[] } {
  const lines = content.split("\n");
  const facts: Fact[] = [];
  const preamble: string[] = [];
  const untouchedTail: string[] = [];
  let readingFacts = false;
  let readingTail = false;
  for (const line of lines) {
    if (readingTail) {
      untouchedTail.push(line);
      continue;
    }
    const match = FACT_LINE.exec(line);
    if (!readingFacts && !match) {
      preamble.push(line);
      continue;
    }
    if (!match) {
      // First non-fact line after facts began ends the fact block; everything
      // after is prose the agent wrote by hand and is passed through intact.
      readingTail = true;
      untouchedTail.push(line);
      continue;
    }
    readingFacts = true;
    facts.push({
      id: factId(normalizeFact(match[2] ?? "")),
      date: match[1] ?? "",
      text: match[2] ?? "",
    });
  }
  return { facts, preamble, untouchedTail };
}

function serializeFacts(facts: Fact[]): string[] {
  return facts.map((fact) => `- (${fact.date}) ${fact.text}`);
}

export interface CurationOutcome {
  changed: boolean;
  keptCount: number;
  duplicateCount: number;
  archivedCount: number;
}

/** Curate one memory file in place; overflow lands in the archive beside it. */
export function curateMemoryFile(workDir: string): CurationOutcome {
  const memoryPath = join(workDir, MEMORY_FILE);
  if (!existsSync(memoryPath)) {
    return { changed: false, keptCount: 0, duplicateCount: 0, archivedCount: 0 };
  }
  let content: string;
  try {
    content = readFileSync(memoryPath, "utf-8");
  } catch {
    return { changed: false, keptCount: 0, duplicateCount: 0, archivedCount: 0 };
  }

  const parsed = parseFacts(content);
  const seen = new Set<string>();
  const unique: Fact[] = [];
  let duplicateCount = 0;
  // Newest first: what the file already ordered last wins a duplicate, since
  // agents append as they learn.
  for (let index = parsed.facts.length - 1; index >= 0; index -= 1) {
    const fact = parsed.facts[index] as Fact;
    if (seen.has(fact.id)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(fact.id);
    unique.unshift(fact);
  }

  const kept = unique.slice(-MAX_FACTS);
  const overflow = unique.slice(0, Math.max(0, unique.length - MAX_FACTS));

  const nextLines = [
    ...parsed.preamble,
    ...serializeFacts(kept),
    ...parsed.untouchedTail,
  ];
  const joined = nextLines.join("\n");
  const nextContent = joined.endsWith("\n") ? joined : `${joined}\n`;
  const changed =
    nextContent !== content || overflow.length > 0 || duplicateCount > 0;
  if (!changed) {
    return { changed: false, keptCount: kept.length, duplicateCount: 0, archivedCount: 0 };
  }

  const temporary = `${memoryPath}.${process.pid}.tmp`;
  writeFileSync(temporary, nextContent, { mode: 0o600 });
  renameSync(temporary, memoryPath);

  if (overflow.length > 0) {
    const archivePath = join(workDir, MEMORY_ARCHIVE_FILE);
    const existing = existsSync(archivePath)
      ? (() => {
          try {
            return readFileSync(archivePath, "utf-8");
          } catch {
            return "";
          }
        })()
      : "";
    writeFileSync(
      archivePath,
      `${existing}${serializeFacts(overflow).join("\n")}\n`,
      { mode: 0o600 },
    );
  }

  return {
    changed: true,
    keptCount: kept.length,
    duplicateCount,
    archivedCount: overflow.length,
  };
}
