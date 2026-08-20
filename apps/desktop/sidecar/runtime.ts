import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import piWorkerSource from "virtual:pi-worker";

function readArgument(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const dataDir = resolve(readArgument("--data-dir", join(process.cwd(), ".teammate")));
  const port = readArgument("--port", "8787");
  const localUrl = `http://127.0.0.1:${port}`;
  const executableName = basename(process.execPath);
  const extension = extname(executableName);
  const stem = extension ? executableName.slice(0, -extension.length) : executableName;
  const suffix = stem.startsWith("teammate-runtime")
    ? stem.slice("teammate-runtime".length)
    : "";
  const siblingCli = join(dirname(process.execPath), `teammate-cli${suffix}${extension}`);
  const siblingPi = join(dirname(process.execPath), `teammate-pi${suffix}${extension}`);

  process.env.ZANO_LOCAL_PORT = port;
  process.env.ZANO_LOCAL_DB = join(dataDir, "local.db");
  process.env.ZANO_LOCAL_SERVER_URL = localUrl;
  process.env.ZANO_API_KEY = "zk_local";
  process.env.ZANO_SERVER_URL = localUrl;
  process.env.ZANO_AGENTS_DIR = join(dataDir, "agents");
  const piRuntimeDir = join(dataDir, "pi-runtime");
  mkdirSync(piRuntimeDir, { recursive: true });
  const piWorkerPath = join(piRuntimeDir, "worker.mjs");
  writeFileSync(
    piWorkerPath,
    piWorkerSource,
    { mode: 0o600 },
  );
  process.env.ZANO_PI_WORKER = piWorkerPath;
  if (existsSync(siblingCli)) process.env.ZANO_CLI_PATH = siblingCli;
  if (existsSync(siblingPi)) process.env.ZANO_PI_PATH = siblingPi;

  await import("../../local-server/src/index.ts");

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${localUrl}/health`);
      if (response.ok) break;
    } catch {
      // The local service is still binding its port.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }

  process.argv = [
    process.execPath,
    "teammate-bridge",
    "--server-url",
    localUrl,
    "--api-key",
    "zk_local",
    "--agents-dir",
    process.env.ZANO_AGENTS_DIR,
  ];

  await import("../../bridge/src/index.ts");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
