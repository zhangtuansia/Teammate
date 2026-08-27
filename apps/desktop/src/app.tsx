import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Sidebar } from "@/components/sidebar";
import { WorkspaceRail } from "@/components/workspace-rail";
import { WorkspaceTopBar } from "@/components/workspace-top-bar";
import { MessageArea } from "@/components/message-area";
import { AgentSettingsPanel } from "@/components/agent-settings-panel";
import { AgentActivityProvider } from "@/hooks/use-agent-activity";
import { useAppSettings } from "@/hooks/use-app-settings";
import { WorkspaceServerProvider } from "@/components/workspace-server-context";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useParams, usePathname, useRouter } from "next/navigation";
import { WorkspaceSection } from "./workspace-section";
import { DesktopSettingsPage } from "./settings";
import { AppsSection } from "@/components/apps-section";

interface ServerInfo {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  owner_id: string;
}

interface AgentInfo {
  id: string;
  display_name: string;
  status: string;
  description: string | null;
  avatar_url: string | null;
  owner_id: string;
}

interface ChannelInfo {
  id: string;
  server_id: string;
  name: string;
  type: string;
  description: string | null;
}

interface ChannelLoadState {
  serverId: string;
  channelId: string;
  request: number;
  channel: ChannelInfo | null;
  error: string;
}

interface AgentPanelSelection {
  channelId: string;
  agent: AgentInfo;
}

interface WorkspaceCounts {
  agents: number;
  channels: number;
  members: number;
}

interface WorkspaceCountsSnapshot {
  serverId: string;
  counts: WorkspaceCounts;
}

const LOCAL_SERVICE_URL =
  process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_SERVER_URL || "http://127.0.0.1:8787";
const CHANNEL_LOAD_TIMEOUT_MS = 8_000;

function abortError() {
  return new DOMException("The workspace request was cancelled", "AbortError");
}

class RuntimeConflictError extends Error {}

