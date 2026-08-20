import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

for (const command of [["sidecars:build"], ["build"]]) {
  const result = spawnSync(pnpmExecutable, command, {
    cwd: desktopDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
