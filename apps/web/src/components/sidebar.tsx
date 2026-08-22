"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useParams, usePathname, useSearchParams } from "next/navigation";
import { CreateAgentDialog } from "./create-agent-dialog";
import { CreateChannelDialog } from "./create-channel-dialog";
import { CreateServerDialog } from "./create-server-dialog";
import { EditChannelDialog } from "./edit-channel-dialog";
import { ContextMenu } from "./context-menu";
import { useAgentActivity } from "@/hooks/use-agent-activity";
import { useAppSettings } from "@/hooks/use-app-settings";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { ChevronDownIcon, ChevronRightIcon, CheckIcon, PlusIcon, PencilIcon, LogOutIcon, SettingsIcon, UserPlusIcon, UserIcon, UsersIcon, HomeIcon, FileTextIcon, ListChecksIcon, CircleIcon, Clock3Icon, ScanEyeIcon, CheckCircle2Icon, BotIcon, CpuIcon, MessageSquareIcon, WrenchIcon } from "lucide-react";
import { GeneratedAvatar } from "./generated-avatar";
import { useWorkspaceNavigation } from "@/hooks/use-navigation-guard";
import { withRequestDeadline } from "@/lib/request-deadline";
import { createTrailingRefreshScheduler } from "@/lib/trailing-refresh";

interface Server {
  id: string;
  name: string;
  slug: string;
}

interface Channel {
  id: string;
  name: string;
  type: string;
  description: string | null;
  server_id: string;
}

interface Agent {
  id: string;
  name: string;
  display_name: string;
  status: string;
  avatar_url: string | null;
  description: string | null;
}

interface DmChannel extends Channel {
  agent?: Agent;
}

interface WorkspaceDocument {
  id: string;
  title: string;
  updated_at: string;
}

interface ChannelMemberRealtimeRecord {
  channel_id?: string;
  member_id?: string;
  member_type?: "human" | "agent";
}

const DEFAULT_SIDEBAR_WIDTH = 256;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const AGENT_PANEL_WIDTH = 360;
const MIN_CHAT_WIDTH = 320;
const WORKSPACE_HORIZONTAL_INSET = 16;
const SIDEBAR_WIDTH_STORAGE_KEY = "teammate:sidebar-width";
const SIDEBAR_WIDTH_CSS_PROPERTY = "--teammate-sidebar-width";
const SIDEBAR_REQUEST_TIMEOUT_MS = 18_000;

function normalizeSidebarWidth(width: number) {
  const safeWidth = Number.isFinite(width) ? width : DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(safeWidth)));
}

function getSidebarMaxWidth(viewportWidth: number) {
  if (!Number.isFinite(viewportWidth)) return MAX_SIDEBAR_WIDTH;
  const availableWidth = Math.floor(
    viewportWidth - AGENT_PANEL_WIDTH - MIN_CHAT_WIDTH - WORKSPACE_HORIZONTAL_INSET,
  );
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, availableWidth));
}

function clampSidebarWidth(width: number, viewportWidth: number) {
  return Math.min(getSidebarMaxWidth(viewportWidth), normalizeSidebarWidth(width));
}

