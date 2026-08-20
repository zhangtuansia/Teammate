import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Sidebar } from "@/components/sidebar";
import { MessageArea } from "@/components/message-area";
import { AgentSettingsPanel } from "@/components/agent-settings-panel";
import { AgentActivityProvider } from "@/hooks/use-agent-activity";
import { useAppSettings } from "@/hooks/use-app-settings";
import { useParams, usePathname, useRouter } from "next/navigation";

interface ServerInfo {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

interface AgentInfo {
  id: string;
  display_name: string;
  status: string;
  description: string | null;
  avatar_url: string | null;
}

interface ChannelInfo {
  id: string;
  name: string;
  type: string;
  description: string | null;
}

const LOCAL_SERVICE_URL = "http://127.0.0.1:8787";

async function waitForRuntime() {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`${LOCAL_SERVICE_URL}/health`);
      const result = response.ok
        ? (await response.json()) as { ok?: boolean; mode?: string }
        : null;
      if (result?.ok && result.mode === "local") return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Runtime unavailable");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError || new Error("Teammate runtime did not start");
}

function WorkspaceHome({ server }: { server: ServerInfo }) {
  const [counts, setCounts] = useState({ agents: 0, channels: 0, members: 0 });
  const { t } = useAppSettings();

  useEffect(() => {
    const client = createClient();
    Promise.all([
      client.from("agents").select("*", { count: "exact", head: true }).eq("server_id", server.id),
      client.from("channels").select("*", { count: "exact", head: true }).eq("server_id", server.id),
      client.from("server_members").select("*", { count: "exact", head: true }).eq("server_id", server.id),
    ]).then(([agents, channels, members]) => {
      setCounts({
        agents: agents.count || 0,
        channels: channels.count || 0,
        members: members.count || 0,
      });
    });
  }, [server.id]);

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center px-8 text-center">
      <div
        className="desktop-native-drag absolute inset-x-0 top-0 h-12"
        data-tauri-drag-region
      />
      <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-sanda-3 text-2xl font-semibold">
        {server.name.slice(0, 1).toUpperCase()}
      </div>
      <h1 className="text-xl font-semibold text-foreground">{server.name}</h1>
      {server.description && (
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          {server.slug === "local" ? t("workspace.description") : server.description}
        </p>
      )}
      <div className="mt-8 flex gap-10">
        {[
          [t("workspace.agents"), counts.agents],
          [t("workspace.channels"), counts.channels],
          [t("workspace.members"), counts.members],
        ].map(([label, value]) => (
          <div key={label}>
            <div className="text-2xl font-semibold">{value}</div>
            <div className="mt-1 text-xs text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      <p className="mt-9 text-sm text-muted-foreground">
        {t("workspace.prompt")}
      </p>
    </div>
  );
}

function Conversation({ server }: { server: ServerInfo }) {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();
  const channelId = params.channelId as string | undefined;
  const isDm = pathname.includes("/dm/");
  const [channel, setChannel] = useState<ChannelInfo | null>(null);
  const [settingsAgent, setSettingsAgent] = useState<AgentInfo | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { t } = useAppSettings();

  useEffect(() => {
    let cancelled = false;
    setChannel(null);
    if (!channelId) return;

    createClient()
      .from("channels")
      .select("id, name, type, description")
      .eq("id", channelId)
      .single()
      .then((result: { data: unknown }) => {
        if (!cancelled && result.data) setChannel(result.data as ChannelInfo);
      });

    return () => {
      cancelled = true;
    };
  }, [channelId, isDm]);

  const handleAgentDeleted = useCallback(() => {
    setSettingsAgent(null);
    router.replace(`/s/${server.slug}`);
  }, [router, server.slug]);

  if (!channelId) return <WorkspaceHome server={server} />;
  if (!channel) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t("conversation.loading")}
      </div>
    );
  }

  return (
    <>
      <MessageArea
        key={refreshKey}
        channel={channel}
        onToggleSettings={isDm ? setSettingsAgent : undefined}
        showSettings={Boolean(settingsAgent)}
      />
      {settingsAgent && (
        <AgentSettingsPanel
          agent={settingsAgent}
          onClose={() => setSettingsAgent(null)}
          onDeleted={handleAgentDeleted}
          onUpdated={(updated) => {
            setSettingsAgent(updated);
            setRefreshKey((value) => value + 1);
          }}
        />
      )}
    </>
  );
}

export function App() {
  const params = useParams();
  const router = useRouter();
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const { t } = useAppSettings();

  useEffect(() => {
    if (!params.slug) router.replace("/s/local");
  }, [params.slug, router]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError("");
      try {
        await waitForRuntime();
        const client = createClient();
        const { data, error: queryError } = await client
          .from("servers")
          .select("*")
          .eq("slug", (params.slug as string) || "local")
          .single();
        if (queryError || !data) throw new Error(queryError?.message || "Workspace not found");
        if (!cancelled) setServer(data as ServerInfo);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Desktop runtime failed to start");
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [params.slug, retryKey]);

  useEffect(() => {
    if (!error) return;
    const retryTimer = window.setTimeout(() => {
      setRetryKey((value) => value + 1);
    }, 2500);
    return () => window.clearTimeout(retryTimer);
  }, [error]);

  if (error) {
    return (
      <main
        className="flex h-full items-center justify-center bg-background p-8"
        data-tauri-drag-region="deep">
        <div className="max-w-md rounded-xl border bg-card p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold">{t("runtime.error")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <button
            className="mt-5 rounded-lg bg-foreground px-4 py-2 text-sm text-background"
            onClick={() => setRetryKey((value) => value + 1)}
          >
            {t("runtime.retry")}
          </button>
        </div>
      </main>
    );
  }

  if (!server) {
    return (
      <main
        className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground"
        data-tauri-drag-region="deep">
        {t("runtime.starting")}
      </main>
    );
  }

  return (
    <AgentActivityProvider>
      <div className="desktop-shell relative flex h-full overflow-hidden bg-background">
        <Sidebar serverSlug={server.slug} serverId={server.id} serverName={server.name} />
        <main className="flex flex-1 overflow-hidden border-l border-border/70 bg-card">
          <Conversation server={server} />
        </main>
      </div>
    </AgentActivityProvider>
  );
}
