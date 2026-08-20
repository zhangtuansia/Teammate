import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "../..");
const buildDir = join(desktopDir, ".sidecar-build");
const binariesDir = join(desktopDir, "src-tauri", "binaries");

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
mkdirSync(binariesDir, { recursive: true });

const triple = execFileSync("rustc", ["--print", "host-tuple"], {
  encoding: "utf8",
}).trim();

const pkgPlatform =
  process.platform === "darwin"
    ? "macos"
    : process.platform === "win32"
      ? "win"
      : "linux";
const pkgArch = process.arch === "arm64" ? "arm64" : "x64";
const pkgTarget = `node22-${pkgPlatform}-${pkgArch}`;
const executableExtension = process.platform === "win32" ? ".exe" : "";

const entries = [
  {
    name: "teammate-runtime",
    entry: join(desktopDir, "sidecar", "runtime.ts"),
  },
  {
    name: "teammate-cli",
    entry: join(repoRoot, "packages", "cli", "src", "index.ts"),
  },
];

for (const entry of entries) {
  const bundled = join(buildDir, `${entry.name}.cjs`);
  const output = join(
    binariesDir,
    `${entry.name}-${triple}${executableExtension}`,
  );

  await build({
    entryPoints: [entry.entry],
    outfile: bundled,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    minify: false,
    external: ["node:sqlite"],
  });

  execFileSync(
    "pnpm",
    [
      "exec",
      "pkg",
      bundled,
      "--targets",
      pkgTarget,
      "--output",
      output,
      "--compress",
      "GZip",
    ],
    { cwd: desktopDir, stdio: "inherit" },
  );
}
