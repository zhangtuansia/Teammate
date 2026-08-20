import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prepared = spawnSync("pnpm", ["sidecars:build"], {
  cwd: desktopDir,
  stdio: "inherit",
});
if (prepared.status !== 0) process.exit(prepared.status || 1);

const vite = spawn("pnpm", ["dev"], {
  cwd: desktopDir,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => vite.kill(signal));
}

vite.on("exit", (code) => process.exit(code || 0));