export function Sidebar({
  serverSlug,
  serverId,
  serverName,
}: {
  serverSlug: string;
  serverId: string;
  serverName: string;
}) {
  const [dmChannels, setDmChannels] = useState<DmChannel[]>([]);
  const [groupChannels, setGroupChannels] = useState<Channel[]>([]);
  const [documents, setDocuments] = useState<WorkspaceDocument[]>([]);
  const [userId, setUserId] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [userName, setUserName] = useState("");
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [channelsOpen, setChannelsOpen] = useState(true);
  const [creatingDocument, setCreatingDocument] = useState(false);
  const [documentActionError, setDocumentActionError] = useState("");
  const [sidebarMetrics, setSidebarMetrics] = useState({
    width: DEFAULT_SIDEBAR_WIDTH,
    maxWidth: MAX_SIDEBAR_WIDTH,
  });
  const sidebarRef = useRef<HTMLElement | null>(null);
  const separatorRef = useRef<HTMLDivElement | null>(null);
  const sidebarWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const preferredSidebarWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const resizeFrameRef = useRef<number | null>(null);
  const creatingDocumentRef = useRef(false);
  const documentCreateGenerationRef = useRef(0);
  const documentCreateControllerRef = useRef<AbortController | null>(null);
  const resizeOriginRef = useRef<{
    pointerId: number;
    pointerX: number;
    width: number;
    pendingWidth: number;
    previousCursor: string;
    previousSelection: string;
  } | null>(null);
  const loadGenerationRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const currentChannelIdsRef = useRef<Set<string>>(new Set());
  const currentDocumentIdsRef = useRef<Set<string>>(new Set());
  const currentUserIdRef = useRef("");
  const [unread, setUnread] = useState<Map<string, { mentions: number; unread: number }>>(new Map());
  const workspaceViewRef = useRef<"home" | "documents" | "tasks" | "settings">("home");
  const sidebarRefreshRef = useRef<ReturnType<typeof createTrailingRefreshScheduler> | null>(null);
  const loadRetryAttemptRef = useRef(0);
  const loadRetryTimerRef = useRef<number | null>(null);
  const [loadRetryToken, setLoadRetryToken] = useState(0);
  const [sidebarLoadError, setSidebarLoadError] = useState("");
  const [servers, setServers] = useState<Server[]>([]);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const supabase = createClient();
  const router = useRouter();
  const params = useParams();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const agentActivities = useAgentActivity();
  const { t, openSettings } = useAppSettings();
  const { navigate, run } = useWorkspaceNavigation();
  const localMode = process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_MODE === "true";

  // Determine active channel from URL
  const activeChannelId = params.channelId as string | undefined;
  const workspaceView = pathname.endsWith("/documents")
    ? "documents"
    : pathname.endsWith("/tasks")
      ? "tasks"
      : pathname.endsWith("/settings")
        ? "settings"
        : "home";
  const activeTaskFilter = searchParams.get("status") || "all";
  const activeDocumentId = searchParams.get("document");
  const activeSettingsSection = searchParams.get("section") || "profile";

  useLayoutEffect(() => {
    workspaceViewRef.current = workspaceView;
  }, [workspaceView]);

  const applySidebarWidth = useCallback((nextWidth: number) => {
    const clamped = clampSidebarWidth(nextWidth, window.innerWidth);
    sidebarWidthRef.current = clamped;
    sidebarRef.current?.style.setProperty(SIDEBAR_WIDTH_CSS_PROPERTY, `${clamped}px`);
    separatorRef.current?.setAttribute("aria-valuenow", String(clamped));
    return clamped;
  }, []);

  const commitSidebarWidth = useCallback((nextWidth: number) => {
    const clamped = applySidebarWidth(nextWidth);
    const maxWidth = getSidebarMaxWidth(window.innerWidth);
    preferredSidebarWidthRef.current = clamped;
    setSidebarMetrics((current) =>
      current.width === clamped && current.maxWidth === maxWidth
        ? current
        : { width: clamped, maxWidth },
    );
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clamped));
    } catch {
      // Resizing must remain usable when storage is unavailable.
    }
  }, [applySidebarWidth]);

  useLayoutEffect(() => {
    let preferredWidth = DEFAULT_SIDEBAR_WIDTH;
    try {
      const storedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
      if (Number.isFinite(storedWidth) && storedWidth > 0) {
        preferredWidth = normalizeSidebarWidth(storedWidth);
      }
    } catch {
      // The CSS fallback keeps the default width when storage is unavailable.
    }

    preferredSidebarWidthRef.current = preferredWidth;
    const width = applySidebarWidth(preferredWidth);
    const maxWidth = getSidebarMaxWidth(window.innerWidth);
    separatorRef.current?.setAttribute("aria-valuemax", String(maxWidth));

    // The CSS variable is already applied before paint; state only synchronizes ARIA.
    const frame = window.requestAnimationFrame(() => {
      setSidebarMetrics({ width, maxWidth });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [applySidebarWidth]);

  useEffect(() => {
    let frame: number | null = null;
    const handleViewportResize = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const resizeOrigin = resizeOriginRef.current;
        const width = applySidebarWidth(
          resizeOrigin?.pendingWidth ?? preferredSidebarWidthRef.current,
        );
        const maxWidth = getSidebarMaxWidth(window.innerWidth);
        separatorRef.current?.setAttribute("aria-valuemax", String(maxWidth));
        setSidebarMetrics((current) =>
          current.width === width && current.maxWidth === maxWidth
            ? current
            : { width, maxWidth },
        );
      });
    };

    window.addEventListener("resize", handleViewportResize);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleViewportResize);
    };
  }, [applySidebarWidth]);

  const handleResizePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (resizeOriginRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeOriginRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      width: sidebarWidthRef.current,
      pendingWidth: sidebarWidthRef.current,
      previousCursor: document.body.style.cursor,
      previousSelection: document.body.style.userSelect,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const handleResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const resizeOrigin = resizeOriginRef.current;
    if (!resizeOrigin || resizeOrigin.pointerId !== event.pointerId) return;
    resizeOrigin.pendingWidth = resizeOrigin.width + event.clientX - resizeOrigin.pointerX;
    if (resizeFrameRef.current !== null) return;

    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      const activeResize = resizeOriginRef.current;
      if (activeResize) applySidebarWidth(activeResize.pendingWidth);
    });
  }, [applySidebarWidth]);

  const finishSidebarResize = useCallback((
    event: React.PointerEvent<HTMLDivElement>,
    usePointerPosition: boolean,
  ) => {
    const resizeOrigin = resizeOriginRef.current;
    if (!resizeOrigin || resizeOrigin.pointerId !== event.pointerId) return;
    if (usePointerPosition) {
      resizeOrigin.pendingWidth = resizeOrigin.width + event.clientX - resizeOrigin.pointerX;
    }

    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    const finalWidth = applySidebarWidth(resizeOrigin.pendingWidth);
    resizeOriginRef.current = null;
    document.body.style.cursor = resizeOrigin.previousCursor;
    document.body.style.userSelect = resizeOrigin.previousSelection;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    commitSidebarWidth(finalWidth);
  }, [applySidebarWidth, commitSidebarWidth]);

  useEffect(() => () => {
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    const resizeOrigin = resizeOriginRef.current;
    if (resizeOrigin) {
      document.body.style.cursor = resizeOrigin.previousCursor;
      document.body.style.userSelect = resizeOrigin.previousSelection;
      resizeOriginRef.current = null;
    }
  }, []);

  const loadData = useCallback(async () => {
    loadControllerRef.current?.abort();
    const requestController = new AbortController();
    loadControllerRef.current = requestController;
    const timeout = window.setTimeout(
      () => requestController.abort(),
      SIDEBAR_REQUEST_TIMEOUT_MS,
    );
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    const isCurrent = () => loadGenerationRef.current === generation;
    const finishLoad = () => {
      if (!isCurrent()) return;
      loadRetryAttemptRef.current = 0;
      if (loadRetryTimerRef.current !== null) {
        window.clearTimeout(loadRetryTimerRef.current);
        loadRetryTimerRef.current = null;
      }
      setSidebarLoadError("");
    };

    try {
      const authRequest = supabase.auth.getUser();
      const authResult = await withRequestDeadline<Awaited<typeof authRequest>>(
        authRequest,
        SIDEBAR_REQUEST_TIMEOUT_MS,
        () => requestController.abort(),
      );
      if (requestController.signal.aborted) throw new Error("Request aborted");
      if (authResult.error) throw authResult.error;
      const user = authResult.data.user;
      if (!user) throw new Error("Not authenticated");
      const [
        profileResult,
        serverMembershipsResult,
        documentsResult,
        membershipsResult,
        agentsResult,
      ] = await Promise.all([
        supabase.from("profiles")
          .select("display_name")
          .eq("id", user.id)
          .abortSignal(requestController.signal)
          .single(),
        supabase
          .from("server_members")
          .select("server_id")
          .eq("member_id", user.id)
          .eq("member_type", "human")
          .abortSignal(requestController.signal),
        supabase
          .from("documents")
          .select("id, title, updated_at")
          .eq("server_id", serverId)
          .order("updated_at", { ascending: false })
          .abortSignal(requestController.signal),
        supabase
          .from("channel_members")
          .select("channel_id")
          .eq("member_id", user.id)
          .eq("member_type", "human")
          .abortSignal(requestController.signal),
        supabase
          .from("agents")
          .select("*")
          .eq("server_id", serverId)
          .order("created_at")
          .abortSignal(requestController.signal),
      ]);
      if (requestController.signal.aborted) throw new Error("Request aborted");
      if (!isCurrent()) return;
      const primaryError = [
        profileResult.error,
        serverMembershipsResult.error,
        documentsResult.error,
        membershipsResult.error,
        agentsResult.error,
      ].find(Boolean);
      if (primaryError) throw primaryError;

      setUserId(user.id);
      currentUserIdRef.current = user.id;
      setUserEmail(user.email ?? "");
      if (profileResult.data) setUserName(profileResult.data.display_name);
      const nextDocuments = (documentsResult.data || []) as WorkspaceDocument[];
      currentDocumentIdsRef.current = new Set(nextDocuments.map((document) => document.id));
      setDocuments(nextDocuments);

      const serverMemberships = (serverMembershipsResult.data || []) as Array<{ server_id: string }>;
      if (serverMemberships.length > 0) {
        const { data: allServers, error: serversError } = await supabase
          .from("servers")
          .select("id, name, slug")
          .in("id", serverMemberships.map((membership) => membership.server_id))
          .order("created_at")
          .abortSignal(requestController.signal);
        if (requestController.signal.aborted) throw new Error("Request aborted");
        if (!isCurrent()) return;
        if (serversError) throw serversError;
        setServers((allServers || []) as Server[]);
      } else {
        setServers([]);
      }

      const memberships = (membershipsResult.data || []) as Array<{ channel_id: string }>;
      if (memberships.length === 0) {
        currentChannelIdsRef.current = new Set();
        setDmChannels([]);
        setGroupChannels([]);
        finishLoad();
        return;
      }

      const channelIds = Array.from(new Set(memberships.map((membership) => membership.channel_id)));
      const [channelsResult, agentMembershipsResult] = await Promise.all([
        supabase
          .from("channels")
          .select("*")
          .eq("server_id", serverId)
          .in("id", channelIds)
          .order("created_at")
          .abortSignal(requestController.signal),
        supabase
          .from("channel_members")
          .select("channel_id, member_id")
          .in("channel_id", channelIds)
          .eq("member_type", "agent")
          .abortSignal(requestController.signal),
      ]);
      if (requestController.signal.aborted) throw new Error("Request aborted");
      if (!isCurrent()) return;
      if (channelsResult.error) throw channelsResult.error;
      if (agentMembershipsResult.error) throw agentMembershipsResult.error;

      const channels = (channelsResult.data || []) as Channel[];
      currentChannelIdsRef.current = new Set(channels.map((channel) => channel.id));
      const agentList = (agentsResult.data || []) as Agent[];
      const agentById = new Map(agentList.map((agent) => [agent.id, agent]));
      const agentIdByChannel = new Map(
        ((agentMembershipsResult.data || []) as Array<{ channel_id: string; member_id: string }>).map(
          (membership) => [membership.channel_id, membership.member_id],
        ),
      );

      const dms: DmChannel[] = [];
      const groups: Channel[] = [];
      for (const ch of channels) {
        if (ch.type === "dm") {
          const agent = agentById.get(agentIdByChannel.get(ch.id) || "");
          dms.push({ ...ch, agent });
        } else {
          groups.push(ch);
        }
      }

      setDmChannels(dms);
      setGroupChannels(groups);
      finishLoad();
    } catch (loadError) {
      if (!isCurrent()) return;
      setSidebarLoadError(
        requestController.signal.aborted
          ? t("sidebar.loadTimedOut")
          : loadError instanceof Error ? loadError.message : t("sidebar.loadFailed"),
      );
      if (loadRetryTimerRef.current === null) {
        const delay = Math.min(400 * 2 ** loadRetryAttemptRef.current, 5000);
        loadRetryAttemptRef.current += 1;
        loadRetryTimerRef.current = window.setTimeout(() => {
          loadRetryTimerRef.current = null;
          setLoadRetryToken((token) => token + 1);
        }, delay);
      }
    } finally {
      window.clearTimeout(timeout);
      if (loadControllerRef.current === requestController) {
        loadControllerRef.current = null;
      }
    }
  }, [serverId, supabase, t]);

  useEffect(() => {
    const refresh = createTrailingRefreshScheduler(loadData, 120);
    sidebarRefreshRef.current = refresh;
    return () => {
      refresh.cancel();
      if (sidebarRefreshRef.current === refresh) sidebarRefreshRef.current = null;
    };
  }, [loadData]);

  // What each channel owes you. Kept beside the channel list rather than in it
  // so a count landing does not re-run the whole sidebar load.
  const loadUnread = useCallback(async () => {
    if (!serverId) return;
    const { data, error } = await supabase.rpc("channel_unread_counts", {
      display_name: userName,
      server_uuid: serverId,
    });
    if (error || !Array.isArray(data)) return;
    const next = new Map<string, { mentions: number; unread: number }>();
    for (const row of data as Array<{ channel_id: string; mentions: number; unread: number }>) {
      if (row.unread > 0) next.set(row.channel_id, { mentions: row.mentions, unread: row.unread });
    }
    setUnread(next);
  }, [serverId, supabase, userName]);

  useEffect(() => {
    if (!serverId) return;
    const refresh = createTrailingRefreshScheduler(loadUnread, 200);
    void refresh.runNow();
    // A new message anywhere in the workspace, or reading one, changes what the
    // sidebar owes you. Both arrive as ordinary table events.
    const subscription = supabase
      .channel(`sidebar-unread:${serverId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () =>
        refresh.schedule(),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "channel_read_state" }, () =>
        refresh.schedule(),
      )
      .subscribe();
    return () => {
      refresh.cancel();
      void supabase.removeChannel(subscription);
    };
  }, [loadUnread, serverId, supabase]);

  const refreshSidebarNow = useCallback(
    () => sidebarRefreshRef.current?.runNow() ?? Promise.resolve(),
    [],
  );
  const scheduleSidebarRefresh = useCallback(
    () => sidebarRefreshRef.current?.schedule(),
    [],
  );

  useEffect(() => {
    currentChannelIdsRef.current = new Set();
    currentDocumentIdsRef.current = new Set();
    currentUserIdRef.current = "";
    const frame = window.requestAnimationFrame(() => {
      loadGenerationRef.current += 1;
      documentCreateGenerationRef.current += 1;
      loadRetryAttemptRef.current = 0;
      if (loadRetryTimerRef.current !== null) {
        window.clearTimeout(loadRetryTimerRef.current);
        loadRetryTimerRef.current = null;
      }
      setSidebarLoadError("");
      setDocumentActionError("");
      creatingDocumentRef.current = false;
      setCreatingDocument(false);
      setDmChannels([]);
      setGroupChannels([]);
      setDocuments([]);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      loadGenerationRef.current += 1;
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
      documentCreateGenerationRef.current += 1;
      documentCreateControllerRef.current?.abort();
      documentCreateControllerRef.current = null;
      creatingDocumentRef.current = false;
    };
  }, [serverId]);

  // Load sidebar data on mount (realtime subscriptions handle subsequent updates)
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void refreshSidebarNow());
    return () => window.cancelAnimationFrame(frame);
  }, [loadRetryToken, refreshSidebarNow, workspaceView]);

  useEffect(() => () => {
    documentCreateGenerationRef.current += 1;
    documentCreateControllerRef.current?.abort();
    documentCreateControllerRef.current = null;
    loadGenerationRef.current += 1;
    loadControllerRef.current?.abort();
    loadControllerRef.current = null;
    if (loadRetryTimerRef.current !== null) {
      window.clearTimeout(loadRetryTimerRef.current);
      loadRetryTimerRef.current = null;
    }
  }, []);

  // Set up realtime subscriptions (stable across navigations, only recreate on server change)
  useEffect(() => {
    const realtimeSub = supabase
      .channel(`sidebar-realtime:${serverId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "agents",
          filter: `server_id=eq.${serverId}`,
        },
        (payload: { new: Agent }) => {
          const updated = payload.new;
          setDmChannels((prev) =>
            prev.map((dm) =>
              dm.agent?.id === updated.id
                ? { ...dm, agent: { ...dm.agent, ...updated } }
                : dm
            )
          );
        }
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "agents",
          filter: `server_id=eq.${serverId}`,
        },
        () => {
          if (workspaceViewRef.current === "home") scheduleSidebarRefresh();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "agents",
          filter: `server_id=eq.${serverId}`,
        },
        () => {
          if (workspaceViewRef.current === "home") scheduleSidebarRefresh();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "channel_members" },
        (payload: {
          new?: ChannelMemberRealtimeRecord;
          old?: ChannelMemberRealtimeRecord;
        }) => {
          if (workspaceViewRef.current !== "home") return;
          const record = payload.new?.channel_id ? payload.new : payload.old;
          const channelId = record?.channel_id;
          if (!channelId) return;
          const isKnownChannel = currentChannelIdsRef.current.has(channelId);
          const isCurrentUserJoin = record?.member_id === currentUserIdRef.current &&
            (record.member_type === undefined || record.member_type === "human");
          if (isKnownChannel || isCurrentUserJoin) scheduleSidebarRefresh();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "channels",
          filter: `server_id=eq.${serverId}`,
        },
        (payload: { new?: Partial<Channel>; old?: Partial<Channel> }) => {
          if (workspaceViewRef.current !== "home") return;
          const record = payload.new?.id ? payload.new : payload.old;
          if (record?.server_id && record.server_id !== serverId) return;
          if (!record?.server_id && record?.id && !currentChannelIdsRef.current.has(record.id)) return;
          scheduleSidebarRefresh();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "documents",
          filter: `server_id=eq.${serverId}`,
        },
        (payload: {
          new?: Partial<WorkspaceDocument> & { server_id?: string };
          old?: Partial<WorkspaceDocument> & { server_id?: string };
        }) => {
          if (workspaceViewRef.current !== "documents") return;
          const record = payload.new?.id ? payload.new : payload.old;
          if (record?.server_id && record.server_id !== serverId) return;
          if (!record?.server_id && record?.id && !currentDocumentIdsRef.current.has(record.id)) return;
          scheduleSidebarRefresh();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(realtimeSub);
    };
  }, [scheduleSidebarRefresh, serverId, supabase]);

  function navigateToChannel(channel: Channel) {
    const prefix = channel.type === "dm" ? "dm" : "channel";
    navigate(`/s/${serverSlug}/${prefix}/${channel.id}`);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  function handleAgentCreated() {
    void refreshSidebarNow();
  }

  function handleChannelCreated() {
    void refreshSidebarNow();
  }

  function handleChannelDeleted(channelId: string) {
    setEditingChannel(null);
    void refreshSidebarNow();
    if (activeChannelId === channelId) {
      navigate(`/s/${serverSlug}`);
    }
  }

  async function handleCreateDocument() {
    if (!userId || creatingDocumentRef.current) return;
    const generation = documentCreateGenerationRef.current + 1;
    documentCreateGenerationRef.current = generation;
    const isCurrentCreate = () => documentCreateGenerationRef.current === generation;
    creatingDocumentRef.current = true;
    setCreatingDocument(true);
    setDocumentActionError("");
    documentCreateControllerRef.current?.abort();
    const requestController = new AbortController();
    documentCreateControllerRef.current = requestController;
    const timeout = window.setTimeout(
      () => requestController.abort(),
      SIDEBAR_REQUEST_TIMEOUT_MS,
    );
    try {
      const { data, error } = await supabase
        .from("documents")
        .insert({
          server_id: serverId,
          title: t("documents.untitled"),
          content: "",
          created_by: userId,
        })
        .select("id, title, updated_at")
        .abortSignal(requestController.signal)
        .single();
      if (!isCurrentCreate()) return;
      if (error || !data) throw new Error(error?.message || t("documents.createFailed"));
      const document = data as WorkspaceDocument;
      currentDocumentIdsRef.current.add(document.id);
      setDocuments((current) => [document, ...current.filter((item) => item.id !== document.id)]);
      router.push(`/s/${serverSlug}/documents?document=${document.id}`);
    } catch (createError) {
      if (!isCurrentCreate()) return;
      const reason = createError instanceof Error ? createError.message : "";
      setDocumentActionError(
        requestController.signal.aborted
          ? t("documents.createTimedOut")
          : reason && reason !== t("documents.createFailed")
          ? `${t("documents.createFailed")} ${reason}`
          : t("documents.createFailed"),
      );
    } finally {
      window.clearTimeout(timeout);
      if (documentCreateControllerRef.current === requestController) {
        documentCreateControllerRef.current = null;
      }
      if (isCurrentCreate()) {
        creatingDocumentRef.current = false;
        setCreatingDocument(false);
      }
    }
  }

  function getStatusDot(agent: Agent | undefined) {
    const activityState = agent ? agentActivities.get(agent.id) : undefined;
    const activity = activityState?.activity;
    const isOnline = agent?.status === "online" || agent?.status === "active";

    if (activity === "error" || agent?.status === "error") return "bg-destructive";
    if (isOnline && (activity === "thinking" || activity === "working")) {
      return "bg-success animate-status-pulse";
    }
    if (isOnline) return "bg-success";
    return "bg-muted-foreground/40";
  }

  return (
    <aside
      ref={sidebarRef}
      className="desktop-sidebar relative flex h-full shrink-0 flex-col"
      style={{ width: `var(${SIDEBAR_WIDTH_CSS_PROPERTY}, ${DEFAULT_SIDEBAR_WIDTH}px)` }}
    >
      <div
        className="desktop-sidebar-titlebar-spacer desktop-native-drag flex-none"
        data-tauri-drag-region
        aria-hidden="true"
      />

      {/* Workspace switcher stays above the workspace navigation. */}
      <div
        className="desktop-sidebar-header flex h-9 items-center"
        data-tauri-drag-region="deep">
        <Menu>
          <MenuTrigger className="group flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
              {serverName}
            </span>
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-data-popup-open:rotate-180" />
          </MenuTrigger>
          <MenuPopup align="start" className="max-h-64 w-(--anchor-width)">
            {servers.map((server) => (
              <MenuItem
                key={server.id}
                className={server.slug === serverSlug ? "bg-accent font-medium" : undefined}
                onClick={() => {
                  if (server.slug !== serverSlug) navigate(`/s/${server.slug}`);
                }}
              >
                <GeneratedAvatar
                  className="rounded-md"
                  id={server.id}
                  initials
                  name={server.name}
                  size="xs"
                />
                <span className="min-w-0 flex-1 truncate">{server.name}</span>
                {server.slug === serverSlug && (
                  <CheckIcon className="ml-auto size-3.5 shrink-0" strokeWidth={2.5} />
                )}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onClick={() => setShowCreateServer(true)}>
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground">
                <PlusIcon className="size-3" />
              </span>
              <span>{t("workspace.create")}</span>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-4">
        {sidebarLoadError && (
          <div
            role="alert"
            title={sidebarLoadError}
            className="mx-1 flex items-center justify-between gap-2 rounded-lg bg-destructive/8 px-2.5 py-2 text-xs text-destructive"
          >
            <span className="min-w-0 truncate">{t("sidebar.loadFailed")}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={() => {
                if (loadRetryTimerRef.current !== null) {
                  window.clearTimeout(loadRetryTimerRef.current);
                  loadRetryTimerRef.current = null;
                }
                loadRetryAttemptRef.current = 0;
                setLoadRetryToken((token) => token + 1);
              }}
            >
              {t("runtime.retry")}
            </Button>
          </div>
        )}
        {workspaceView === "home" && (
          <>
        {/* DM Conversations */}
        <Collapsible open={agentsOpen} onOpenChange={setAgentsOpen}>
          <div className="mb-1 flex h-8 items-center justify-between px-2">
            <CollapsibleTrigger className="flex h-8 min-w-0 items-center gap-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground">
              <span className="truncate">{t("nav.agents")}</span>
              <ChevronRightIcon className={`size-3 transition-transform ${agentsOpen ? "rotate-90" : ""}`} />
            </CollapsibleTrigger>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setShowCreateAgent(true)}
              className="text-muted-foreground hover:text-accent-foreground"
              title={t("nav.createAgent")}
              aria-label={t("nav.createAgent")}
            >
              <PlusIcon className="size-3.5" />
            </Button>
          </div>
          <CollapsiblePanel>
            <div className="flex flex-col gap-[2px]">
              {dmChannels.map((dm) => (
              <button
                key={dm.id}
                onClick={() => navigateToChannel(dm)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 h-[32px] text-[13px] transition-all ${
                  activeChannelId === dm.id
                    ? "bg-sanda-3 text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-sanda-3 hover:text-accent-foreground"
                }`}
              >
                {/* Agent avatar */}
                <div className="relative flex-shrink-0 size-6">
                  <GeneratedAvatar
                    id={dm.agent?.id || dm.id}
                    name={dm.agent?.display_name || dm.name}
                    size="xs"
                    avatarUrl={dm.agent?.avatar_url}
                  />
                  {/* Status dot */}
                  <div
                    className={`absolute bottom-0 right-0 h-1.5 w-1.5 translate-x-[1px] translate-y-[1px] rounded-full border-[1.5px] border-background ${getStatusDot(dm.agent)}`}
                    title={(() => {
                      const act = agentActivities.get(dm.agent?.id || "");
                      if (act?.label && act.activity !== "idle") {
                        return act.detail ? `${act.label}: ${act.detail}` : act.label;
                      }
                      return dm.agent?.status === "online" || dm.agent?.status === "active"
                        ? "Online"
                        : "Offline";
                    })()}
                  />
                </div>

                <div className="flex-1 min-w-0 text-left">
                  <div className="truncate">
                    {dm.agent?.display_name || dm.name}
                  </div>
                </div>
              </button>
              ))}
            </div>
          </CollapsiblePanel>
        </Collapsible>

        {/* Group Channels */}
        <Collapsible open={channelsOpen} onOpenChange={setChannelsOpen}>
          <div className="mb-1 flex h-8 items-center justify-between px-2">
            <CollapsibleTrigger className="flex h-8 min-w-0 items-center gap-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground">
              <span className="truncate">{t("nav.channels")}</span>
              <ChevronRightIcon className={`size-3 transition-transform ${channelsOpen ? "rotate-90" : ""}`} />
            </CollapsibleTrigger>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setShowCreateChannel(true)}
              className="text-muted-foreground hover:text-accent-foreground"
              title={t("nav.createChannel")}
              aria-label={t("nav.createChannel")}
            >
              <PlusIcon className="size-3.5" />
            </Button>
          </div>
          <CollapsiblePanel>
            <div className="flex flex-col gap-[2px]">
              {groupChannels.map((channel) => {
              const isActive = activeChannelId === channel.id;
              // Slack's rule: a channel with something waiting reads at full
              // strength and in bold; the badge is reserved for messages that
              // said your name, because those are the ones that need you.
              const pending = isActive ? undefined : unread.get(channel.id);
              return (
                <ContextMenu
                  key={channel.id}
                  className={`group flex h-[32px] w-full items-center rounded-lg text-[13px] transition-all ${
                    isActive
                      ? "bg-sanda-3 font-medium text-accent-foreground"
                      : pending
                        ? "font-black text-accent-foreground hover:bg-sanda-3"
                        : "text-muted-foreground hover:bg-sanda-3 hover:text-accent-foreground"
                  }`}
                  items={[
                    {
                      label: t("channel.editTitle"),
                      icon: <PencilIcon className="size-3.5" />,
                      onClick: () => setEditingChannel(channel),
                    },
                  ]}
                >
                  <button
                    type="button"
                    onClick={() => navigateToChannel(channel)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 text-left"
                  >
                    <span className={pending ? "text-accent-foreground" : "text-muted-foreground"}>
                      #
                    </span>
                    <span className="truncate">{channel.name}</span>
                  </button>
                  {pending && pending.mentions > 0 && (
                    <span className="mr-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-mention px-[5px] text-[10px] font-bold text-mention-foreground tabular-nums">
                      {pending.mentions > 99 ? '99+' : pending.mentions}
                    </span>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setEditingChannel(channel)}
                    className={`mr-1 text-muted-foreground transition-opacity hover:text-accent-foreground ${
                      isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
                    }`}
                    title={t("channel.manageAgents")}
                    aria-label={t("channel.manageAgents")}
                  >
                    <UserPlusIcon className="size-3.5" />
                  </Button>
                </ContextMenu>
              );
              })}
            </div>
          </CollapsiblePanel>
        </Collapsible>

          </>
        )}

        {workspaceView === "documents" && (
          <div className="space-y-3">
            <div className="flex h-[22px] items-center justify-between px-2">
              <span className="text-[12px] font-medium text-muted-foreground">
                {t("documents.title")}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => run(() => void handleCreateDocument())}
                loading={creatingDocument}
                title={t("documents.new")}
                aria-label={t("documents.new")}
              >
                <PlusIcon />
              </Button>
            </div>
            {documents.length === 0 ? (
              <p className="px-2 pt-2 text-xs leading-relaxed text-muted-foreground">
                {t("documents.sidebarEmpty")}
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {documents.map((document) => (
                  <Button
                    key={document.id}
                    variant="ghost"
                    size="sm"
                    className={`w-full justify-start ${activeDocumentId === document.id ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                    onClick={() => navigate(`/s/${serverSlug}/documents?document=${document.id}`)}
                    aria-current={activeDocumentId === document.id ? "page" : undefined}
                  >
                    <FileTextIcon />
                    <span className="truncate">{document.title || t("documents.untitled")}</span>
                  </Button>
                ))}
              </div>
            )}
            {documentActionError && (
              <p className="px-2 text-xs leading-relaxed text-destructive" role="alert">
                {documentActionError}
              </p>
            )}
          </div>
        )}

        {workspaceView === "tasks" && (
          <div className="space-y-3">
            <div className="flex h-[22px] items-center px-2">
              <span className="text-[12px] font-medium text-muted-foreground">
                {t("tasks.title")}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {[
                { id: "all", label: t("tasks.all"), icon: ListChecksIcon },
                { id: "todo", label: t("tasks.todo"), icon: CircleIcon },
                { id: "in_progress", label: t("tasks.inProgress"), icon: Clock3Icon },
                { id: "in_review", label: t("tasks.inReview"), icon: ScanEyeIcon },
                { id: "done", label: t("tasks.done"), icon: CheckCircle2Icon },
              ].map((filter) => {
                const Icon = filter.icon;
                const active = activeTaskFilter === filter.id;
                return (
                  <Button
                    key={filter.id}
                    variant="ghost"
                    size="sm"
                    className={`w-full justify-start ${active ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                    onClick={() => navigate(
                      filter.id === "all"
                        ? `/s/${serverSlug}/tasks`
                        : `/s/${serverSlug}/tasks?status=${filter.id}`,
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon />
                    {filter.label}
                  </Button>
                );
              })}
            </div>
          </div>
        )}

        {workspaceView === "settings" && (
          <div className="space-y-3">
            <div className="flex h-[22px] items-center px-2">
              <span className="text-[12px] font-medium text-muted-foreground">
                {t("settings.title")}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {[
                { id: "profile", label: t("settings.navProfile"), icon: UserIcon },
                { id: "workspace", label: t("settings.navWorkspace"), icon: UsersIcon },
                { id: "general", label: t("settings.navGeneral"), icon: SettingsIcon },
                { id: "models", label: t("settings.navModels"), icon: BotIcon },
                { id: "runtimes", label: t("settings.navRuntimes"), icon: CpuIcon },
                { id: "chat", label: t("settings.navChat"), icon: MessageSquareIcon },
                { id: "advanced", label: t("settings.navAdvanced"), icon: WrenchIcon },
              ].map((section) => {
                const Icon = section.icon;
                const active = activeSettingsSection === section.id;
                return (
                  <Button
                    key={section.id}
                    variant="ghost"
                    size="sm"
                    className={`w-full justify-start ${active ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                    onClick={() => navigate(`/s/${serverSlug}/settings?section=${section.id}`)}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon />
                    {section.label}
                  </Button>
                );
              })}
            </div>
          </div>
        )}

      </div>

      {localMode && (
        <nav
          className="grid grid-cols-4 justify-items-center gap-1 px-2 py-2"
          aria-label={t("nav.workspace")}
        >
          {[
            {
              id: "home",
              label: t("nav.home"),
              icon: HomeIcon,
              active: workspaceView === "home",
              onClick: () => navigate(`/s/${serverSlug}`),
            },
            {
              id: "documents",
              label: t("nav.documents"),
              icon: FileTextIcon,
              active: workspaceView === "documents",
              onClick: () => navigate(`/s/${serverSlug}/documents`),
            },
            {
              id: "tasks",
              label: t("nav.tasks"),
              icon: ListChecksIcon,
              active: workspaceView === "tasks",
              onClick: () => navigate(`/s/${serverSlug}/tasks`),
            },
            {
              id: "settings",
              label: t("nav.settings"),
              icon: SettingsIcon,
              active: workspaceView === "settings",
              onClick: () => navigate(`/s/${serverSlug}/settings`),
            },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <Button
                key={item.id}
                type="button"
                variant="ghost"
                size="icon-sm"
                className={item.active ? "bg-accent text-foreground shadow-xs/5" : "text-muted-foreground"}
                onClick={item.onClick}
                title={item.label}
                aria-label={item.label}
                aria-current={item.active ? "page" : undefined}
              >
                <Icon className="size-4" strokeWidth={item.active ? 2.2 : 1.8} />
              </Button>
            );
          })}
        </nav>
      )}

      {!localMode && (
        <div className="mx-2 mb-1 flex items-center gap-2 rounded-lg px-3 py-2.5">
          <GeneratedAvatar id={userId || userEmail} name={userName || userEmail} size="xs" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium text-muted-foreground">
              {userName}
            </div>
          </div>
          <button
            onClick={() => run(() => void handleLogout())}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            title="Sign out"
          >
            <LogOutIcon className="size-3.5" />
          </button>
          {openSettings && (
            <button
              onClick={openSettings}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              title={t("nav.settings")}
              aria-label={t("nav.settings")}
            >
              <SettingsIcon className="size-3.5" />
            </button>
          )}
        </div>
      )}
      <CreateAgentDialog
        open={showCreateAgent}
        onClose={() => setShowCreateAgent(false)}
        onCreated={handleAgentCreated}
        serverId={serverId}
      />
      <CreateChannelDialog
        open={showCreateChannel}
        onClose={() => setShowCreateChannel(false)}
        onCreated={handleChannelCreated}
        serverId={serverId}
      />
      <CreateServerDialog
        open={showCreateServer}
        onClose={() => setShowCreateServer(false)}
      />
      {editingChannel && (
        <EditChannelDialog
          channel={editingChannel}
          open={!!editingChannel}
          onClose={() => setEditingChannel(null)}
          onUpdated={() => void refreshSidebarNow()}
          onDeleted={handleChannelDeleted}
        />
      )}
      <div
        ref={separatorRef}
        role="separator"
        aria-label={t("nav.resizeSidebar")}
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={sidebarMetrics.maxWidth}
        aria-valuenow={sidebarMetrics.width}
        tabIndex={0}
        className="absolute inset-y-0 -right-1 z-30 w-2 cursor-col-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={(event) => finishSidebarResize(event, true)}
        onPointerCancel={(event) => finishSidebarResize(event, false)}
        onLostPointerCapture={(event) => finishSidebarResize(event, false)}
        onDoubleClick={() => commitSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            commitSidebarWidth(sidebarWidthRef.current - 8);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            commitSidebarWidth(sidebarWidthRef.current + 8);
          } else if (event.key === "Home") {
            event.preventDefault();
            commitSidebarWidth(MIN_SIDEBAR_WIDTH);
          } else if (event.key === "End") {
            event.preventDefault();
            commitSidebarWidth(MAX_SIDEBAR_WIDTH);
          }
        }}
      />
    </aside>
  );
}
