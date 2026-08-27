"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { CheckIcon, PlusIcon } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAppSettings, type TranslationKey } from "@/hooks/use-app-settings";
import { useWorkspaceNavigation } from "@/hooks/use-navigation-guard";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { createTrailingRefreshScheduler } from "@/lib/trailing-refresh";
import { CreateServerDialog } from "./create-server-dialog";
import { GeneratedAvatar } from "./generated-avatar";
import {
  WorkspaceRailIcon,
  type WorkspaceRailGlyph,
} from "./workspace-rail-icons";

/**
 * Which workspace you are in, and which part of it, kept apart from which
 * conversation you are in.
 *
 * The four areas used to sit as icon-only buttons along the foot of the sidebar,
 * which made the top level of the app its least visible control, and the
 * workspace switcher was a dropdown wearing the sidebar's header. Slack gives
 * the pair its own column, for a reason that applies here too: the sidebar's
 * contents change meaning between workspaces and between areas — channels in
 * one, a folder tree in another — and those switches only read as deliberate
 * while the things driving them stay in view.
 *
 * The measurements and behaviour come from Slack's renderer bundle rather than
 * from tracing pixels in a screenshot: 70px wide, a 36px workspace avatar, and
 * 52×68 tabs whose glyph sits in a 36px rounded box. Its vertical tabs use
 * manual activation, swap to a filled glyph when selected, and collapse lower
 * priority destinations into a Browse tab when height is constrained. This
 * rail follows that model while keeping Teammate's own routes and vocabulary.
 *
 * The frame around it follows the same source: the rail paints nothing, the
 * shell behind it carries --rail, and the sidebar and chat together are one
 * .workspace-slab lifted off that base. Within the slab the sidebar takes
 * bg-rail/10, which is Slack's list column at 90% of its chat's white.
 */

interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
}

interface Area {
  glyph: WorkspaceRailGlyph;
  id: string;
  label: TranslationKey;
  /** Appended to the workspace root, so home is the root itself. */
  path: string;
}

const AREAS: Area[] = [
  { glyph: "home", id: "home", label: "nav.home", path: "" },
  { glyph: "documents", id: "documents", label: "nav.documents", path: "/documents" },
  { glyph: "tasks", id: "tasks", label: "nav.tasks", path: "/tasks" },
  { glyph: "apps", id: "apps", label: "nav.apps", path: "/apps" },
];

// Settings is not a place you work, so it sits apart from the three that are —
// the same separation Slack gives the admin tab.
const SETTINGS: Area = {
  glyph: "settings",
  id: "settings",
  label: "nav.settings",
  path: "/settings",
};

const ALL_AREAS = [...AREAS, SETTINGS];
const TAB_HEIGHT = 68;
const SETTINGS_GAP = 21;

interface RailLayout {
  overflowAreas: Area[];
  visibleAreas: Area[];
}

function layoutAreas(height: number): RailLayout {
  const fullHeight = ALL_AREAS.length * TAB_HEIGHT + SETTINGS_GAP;
  if (height >= fullHeight) {
    return { overflowAreas: [], visibleAreas: ALL_AREAS };
  }

  // Browse consumes a row of its own. Home always survives; the remaining
  // destinations retain preference order inside the menu, as Slack does.
  const rows = Math.max(2, Math.floor(height / TAB_HEIGHT));
  const visibleAreas = ALL_AREAS.slice(0, Math.max(1, rows - 1));
  return {
    overflowAreas: ALL_AREAS.slice(visibleAreas.length),
    visibleAreas,
  };
}

