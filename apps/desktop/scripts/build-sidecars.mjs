import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "../..");
const binariesDir = join(desktopDir, "src-tauri", "binaries");
const require = createRequire(import.meta.url);
const pkgCli = require.resolve("@yao-pkg/pkg/lib-es5/bin.js");

function hostTriple() {
  try {
    return execFileSync("rustc", ["--print", "host-tuple"], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }

    const triples = {
      darwin: {
        arm64: "aarch64-apple-darwin",
        x64: "x86_64-apple-darwin",
      },
      linux: {
        arm64: "aarch64-unknown-linux-gnu",
        x64: "x86_64-unknown-linux-gnu",
      },
      win32: {
        arm64: "aarch64-pc-windows-msvc",
        x64: "x86_64-pc-windows-msvc",
      },
    };
    const inferred = triples[process.platform]?.[process.arch];
    if (!inferred) {
      throw new Error(
        `Cannot infer Tauri target triple for ${process.platform}/${process.arch}. Install Rust or set TAURI_ENV_TARGET_TRIPLE.`,
      );
    }
    console.warn(`rustc was not found; inferred Tauri target ${inferred}.`);
    return inferred;
  }
}

const nativeTriple = hostTriple();
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || nativeTriple;
if (triple !== nativeTriple) {
  throw new Error(
    `Sidecar cross-compilation is not supported: target ${triple}, host ${nativeTriple}. Build on a native runner for the target architecture so Node and Bun binaries cannot be mislabeled.`,
  );
}

const target = {
  "aarch64-apple-darwin": {
    pkgPlatform: "macos",
    pkgArch: "arm64",
    runtimePlatform: "darwin",
    executableExtension: "",
  },
  "x86_64-apple-darwin": {
    pkgPlatform: "macos",
    pkgArch: "x64",
    runtimePlatform: "darwin",
    executableExtension: "",
  },
  "aarch64-pc-windows-msvc": {
    pkgPlatform: "win",
    pkgArch: "arm64",
    runtimePlatform: "win32",
    executableExtension: ".exe",
  },
  "x86_64-pc-windows-msvc": {
    pkgPlatform: "win",
    pkgArch: "x64",
    runtimePlatform: "win32",
    executableExtension: ".exe",
  },
  "aarch64-unknown-linux-gnu": {
    pkgPlatform: "linux",
    pkgArch: "arm64",
    runtimePlatform: "linux",
    executableExtension: "",
  },
  "x86_64-unknown-linux-gnu": {
    pkgPlatform: "linux",
    pkgArch: "x64",
    runtimePlatform: "linux",
    executableExtension: "",
  },
}[triple];
if (!target) {
  throw new Error(
    `Unsupported native sidecar target ${triple}. Use a supported macOS, Windows MSVC, or Linux GNU runner.`,
  );
}

const { pkgPlatform, pkgArch, runtimePlatform, executableExtension } = target;
const pkgTarget = `node22-${pkgPlatform}-${pkgArch}`;
const bunCommand = process.env.BUN_PATH || execFileSync(
  process.platform === "win32" ? "where" : "which",
  ["bun"],
  { encoding: "utf8" },
).split(/\r?\n/, 1)[0];
let bunRuntime;
try {
  bunRuntime = JSON.parse(
    execFileSync(
      bunCommand,
      [
        "-e",
        "process.stdout.write(JSON.stringify({ platform: process.platform, arch: process.arch, execPath: process.execPath }))",
      ],
      { encoding: "utf8" },
    ),
  );
} catch (error) {
  throw new Error(
    `Unable to resolve the Bun runtime from ${bunCommand}. BUN_PATH must point to an executable Bun binary.`,
    { cause: error },
  );
}
if (
  !bunRuntime ||
  typeof bunRuntime !== "object" ||
  typeof bunRuntime.platform !== "string" ||
  typeof bunRuntime.arch !== "string" ||
  typeof bunRuntime.execPath !== "string"
) {
  throw new Error(`Bun at ${bunCommand} returned invalid runtime metadata.`);
}
const bunExecutable = realpathSync(bunRuntime.execPath);
if (!statSync(bunExecutable).isFile()) {
  throw new Error(`Resolved Bun runtime is not a regular file: ${bunExecutable}`);
}
const expectedBunVersion = readFileSync(join(repoRoot, ".bun-version"), "utf8").trim();
const actualBunVersion = execFileSync(bunExecutable, ["--version"], {
  encoding: "utf8",
}).trim();
if (actualBunVersion !== expectedBunVersion) {
  throw new Error(
    `Bun ${expectedBunVersion} is required for reproducible sidecars, but ${actualBunVersion} was found at ${bunExecutable}.`,
  );
}
const bunPlatform = bunRuntime.platform;
const bunArch = bunRuntime.arch;
if (bunPlatform !== runtimePlatform || bunArch !== pkgArch) {
  throw new Error(
    `Bun at ${bunExecutable} is ${bunPlatform}/${bunArch}, but target ${triple} requires ${runtimePlatform}/${pkgArch}.`,
  );
}

// Use a unique scratch directory so concurrent native builds cannot delete each
// other's bundles. The published target-named binaries remain deterministic.
const buildDir = mkdtempSync(join(tmpdir(), "teammate-sidecars-"));
process.once("exit", () => rmSync(buildDir, { recursive: true, force: true }));
mkdirSync(binariesDir, { recursive: true });
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

/**
 * Some dependencies lazily `import("node:…")` so they can also load in a
 * browser. The packaged binary has no dynamic-import callback, so those calls
 * fail at runtime with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING. Rewrite them to
 * a static require, which is what the bundle needs and what the module would
 * have used had it not been written for both environments.
 */
const staticNodeImportPlugin = {
  name: "teammate-static-node-imports",
  setup(buildContext) {
    buildContext.onLoad({ filter: /@mariozechner[\\/]pi-ai[\\/].*\.js$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      if (!/import\("node:/.test(source)) return null;
      return {
        contents: source.replace(
          /import\("(node:[a-z/]+)"\)/g,
          (_match, specifier) => `Promise.resolve(require("${specifier}"))`,
        ),
        loader: "js",
      };
    });
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
    define: {
      "import.meta.url": "__teammateImportMetaUrl",
    },
    banner: {
      js: "const __teammateImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
    },
    external: ["node:sqlite"],
    plugins: [piWorkerPlugin, staticNodeImportPlugin],
  });

  execFileSync(
    process.execPath,
    [
      pkgCli,
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
    },
  );
}

const piOutput = join(
  binariesDir,
  `teammate-pi-${triple}${executableExtension}`,
);
copyFileSync(bunExecutable, piOutput);
chmodSync(piOutput, 0o755);
