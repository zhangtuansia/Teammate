import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(packageDir, "dist");
const outfile = resolve(distDir, "index.js");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await build({
  entryPoints: [resolve(packageDir, "src/index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  minify: false,
  legalComments: "eof",
});

const output = await readFile(outfile, "utf8");
if (!output.startsWith("#!/usr/bin/env node")) {
  throw new Error("CLI bundle is missing its executable shebang");
}

if (process.platform !== "win32") {
  await chmod(outfile, 0o755);
}
