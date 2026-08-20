#!/usr/bin/env node

import { hostname, platform, arch } from "os";
import { Bridge } from "./bridge.js";

// Default server URL (can be overridden)
const DEFAULT_SERVER_URL = "https://zano.fehey.com";

interface ConnectResponse {
  supabaseUrl: string;
  supabaseAnonKey: string;
  token: string;
  userId: string;
  serverId: string;
  serverName: string;
  localMode?: boolean;
  localServerUrl?: string;
  agents: Array<{
    id: string;
    name: string;
    display_name: string;
    description: string | null;
    runtime?: string;
    model: string;
    status: string;
  }>;
}

function parseArgs(): { serverUrl: string; apiKey: string; agentsDir: string } {
  const args = process.argv.slice(2);
  let serverUrl = DEFAULT_SERVER_URL;
  let apiKey = "";
  let agentsDir = "";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--server-url":
        serverUrl = args[++i] || "";
        break;
      case "--api-key":
        apiKey = args[++i] || "";
        break;
      case "--agents-dir":
        agentsDir = args[++i] || "";
        break;
      case "--help":
      case "-h":
        console.log(`
  Usage: zano-bridge [options]

  Options:
    --api-key <key>        Machine API key (required, generate at ${DEFAULT_SERVER_URL})
    --server-url <url>     Server URL (default: ${DEFAULT_SERVER_URL})
    --agents-dir <path>    Agent workspaces directory (default: ~/.zano/agents)
    -h, --help             Show this help message
`);
        process.exit(0);
    }
  }

  // Also support env vars as fallback (for local dev)
  if (!apiKey) apiKey = process.env.ZANO_API_KEY || "";
  if (!serverUrl || serverUrl === DEFAULT_SERVER_URL) {
    serverUrl = process.env.ZANO_SERVER_URL || serverUrl;
  }

  if (!agentsDir) {
    agentsDir = (process.env.ZANO_AGENTS_DIR || "~/.zano/agents").replace(
      "~",
      process.env.HOME || ""
    );
  }

  if (!apiKey) {
    console.error("  Error: --api-key is required.");
    console.error("");
    console.error("  Generate one at your workspace settings page,");
    console.error("  then run:");
    console.error("");
    console.error("    npx @fehey/zano-bridge --api-key zk_your_key_here");
    console.error("");
    process.exit(1);
  }

  return { serverUrl: serverUrl.replace(/\/+$/, ""), apiKey, agentsDir };
}

async function authenticate(
  serverUrl: string,
  apiKey: string
): Promise<ConnectResponse> {
  const res = await fetch(`${serverUrl}/api/bridge/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey,
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

async function main() {
  const { serverUrl, apiKey, agentsDir } = parseArgs();

  console.log(`
  ╔══════════════════════════════════════╗
  ║         Zano Local Bridge            ║
  ╚══════════════════════════════════════╝
`);
  console.log(`  Server: ${serverUrl}`);
  console.log(`  Connecting...`);

  let creds: ConnectResponse;
  try {
    creds = await authenticate(serverUrl, apiKey);
  } catch (err) {
    console.error(
      `  Authentication failed: ${err instanceof Error ? err.message : err}`
    );
    process.exit(1);
  }

  console.log(`  Authenticated as user ${creds.userId.substring(0, 8)}...`);
  console.log(`  Workspace: ${creds.serverName}`);
  console.log(`  Agents: ${creds.agents.map((a) => a.display_name).join(", ") || "none"}`);
  console.log(`  Agents dir: ${agentsDir}`);
  console.log("");

  const bridge = new Bridge({
    supabaseUrl: creds.supabaseUrl,
    supabaseKey: creds.supabaseAnonKey,
    authToken: creds.token,
    userId: creds.userId,
    serverId: creds.serverId,
    agentsDir,
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    localMode: creds.localMode,
    localServerUrl: creds.localServerUrl,
  });

  bridge.start();

  // Refresh auth token periodically (every 6 hours)
  const refreshInterval = setInterval(async () => {
    try {
      const fresh = await authenticate(serverUrl, apiKey);
      bridge.updateAuthToken(fresh.token);
      console.log("  Auth token refreshed.");
    } catch (err) {
      console.error(
        `  Token refresh failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }, 6 * 60 * 60 * 1000);

  process.on("SIGINT", () => {
    console.log("\n  Shutting down bridge...");
    clearInterval(refreshInterval);
    bridge.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    clearInterval(refreshInterval);
    bridge.stop();
    process.exit(0);
  });
}

main();
