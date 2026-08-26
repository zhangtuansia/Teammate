import { homedir } from "node:os";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentRuntimeId } from "./runtimes/types.js";

export interface DiscoveredSkill {
  slug: string;
  source: AgentRuntimeId;
  displayName: string | null;
  description: string;
  version: string | null;
  path: string;
}

const RUNTIME_SKILL_DIRECTORIES: Record<AgentRuntimeId, string[]> = {
  "claude-code": [".claude", "skills"],
  codex: [".codex", "skills"],
  pi: [".pi", "agent", "skills"],
};

function readFrontmatterField(frontmatter: string, field: string) {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, "") || null;
}

async function discoverSkillsForRuntime(
  runtime: AgentRuntimeId,
): Promise<DiscoveredSkill[]> {
  const skillsDir = join(homedir(), ...RUNTIME_SKILL_DIRECTORIES[runtime]);
  const discovered: DiscoveredSkill[] = [];
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const entryPath = join(skillsDir, entry);
    try {
      const entryStat = await lstat(entryPath);
      const resolvedPath = entryStat.isSymbolicLink()
        ? resolve(skillsDir, entry)
        : entryPath;

      for (const filename of ["SKILL.md", "skill.md"]) {
        let content: string;
        try {
          content = await readFile(join(resolvedPath, filename), "utf-8");
        } catch {
          continue;
        }
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        const frontmatter = fmMatch?.[1] ?? "";
        discovered.push({
          slug: entry,
          source: runtime,
          displayName: readFrontmatterField(frontmatter, "name"),
          description:
            readFrontmatterField(frontmatter, "description") || entry,
          version: readFrontmatterField(frontmatter, "version"),
          path: join(resolvedPath, filename),
        });
        break;
      }
    } catch {
      continue;
    }
  }
  return discovered;
}

export async function discoverAllSkills(): Promise<DiscoveredSkill[]> {
  const runtimes: AgentRuntimeId[] = ["claude-code", "codex", "pi"];
  const results = await Promise.all(runtimes.map(discoverSkillsForRuntime));
  return results.flat();
}

export async function discoverSkillsForRuntimePublic(runtime: AgentRuntimeId) {
  return discoverSkillsForRuntime(runtime);
}
