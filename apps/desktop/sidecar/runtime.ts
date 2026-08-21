import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import piWorkerSource from "virtual:pi-worker";

const SHUTDOWN_COMMAND = "teammate:shutdown";

function readArgument(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function installParentShutdownControl() {
  let buffer = "";
  let shutdownRequested = false;
  const requestShutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    process.kill(process.pid, "SIGTERM");
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    if (lines.some((line) => line.trim() === SHUTDOWN_COMMAND)) requestShutdown();
  });
  process.stdin.once("end", requestShutdown);
  process.stdin.once("close", requestShutdown);
  process.stdin.resume();
}

class ReadinessMismatchError extends Error {}

async function waitForLocalService(localUrl: string, controllerCredential: string) {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${localUrl}/api/ready`, {
        headers: { Authorization: `Bearer ${controllerCredential}` },
        signal: AbortSignal.timeout(750),
      });
      if (!response.ok) {
        throw new ReadinessMismatchError(
          `Local readiness was rejected with HTTP ${response.status}`,
        );
      }
      const ready = await response.json() as {
        ok?: boolean;
        mode?: string;
        protocolVersion?: number;
      };
      if (ready.ok && ready.mode === "local" && ready.protocolVersion === 2) return;
      throw new ReadinessMismatchError("Another incompatible service is using the local port");
    } catch (error) {
      if (error instanceof ReadinessMismatchError) throw error;
      lastError = error instanceof Error ? error : new Error("Local service is unavailable");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(
    `The local service did not become ready: ${lastError?.message || "timed out"}`,
  );
}

async function main() {
  const controllerCredential = process.env.TEAMMATE_LOCAL_CONTROLLER_TOKEN || "";
  if (controllerCredential.length < 32) {
    throw new Error("The desktop controller credential is missing");
  }
  installParentShutdownControl();
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

  process.env.TEAMMATE_LOCAL_PORT = port;
  process.env.TEAMMATE_LOCAL_DB = join(dataDir, "local.db");
  process.env.TEAMMATE_EMBEDDED_SIDECAR = "1";
  process.env.TEAMMATE_LOCAL_SERVER_URL = localUrl;
  process.env.TEAMMATE_API_KEY = controllerCredential;
  process.env.TEAMMATE_SERVER_URL = localUrl;
  process.env.TEAMMATE_AGENTS_DIR = join(dataDir, "agents");
  const piRuntimeDir = join(dataDir, "pi-runtime");
  mkdirSync(piRuntimeDir, { recursive: true });
  const piWorkerPath = join(piRuntimeDir, "worker.mjs");
  writeFileSync(
    piWorkerPath,
    piWorkerSource,
    { mode: 0o600 },
  );
  process.env.TEAMMATE_PI_WORKER = piWorkerPath;
  if (existsSync(siblingCli)) process.env.TEAMMATE_CLI_PATH = siblingCli;
  if (existsSync(siblingPi)) process.env.TEAMMATE_PI_PATH = siblingPi;

  await import("../../local-server/src/index.ts");
  delete process.env.TEAMMATE_LOCAL_CONTROLLER_TOKEN;
  await waitForLocalService(localUrl, controllerCredential);

  process.argv = [
    process.execPath,
    "teammate-runtime",
    "--server-url",
    localUrl,
    "--api-key",
    controllerCredential,
    "--agents-dir",
    process.env.TEAMMATE_AGENTS_DIR,
  ];

  await import("../../bridge/src/index.ts");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
