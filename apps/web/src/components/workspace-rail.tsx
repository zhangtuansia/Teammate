"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { CheckIcon, FileTextIcon, HomeIcon, ListChecksIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAppSettings, type TranslationKey } from "@/hooks/use-app-settings";
import { useWorkspaceNavigation } from "@/hooks/use-navigation-guard";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { CreateServerDialog } from "./create-server-dialog";
import { GeneratedAvatar } from "./generated-avatar";

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
 * The measurements come from Slack's own rail rather than from looking at it:
 * 70px wide, a 36px workspace avatar up top, 52×68 tabs under it whose icon sits
 * in a 36px rounded box, and an 11px bold label. The column paints no background
 * of its own — the app's base surface shows through, and the panels to its right
 * are the ones that lift off it. Selection is only ever that icon box filling
 * in; the label does not change colour or weight, which is what keeps a column
 * of six of them from looking like a row of competing buttons.
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
  icon: typeof HomeIcon;
  id: string;
  label: TranslationKey;
  /** Appended to the workspace root, so home is the root itself. */
  path: string;
}

const AREAS: Area[] = [
  { icon: HomeIcon, id: "home", label: "nav.home", path: "" },
  { icon: FileTextIcon, id: "documents", label: "nav.documents", path: "/documents" },
  { icon: ListChecksIcon, id: "tasks", label: "nav.tasks", path: "/tasks" },
];

// Settings is not a place you work, so it sits apart from the three that are —
// the same separation Slack gives the admin tab.
const SETTINGS: Area = {
  icon: SettingsIcon,
  id: "settings",
  label: "nav.settings",
  path: "/settings",
};

export function WorkspaceRail({ serverSlug }: { serverSlug: string }) {
  const pathname = usePathname();
  const { navigate } = useWorkspaceNavigation();
  const { t } = useAppSettings();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [account, setAccount] = useState<{ avatarUrl: string | null; id: string; name: string }>({
    avatarUrl: null,
    id: "",
    name: "",
  });

  useEffect(() => {
    let cancelled = false;
    async function loadWorkspaces() {
      const supabase = createClient();
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
    const client = createClient();
    const subscription = client
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
      client.removeChannel(subscription);
    };
    // Creating a workspace lands you in it, so keying on the slug is also what
    // picks up the new one.
  }, [serverSlug]);

  // Hosted workspaces have no documents or tasks to switch between, and their
  // settings live under the account menu instead.
  if (process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_MODE !== "true") return null;

  const current = pathname.endsWith("/documents")
    ? "documents"
    : pathname.endsWith("/tasks")
      ? "tasks"
      : pathname.endsWith("/settings")
        ? "settings"
        : "home";

  const activeWorkspace = workspaces.find((workspace) => workspace.slug === serverSlug);

  const renderArea = (area: Area) => {
    const Icon = area.icon;
    const active = current === area.id;
    const label = t(area.label);
    return (
      <button
        key={area.id}
        type="button"
        onClick={() => navigate(`/s/${serverSlug}${area.path}`)}
        title={label}
        aria-current={active ? "page" : undefined}
        className="group flex h-[68px] w-[52px] flex-col items-center gap-1 py-2 text-rail-foreground/85"
      >
        <span
          // Slack runs two alpha ladders and never mixes them: a surface that
          // rests empty goes 6% then 13%, and one that already carries a fill
          // goes 13% then 22% then 28%. A selected tab is the second kind, so
          // pressing it deepens what is there rather than starting over.
          className={`flex size-9 items-center justify-center rounded-md transition-colors ${
            active
              ? "bg-rail-foreground/12 group-hover:bg-rail-foreground/22 group-active:bg-rail-foreground/28"
              : "group-hover:bg-rail-foreground/6 group-active:bg-rail-foreground/13"
          }`}
        >
          <Icon className="size-5" strokeWidth={active ? 2.2 : 1.8} />
        </span>
        <span className="text-[11px] leading-none font-bold">{label}</span>
      </button>
    );
  };

  return (
    <>
      <nav className="flex h-full w-[70px] shrink-0 flex-col items-center" aria-label={t("nav.workspace")}>
        <Menu>
          <MenuTrigger
            className="mt-2 mb-4 shrink-0 rounded-md transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            title={t("workspace.switch")}
            aria-label={t("workspace.switch")}
          >
            <GeneratedAvatar
              className="workspace-avatar-ring rounded-md"
              id={activeWorkspace?.id || serverSlug}
              initials
              name={activeWorkspace?.name || serverSlug}
              size="message"
            />
          </MenuTrigger>
          <MenuPopup align="start" className="max-h-72 w-56">
            {workspaces.map((workspace) => (
              <MenuItem
                key={workspace.id}
                className={workspace.slug === serverSlug ? "bg-accent font-medium" : undefined}
                onClick={() => {
                  if (workspace.slug !== serverSlug) navigate(`/s/${workspace.slug}`);
                }}
              >
                <GeneratedAvatar
                  className="rounded-md"
                  id={workspace.id}
                  initials
                  name={workspace.name}
                  size="xs"
                />
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                {workspace.slug === serverSlug && (
                  <CheckIcon className="ml-auto size-3.5 shrink-0" strokeWidth={2.5} />
                )}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onClick={() => setShowCreate(true)}>
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground">
                <PlusIcon className="size-3" />
              </span>
              <span>{t("workspace.create")}</span>
            </MenuItem>
          </MenuPopup>
        </Menu>

        <div className="flex flex-col items-center">{AREAS.map(renderArea)}</div>
        {/* Slack sets its admin tab off from the areas by a gap rather than by
            sending it to the bottom — the bottom belongs to the控制条 below. */}
        <div className="mt-[21px] flex flex-col items-center">{renderArea(SETTINGS)}</div>

        {/* Slack's control strip: round 36px buttons, 52px apart, the account
            last. These are actions on the workspace, not places inside it. */}
        <div className="mt-auto flex flex-col items-center gap-4 pb-4">
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            title={t("workspace.create")}
            aria-label={t("workspace.create")}
            className="flex size-9 items-center justify-center rounded-full bg-rail-foreground/12 text-rail-foreground transition-colors hover:bg-rail-foreground/22 active:bg-rail-foreground/28"
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
            className="flex rounded-md transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
