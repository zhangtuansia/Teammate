import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const bunExecutable = process.env.BUN_PATH || execFileSync(
  process.platform === "win32" ? "where" : "which",
  ["bun"],
  { encoding: "utf8" },
).split(/\r?\n/, 1)[0];
const piWorkerBundle = join(buildDir, "teammate-pi-worker.mjs");
execFileSync(
  bunExecutable,
  [
    "build",
    join(repoRoot, "apps", "bridge", "src", "runtimes", "pi-worker.ts"),
    "--target=bun",
    "--format=esm",
    "--outfile",
    piWorkerBundle,
  ],
  { cwd: repoRoot, stdio: "inherit" },
);
const piWorkerSource = readFileSync(piWorkerBundle, "utf8");
const piWorkerPlugin = {
  name: "teammate-pi-worker",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^virtual:pi-worker$/ }, () => ({
      path: "teammate-pi-worker",
      namespace: "teammate-pi-worker",
    }));
    buildContext.onLoad(
      { filter: /.*/, namespace: "teammate-pi-worker" },
      () => ({
        contents: `export default ${JSON.stringify(piWorkerSource)};`,
        loader: "js",
      }),
    );
  },
};

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
    plugins: [piWorkerPlugin],
  });

  execFileSync(
    pnpmExecutable,
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
    {
      cwd: desktopDir,
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
}

const piOutput = join(
  binariesDir,
  `teammate-pi-${triple}${executableExtension}`,
);
copyFileSync(bunExecutable, piOutput);
chmodSync(piOutput, 0o755);