function waitForDelay(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, duration);
    const handleAbort = () => {
      window.clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

async function waitForRuntime(signal: AbortSignal) {
  let lastError: Error | null = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw abortError();

    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    signal.addEventListener("abort", abortRequest, { once: true });
    const requestTimeout = window.setTimeout(
      () => requestController.abort(),
      Math.min(1200, Math.max(1, deadline - Date.now())),
    );
    try {
      const response = await fetch(`${LOCAL_SERVICE_URL}/api/ready`, {
        signal: requestController.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new RuntimeConflictError("Another Teammate runtime owns the local service port");
      }
      const result = response.ok
        ? (await response.json()) as { ok?: boolean; mode?: string; protocolVersion?: number }
        : null;
      if (result?.ok && result.mode === "local" && result.protocolVersion === 2) return;
      if (response.ok) {
        throw new RuntimeConflictError("An incompatible service owns the local service port");
      }
      lastError = new Error(`Local runtime readiness returned HTTP ${response.status}`);
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof RuntimeConflictError) throw error;
      lastError = error instanceof Error ? error : new Error("Runtime unavailable");
    } finally {
      window.clearTimeout(requestTimeout);
      signal.removeEventListener("abort", abortRequest);
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await waitForDelay(Math.min(200, remaining), signal);
  }
  throw lastError || new Error("Teammate runtime did not start");
}

function WorkspaceHome({ server }: { server: ServerInfo }) {
  const [snapshot, setSnapshot] = useState<WorkspaceCountsSnapshot | null>(null);
  const [countsError, setCountsError] = useState<{ serverId: string; message: string } | null>(null);
  const loadGenerationRef = useRef(0);
  const { t } = useAppSettings();

  const loadCounts = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    const client = createClient();
    const [agents, channels, members] = await Promise.all([
      client.from("agents").select("*", { count: "exact", head: true }).eq("server_id", server.id),
      client.from("channels").select("*", { count: "exact", head: true }).eq("server_id", server.id),
      client.from("server_members").select("*", { count: "exact", head: true }).eq("server_id", server.id),
    ]);
    if (loadGenerationRef.current !== generation) return;

    const queryError = agents.error || channels.error || members.error;
    if (queryError) {
      setCountsError({ serverId: server.id, message: queryError.message });
      return;
    }

    setSnapshot({
      serverId: server.id,
      counts: {
        agents: agents.count || 0,
        channels: channels.count || 0,
        members: members.count || 0,
      },
    });
    setCountsError(null);
  }, [server.id]);

  useEffect(() => {
    const client = createClient();
    let refreshTimer: number | null = null;
    const refreshCounts = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void loadCounts();
      }, 80);
    };
    void loadCounts();
    const subscription = client
      .channel(`workspace-home:${server.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agents", filter: `server_id=eq.${server.id}` },
        refreshCounts,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "channels", filter: `server_id=eq.${server.id}` },
        refreshCounts,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "server_members", filter: `server_id=eq.${server.id}` },
        refreshCounts,
      )
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED") {
          void loadCounts();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setCountsError({ serverId: server.id, message: "Workspace totals could not connect" });
        }
      });

    return () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      loadGenerationRef.current += 1;
      client.removeChannel(subscription);
    };
  }, [loadCounts, server.id]);

  const counts = snapshot?.serverId === server.id ? snapshot.counts : null;
  const currentCountsError = countsError?.serverId === server.id ? countsError.message : "";

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
          [t("workspace.agents"), counts?.agents],
          [t("workspace.channels"), counts?.channels],
          [t("workspace.members"), counts?.members],
        ].map(([label, value]) => (
          <div key={label}>
            <div className="text-2xl font-semibold tabular-nums">{value ?? "—"}</div>
            <div className="mt-1 text-xs text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      {currentCountsError && (
        <button
          type="button"
          className="mt-4 text-xs text-destructive underline-offset-4 hover:underline"
          title={currentCountsError}
          onClick={() => void loadCounts()}
        >
          {t("workspace.countsFailed")} · {t("runtime.retry")}
        </button>
      )}
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
  const [channelRequest, setChannelRequest] = useState(0);
  const [channelState, setChannelState] = useState<ChannelLoadState | null>(null);
  const [settingsSelection, setSettingsSelection] = useState<AgentPanelSelection | null>(null);
  const channelGenerationRef = useRef(0);
  const { t } = useAppSettings();

  useEffect(() => {
    const generation = ++channelGenerationRef.current;
    const requestController = new AbortController();
    let cancelled = false;
    let timedOut = false;
    const isCurrent = () => !cancelled && channelGenerationRef.current === generation;
    if (!channelId) {
      return () => {
        cancelled = true;
        requestController.abort();
      };
    }

    const loadTimeout = window.setTimeout(() => {
      timedOut = true;
      requestController.abort();
      if (!isCurrent()) return;
      setChannelState({
        serverId: server.id,
        channelId,
        request: channelRequest,
        channel: null,
        error: t("conversation.loadTimedOut"),
      });
    }, CHANNEL_LOAD_TIMEOUT_MS);

    const channelQuery = createClient()
      .from("channels")
      .select("id, server_id, name, type, description")
      .eq("id", channelId)
      .eq("server_id", server.id)
      .maybeSingle();
    // WKWebView can leave a cross-origin fetch permanently pending when an
    // AbortSignal is attached, including after abort(). LocalClient requests
    // are already protected from stale writes by the generation check above,
    // so only remote Supabase queries need transport-level cancellation.
    const request = process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_MODE === "true"
      ? channelQuery
      : channelQuery.abortSignal(requestController.signal);

    request
      .then((result: { data: unknown; error?: { message: string } | null }) => {
        window.clearTimeout(loadTimeout);
        if (!isCurrent() || timedOut) return;
        if (result.error || !result.data) {
          setChannelState({
            serverId: server.id,
            channelId,
            request: channelRequest,
            channel: null,
            error: timedOut
              ? t("conversation.loadTimedOut")
              : result.error?.message || t("conversation.notFound"),
          });
          return;
        }
        setChannelState({
          serverId: server.id,
          channelId,
          request: channelRequest,
          channel: result.data as ChannelInfo,
          error: "",
        });
      })
      .catch((error: unknown) => {
        window.clearTimeout(loadTimeout);
        if (!isCurrent() || timedOut) return;
        setChannelState({
          serverId: server.id,
          channelId,
          request: channelRequest,
          channel: null,
          error: timedOut
            ? t("conversation.loadTimedOut")
            : error instanceof Error
              ? error.message
              : t("conversation.loadFailed"),
        });
      });

    return () => {
      cancelled = true;
      window.clearTimeout(loadTimeout);
      requestController.abort();
    };
  }, [channelId, channelRequest, server.id, t]);

  useEffect(() => {
    if (!channelId) return;
    const client = createClient();
    const appliesToCurrentChannel = (
      state: ChannelLoadState | null,
    ): state is ChannelLoadState =>
      state !== null &&
      state.serverId === server.id &&
      state.channelId === channelId &&
      state.request === channelRequest;
    const subscription = client
      .channel(`desktop-conversation:${server.id}:${channelId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "channels", filter: `id=eq.${channelId}` },
        (payload: { new: ChannelInfo }) => {
          setChannelState((current) => {
            if (!appliesToCurrentChannel(current)) return current;
            if (payload.new.server_id !== server.id) {
              return { ...current, channel: null, error: t("conversation.notFound") };
            }
            return { ...current, channel: payload.new, error: "" };
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "channels", filter: `id=eq.${channelId}` },
        () => {
          setChannelState((current) => appliesToCurrentChannel(current)
            ? { ...current, channel: null, error: t("conversation.notFound") }
            : current);
        },
      )
      .subscribe();

    return () => {
      client.removeChannel(subscription);
    };
  }, [channelId, channelRequest, server.id, t]);

  const handleAgentDeleted = useCallback(() => {
    setSettingsSelection(null);
    window.requestAnimationFrame(() => {
      router.replace(`/s/${server.slug}`);
    });
  }, [router, server.slug]);

  if (!channelId) return <WorkspaceHome server={server} />;
  const currentChannelState = channelState?.serverId === server.id &&
    channelState.channelId === channelId &&
    channelState.request === channelRequest
    ? channelState
    : null;
  if (!currentChannelState) {
    return (
      <div
        aria-live="polite"
        className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner aria-hidden="true" className="size-3.5 motion-reduce:animate-none" />
        {t("conversation.loading")}
      </div>
    );
  }
  if (currentChannelState.error || !currentChannelState.channel) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p role="alert" className="text-sm text-destructive">
          {currentChannelState.error || t("conversation.notFound")}
        </p>
        <Button variant="outline" size="sm" onClick={() => setChannelRequest((value) => value + 1)}>
          {t("runtime.retry")}
        </Button>
      </div>
    );
  }

  const channel = currentChannelState.channel;
  const settingsAgent = settingsSelection?.channelId === channelId
    ? settingsSelection.agent
    : null;

  return (
    <>
      <MessageArea
        channel={channel}
        onToggleSettings={isDm
          ? (agent) => setSettingsSelection(agent ? { channelId, agent } : null)
          : undefined}
        showSettings={Boolean(settingsAgent)}
      />
      {settingsAgent && (
        <AgentSettingsPanel
          agent={settingsAgent}
          onClose={() => setSettingsSelection(null)}
          onDeleted={handleAgentDeleted}
          onUpdated={(updated) => {
            setSettingsSelection({ channelId, agent: updated });
          }}
        />
      )}
    </>
  );
}

