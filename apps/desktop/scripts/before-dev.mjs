import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const prepared = spawnSync(pnpmExecutable, ["sidecars:build"], {
  cwd: desktopDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (prepared.status !== 0) process.exit(prepared.status || 1);

const vite = spawn(pnpmExecutable, ["dev"], {
  cwd: desktopDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => vite.kill(signal));
}

vite.on("exit", (code) => process.exit(code || 0));