export function WorkspaceRail({ serverId, serverSlug }: { serverId: string; serverSlug: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const { navigate } = useWorkspaceNavigation();
  const { t } = useAppSettings();
  const supabase = useMemo(() => createClient(), []);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [windowActive, setWindowActive] = useState(true);
  const [tabsHeight, setTabsHeight] = useState(Number.POSITIVE_INFINITY);
  const [attention, setAttention] = useState({ mentions: 0, unread: 0 });
  const tabsRegionRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [account, setAccount] = useState<{ avatarUrl: string | null; id: string; name: string }>({
    avatarUrl: null,
    id: "",
    name: "",
  });

  useEffect(() => {
    let cancelled = false;
    async function loadWorkspaces() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (cancelled || !user) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name, avatar_url")
        .eq("id", user.id)
        .single();
      if (cancelled) return;
      const row = profile as { avatar_url?: string | null; display_name?: string } | null;
      setAccount({
        avatarUrl: row?.avatar_url || null,
        id: user.id,
        name: row?.display_name || user.email || "",
      });
      const { data: memberships } = await supabase
        .from("server_members")
        .select("server_id")
        .eq("member_id", user.id)
        .eq("member_type", "human");
      if (cancelled) return;
      const ids = ((memberships || []) as Array<{ server_id: string }>).map(
        (membership) => membership.server_id,
      );
      if (ids.length === 0) {
        setWorkspaces([]);
        return;
      }
      const { data } = await supabase
        .from("servers")
        .select("id, name, slug")
        .in("id", ids)
        .order("created_at");
      if (cancelled) return;
      setWorkspaces((data || []) as WorkspaceSummary[]);
    }
    void loadWorkspaces();

    // Your name and face are edited a screen away, under settings, which is not
    // a navigation this column sees. Without this the rail would keep showing
    // who you used to be until the next workspace switch.
    const subscription = supabase
      .channel(`workspace-rail:${serverSlug}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "profiles" },
        () => void loadWorkspaces(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "servers" },
        () => void loadWorkspaces(),
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(subscription);
    };
    // Creating a workspace lands you in it, so keying on the slug is also what
    // picks up the new one.
  }, [serverSlug, supabase]);

  useEffect(() => {
    const region = tabsRegionRef.current;
    if (!region) return;
    const measure = () => setTabsHeight(region.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const syncWindowState = () => setWindowActive(document.hasFocus());
    syncWindowState();
    window.addEventListener("focus", syncWindowState);
    window.addEventListener("blur", syncWindowState);
    return () => {
      window.removeEventListener("focus", syncWindowState);
      window.removeEventListener("blur", syncWindowState);
    };
  }, []);

  const loadAttention = useCallback(async () => {
    const { data, error } = await supabase.rpc("channel_unread_counts", {
      display_name: account.name,
      server_uuid: serverId,
    });
    if (error || !Array.isArray(data)) return;
    let unread = 0;
    let mentions = 0;
    for (const row of data as Array<{ mentions: number; unread: number }>) {
      unread += Number(row.unread) || 0;
      mentions += Number(row.mentions) || 0;
    }
    setAttention({ mentions, unread });
  }, [account.name, serverId, supabase]);

  useEffect(() => {
    const refresh = createTrailingRefreshScheduler(loadAttention, 200);
    void refresh.runNow();
    const subscription = supabase
      .channel(`workspace-rail-unread:${serverId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () =>
        refresh.schedule(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "channel_read_state" },
        () => refresh.schedule(),
      )
      .subscribe();
    return () => {
      refresh.cancel();
      void supabase.removeChannel(subscription);
    };
  }, [loadAttention, serverId, supabase]);

  // Hosted workspaces have no documents or tasks to switch between, and their
  // settings live under the account menu instead.
  if (process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_MODE !== "true") return null;

  const current = pathname.endsWith("/documents")
    ? "documents"
    : pathname.endsWith("/tasks")
      ? "tasks"
      : pathname.endsWith("/apps")
        ? "apps"
        : pathname.endsWith("/settings")
          ? "settings"
          : "home";

  const activeWorkspace = workspaces.find((workspace) => workspace.slug === serverSlug);
  const { overflowAreas, visibleAreas } = layoutAreas(tabsHeight);
  const currentIsOverflowed = overflowAreas.some((area) => area.id === current);
  const focusableId = currentIsOverflowed
    ? "more"
    : visibleAreas.some((area) => area.id === current)
      ? current
      : visibleAreas[0]?.id;
  const visibleTabIds = [
    ...visibleAreas.map((area) => area.id),
    ...(overflowAreas.length > 0 ? ["more"] : []),
  ];

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = Math.max(0, visibleTabIds.indexOf(id));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? visibleTabIds.length - 1
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + visibleTabIds.length)
          % visibleTabIds.length;
    tabRefs.current.get(visibleTabIds[nextIndex])?.focus();
  };

  const renderArea = (area: Area) => {
    const active = current === area.id;
    const label = t(area.label);
    const href = `/s/${serverSlug}${area.path}`;
    const isHome = area.id === "home";
    const badgeCount = isHome ? (attention.mentions || attention.unread) : 0;
    const badgeLabel = isHome && badgeCount > 0
      ? t(attention.mentions > 0 ? "nav.mentions" : "nav.unread", { count: String(badgeCount) })
      : "";
    return (
      <button
        key={area.id}
        ref={(node) => {
          if (node) tabRefs.current.set(area.id, node);
          else tabRefs.current.delete(area.id);
        }}
        type="button"
        onClick={() => {
          if (pathname !== href) navigate(href);
        }}
        onFocus={() => router.prefetch(href)}
        onKeyDown={(event) => handleTabKeyDown(event, area.id)}
        onPointerEnter={() => router.prefetch(href)}
        title={badgeLabel ? `${label} · ${badgeLabel}` : label}
        aria-label={badgeLabel ? `${label}, ${badgeLabel}` : label}
        aria-current={active ? "page" : undefined}
        aria-selected={active}
        className="workspace-rail-tab"
        data-active={active}
        role="tab"
        tabIndex={focusableId === area.id ? 0 : -1}
      >
        <span className="workspace-rail-tab-icon">
          <WorkspaceRailIcon
            active={active}
            className="workspace-rail-tab-glyph"
            glyph={area.glyph}
          />
          {badgeCount > 0 && (
            <span aria-hidden="true" className="workspace-rail-badge" data-mention={attention.mentions > 0}>
              {badgeCount > 99 ? "99+" : badgeCount}
            </span>
          )}
        </span>
        <span className="workspace-rail-tab-label">{label}</span>
      </button>
    );
  };

  return (
    <>
      <nav
        aria-label={t("nav.workspace")}
        className="workspace-rail flex h-full w-[70px] shrink-0 flex-col items-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        data-window-active={windowActive}
        data-workspace-keyboard-section
        tabIndex={-1}
      >
        <Menu open={workspaceMenuOpen} onOpenChange={setWorkspaceMenuOpen}>
          <MenuTrigger
            className="workspace-switcher-trigger mt-2 mb-3 shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            title={t("workspace.switch")}
            aria-label={t("workspace.switch")}
            data-peek-visible={workspaceMenuOpen}
            delay={300}
            openOnHover
          >
            <span aria-hidden="true" className="workspace-switcher-layer workspace-switcher-layer-back" />
            <span aria-hidden="true" className="workspace-switcher-layer workspace-switcher-layer-mid" />
            <GeneratedAvatar
              className="workspace-avatar-ring relative rounded-md"
              id={activeWorkspace?.id || serverSlug}
              initials
              name={activeWorkspace?.name || serverSlug}
              size="message"
            />
          </MenuTrigger>
          <MenuPopup
            align="start"
            className="workspace-switcher-menu max-h-72 w-64"
            side="right"
            sideOffset={10}
          >
            {workspaces.map((workspace) => (
              <MenuItem
                key={workspace.id}
                className={workspace.slug === serverSlug ? "bg-accent font-medium" : undefined}
                onClick={() => {
                  if (workspace.slug !== serverSlug) navigate(`/s/${workspace.slug}`);
                }}
                onFocus={() => router.prefetch(`/s/${workspace.slug}`)}
                onPointerEnter={() => router.prefetch(`/s/${workspace.slug}`)}
              >
                <GeneratedAvatar
                  className="rounded-md"
                  id={workspace.id}
                  initials
                  name={workspace.name}
                  size="message"
                />
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                {workspace.slug === serverSlug && (
                  <CheckIcon className="ml-auto size-3.5 shrink-0" strokeWidth={2.5} />
                )}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onClick={() => setShowCreate(true)}>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground">
                <PlusIcon className="size-4" />
              </span>
              <span>{t("workspace.create")}</span>
            </MenuItem>
          </MenuPopup>
        </Menu>

        <div ref={tabsRegionRef} className="min-h-0 w-full flex-1 overflow-hidden">
          <div
            aria-label={t("nav.workspace")}
            aria-orientation="vertical"
            className="flex flex-col items-center"
            role="tablist"
          >
            {visibleAreas.map((area, index) => (
              <div
                className={area.id === "settings" && index > 0 ? "workspace-rail-settings-separator" : undefined}
                key={area.id}
                role="presentation"
              >
                {renderArea(area)}
              </div>
            ))}
            {overflowAreas.length > 0 && (
              <Menu>
                <MenuTrigger
                  ref={(node) => {
                    if (node instanceof HTMLButtonElement) tabRefs.current.set("more", node);
                    else tabRefs.current.delete("more");
                  }}
                  aria-label={t("nav.more")}
                  aria-current={currentIsOverflowed ? "page" : undefined}
                  aria-selected={currentIsOverflowed}
                  className="workspace-rail-tab"
                  data-active={currentIsOverflowed}
                  delay={300}
                  onKeyDown={(event) => handleTabKeyDown(event, "more")}
                  openOnHover
                  role="tab"
                  tabIndex={focusableId === "more" ? 0 : -1}
                  title={t("nav.more")}
                >
                  <span className="workspace-rail-tab-icon">
                    <WorkspaceRailIcon className="workspace-rail-tab-glyph" glyph="more" />
                  </span>
                  <span className="workspace-rail-tab-label">{t("nav.more")}</span>
                </MenuTrigger>
                <MenuPopup
                  align="start"
                  className="workspace-rail-peek-menu w-52"
                  side="right"
                  sideOffset={8}
                >
                  {overflowAreas.map((area) => {
                    const active = current === area.id;
                    return (
                      <MenuItem
                        className={active ? "bg-accent font-semibold" : undefined}
                        key={area.id}
                        onClick={() => {
                          const href = `/s/${serverSlug}${area.path}`;
                          if (pathname !== href) navigate(href);
                        }}
                        onFocus={() => router.prefetch(`/s/${serverSlug}${area.path}`)}
                        onPointerEnter={() => router.prefetch(`/s/${serverSlug}${area.path}`)}
                      >
                        <WorkspaceRailIcon active={active} glyph={area.glyph} />
                        <span>{t(area.label)}</span>
                        {active && <CheckIcon className="ml-auto" strokeWidth={2.5} />}
                      </MenuItem>
                    );
                  })}
                </MenuPopup>
              </Menu>
            )}
          </div>
        </div>

        {/* Slack's control strip: round 36px buttons, 52px apart, the account
            last. These are actions on the workspace, not places inside it. */}
        <div className="flex shrink-0 flex-col items-center gap-4 pb-6 pt-2">
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            title={t("workspace.create")}
            aria-label={t("workspace.create")}
            aria-expanded={showCreate}
            className="workspace-rail-control workspace-rail-create"
            data-open={showCreate}
          >
            <PlusIcon className="size-4" strokeWidth={2.2} />
          </button>
          {/* Your own face is the obvious way in to your own settings, so it is
              the control rather than a decoration beside one. */}
          <button
            type="button"
            onClick={() => navigate(`/s/${serverSlug}/settings?section=profile`)}
            title={account.name ? `${account.name} · ${t("settings.navProfile")}` : t("settings.navProfile")}
            aria-label={t("settings.navProfile")}
            className="workspace-rail-account focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <GeneratedAvatar
              avatarUrl={account.avatarUrl}
              className="workspace-avatar-ring rounded-md"
              id={account.id}
              name={account.name}
              size="message"
            />
          </button>
        </div>
      </nav>

      <CreateServerDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </>
  );
}
