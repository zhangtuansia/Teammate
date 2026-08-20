import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const command of [["sidecars:build"], ["build"]]) {
  const result = spawnSync("pnpm", command, {
    cwd: desktopDir,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