interface ServerLoadState {
  slug: string;
  request: number;
  server: ServerInfo | null;
  error: string;
  errorKind: "" | "runtime" | "runtime-conflict" | "workspace-load" | "workspace-not-found";
}

export function App() {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();
  const [retryKey, setRetryKey] = useState(0);
  const [loadState, setLoadState] = useState<ServerLoadState | null>(null);
  const loadGenerationRef = useRef(0);
  const { t } = useAppSettings();
  const requestedSlug = (params.slug as string) || "local";

  useEffect(() => {
    if (!params.slug) router.replace("/s/local");
  }, [params.slug, router]);

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    const requestController = new AbortController();
    let cancelled = false;
    const isCurrent = () =>
      !cancelled &&
      !requestController.signal.aborted &&
      loadGenerationRef.current === generation;

    async function load() {
      let runtimeReady = false;
      try {
        await waitForRuntime(requestController.signal);
        runtimeReady = true;
        const client = createClient();
        const { data, error: queryError } = await client
          .from("servers")
          .select("*")
          .eq("slug", requestedSlug)
          .maybeSingle();
        if (queryError) throw new Error(queryError.message);
        if (!data) {
          if (!isCurrent()) return;
          setLoadState({
            slug: requestedSlug,
            request: retryKey,
            server: null,
            error: "",
            errorKind: "workspace-not-found",
          });
          return;
        }
        if (!isCurrent()) return;
        setLoadState({
          slug: requestedSlug,
          request: retryKey,
          server: data as ServerInfo,
          error: "",
          errorKind: "",
        });
      } catch (loadError) {
        if (!isCurrent()) return;
        setLoadState({
          slug: requestedSlug,
          request: retryKey,
          server: null,
          error: loadError instanceof Error ? loadError.message : "Desktop runtime failed to start",
          errorKind: loadError instanceof RuntimeConflictError
            ? "runtime-conflict"
            : runtimeReady
              ? "workspace-load"
              : "runtime",
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
      requestController.abort();
    };
  }, [requestedSlug, retryKey]);

  const currentLoadState =
    loadState?.slug === requestedSlug && loadState.request === retryKey ? loadState : null;
  const error = currentLoadState?.error || "";
  const errorKind = currentLoadState?.errorKind || "";

  useEffect(() => {
    if (!error || errorKind === "workspace-not-found") return;
    const retryTimer = window.setTimeout(() => {
      setRetryKey((value) => value + 1);
    }, 2500);
    return () => window.clearTimeout(retryTimer);
  }, [error, errorKind]);

  if (errorKind) {
    const notFound = errorKind === "workspace-not-found";
    const title = notFound
      ? t("workspace.notFound")
      : errorKind === "runtime" || errorKind === "runtime-conflict"
        ? t("runtime.error")
        : t("workspace.loadFailed");
    return (
      <main
        className="flex h-full items-center justify-center bg-background p-8"
        data-tauri-drag-region="deep">
        <div className="max-w-md rounded-xl border bg-card p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground" title={error || undefined}>
            {notFound
              ? t("workspace.notFoundDescription")
              : errorKind === "runtime-conflict"
                ? t("runtime.conflictDescription")
                : errorKind === "runtime"
                  ? t("runtime.errorDescription")
                : t("workspace.loadFailedDescription")}
          </p>
          <button
            className="mt-5 rounded-lg bg-foreground px-4 py-2 text-sm text-background"
            onClick={() => {
              if (notFound) router.replace("/s/local");
              else setRetryKey((value) => value + 1);
            }}
          >
            {t(notFound ? "workspace.openLocal" : "runtime.retry")}
          </button>
        </div>
      </main>
    );
  }

  if (!currentLoadState?.server) {
    return (
      <main
        aria-live="polite"
        className="flex h-full items-center justify-center gap-2 bg-background text-sm text-muted-foreground"
        data-tauri-drag-region="deep">
        <Spinner aria-hidden="true" className="size-3.5 motion-reduce:animate-none" />
        {t("runtime.starting")}
      </main>
    );
  }

  const server = currentLoadState.server;

  const workspaceSection = pathname.endsWith("/documents")
    ? "documents"
    : pathname.endsWith("/tasks")
      ? "tasks"
      : pathname.endsWith("/apps")
        ? "apps"
        : pathname.endsWith("/settings")
          ? "settings"
          : "home";

  return (
    <WorkspaceServerProvider server={server}>
      <AgentActivityProvider key={server.id} serverId={server.id}>
        <div className="desktop-shell relative flex h-full flex-col overflow-hidden bg-rail">
          <WorkspaceTopBar
            serverId={server.id}
            serverName={server.name}
            serverSlug={server.slug}
          />
          <div className="flex min-h-0 flex-1">
            <WorkspaceRail serverSlug={server.slug} />
            {/* Everything right of the rail is one slab lifted off it, the way
                Slack rounds and shadows only that leading top corner. */}
            <div className="workspace-slab flex min-w-0 flex-1 overflow-hidden bg-card">
              <Sidebar serverSlug={server.slug} serverId={server.id} />
              <main
                aria-label={t("nav.content")}
                className="workspace-primary relative flex flex-1 overflow-hidden bg-card outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                data-workspace-keyboard-section
                tabIndex={-1}
              >
                {workspaceSection === "home" ? (
                  <Conversation server={server} />
                ) : workspaceSection === "settings" ? (
                  <DesktopSettingsPage />
                ) : workspaceSection === "apps" ? (
                  <AppsSection serverId={server.id} />
                ) : (
                  <WorkspaceSection
                    section={workspaceSection}
                    serverId={server.id}
                    serverSlug={server.slug}
                  />
                )}
              </main>
            </div>
          </div>
        </div>
      </AgentActivityProvider>
    </WorkspaceServerProvider>
  );
}
