import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COMMAND_CANDIDATES: Record<string, string[]> = {
  claude: [
    join(homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ],
  codex: [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    join(homedir(), ".local", "bin", "codex"),
  ],
};

export function resolveRuntimeCommand(command: "claude" | "codex"): string {
  const override =
    command === "claude"
      ? process.env.TEAMMATE_CLAUDE_PATH
      : process.env.TEAMMATE_CODEX_PATH;
  if (override) return override;

  for (const candidate of COMMAND_CANDIDATES[command]) {
    if (existsSync(candidate)) return candidate;
  }

  return command;
}
