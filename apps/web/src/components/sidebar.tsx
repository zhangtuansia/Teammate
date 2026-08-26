"use client";

import { useEffect, useLayoutEffect, useMemo, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useParams, usePathname, useSearchParams } from "next/navigation";
import { CreateAgentDialog } from "./create-agent-dialog";
import { CreateChannelDialog } from "./create-channel-dialog";
import { EditChannelDialog } from "./edit-channel-dialog";
import { ContextMenu } from "./context-menu";
import { useAgentActivity } from "@/hooks/use-agent-activity";
import { useAppSettings, type TranslationKey } from "@/hooks/use-app-settings";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { BrainIcon, CodeIcon, GlobeIcon, SparklesIcon, TrendingUpIcon } from "lucide-react";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, PencilIcon, LogOutIcon, SettingsIcon, UserPlusIcon, UserIcon, UsersIcon, FileTextIcon, ListChecksIcon, CircleIcon, Clock3Icon, ScanEyeIcon, CheckCircle2Icon, BotIcon, MessageSquareIcon, SearchIcon, FolderIcon, FolderPlusIcon, PinIcon, WrenchIcon } from "lucide-react";
import { GeneratedAvatar } from "./generated-avatar";
import { useWorkspaceNavigation } from "@/hooks/use-navigation-guard";
import { withRequestDeadline } from "@/lib/request-deadline";
import { createTrailingRefreshScheduler } from "@/lib/trailing-refresh";
import { afterPaint } from "@/lib/after-paint";
import { parseMessageTime } from "@/lib/message-time";
import { InlineRename } from "./inline-rename";
import { filesFromDrop } from "@/lib/folder-import";
import { importFilesAsDocuments } from "@/lib/import-documents";
import { ancestorPaths, buildDocumentTree, folderLabel, type DocumentFolder } from "@/lib/document-tree";
import { CONNECTOR_CATEGORIES } from "@/lib/connector-catalog";

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

/**
 * Documents in the order they were last touched, cut into the buckets a person
 * actually thinks in. Empty buckets are dropped so a young workspace does not
 * show a column of headings with nothing under them.
 */
function groupDocumentsByAge(
  documents: WorkspaceDocument[],
  t: (key: TranslationKey) => string,
) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeek = startOfToday - 7 * 24 * 60 * 60 * 1000;

  const buckets: Array<{ label: string; documents: WorkspaceDocument[] }> = [
    { documents: [], label: t("documents.groupToday") },
    { documents: [], label: t("documents.groupYesterday") },
    { documents: [], label: t("documents.groupWeek") },
    { documents: [], label: t("documents.groupOlder") },
  ];

  for (const document of documents) {
    const at = parseMessageTime(document.updated_at)?.getTime();
    const index = at === undefined
      ? 3
      : at >= startOfToday
        ? 0
        : at >= startOfYesterday
          ? 1
          : at >= startOfWeek
            ? 2
            : 3;
    buckets[index].documents.push(document);
  }

  return buckets.filter((bucket) => bucket.documents.length > 0);
}

interface WorkspaceDocument {
  id: string;
  title: string;
  folder_path: string;
  pinned_at: string | null;
  updated_at: string;
}

/** Indent per level. Deep trees still leave room for the name to be read. */
const TREE_INDENT = 12;

function DocumentRow({
  active,
  depth,
  document,
  editing,
  onDelete,
  onEdit,
  onOpen,
  onRename,
  onTogglePin,
  t,
}: {
  active: boolean;
  depth: number;
  document: WorkspaceDocument;
  editing: boolean;
  onDelete: (document: WorkspaceDocument) => void;
  onEdit: (key: string | null) => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (document: WorkspaceDocument) => void;
  t: (key: TranslationKey) => string;
}) {
  const pinned = Boolean(document.pinned_at);
  const indent = 10 + depth * TREE_INDENT;
  const [dragging, setDragging] = useState(false);

  if (editing) {
    return (
      <div className="flex h-8 w-full items-center rounded-[6px] bg-accent/60">
        <FileTextIcon
          className="size-4 shrink-0 opacity-60"
          style={{ marginLeft: indent, marginRight: 8 }}
        />
        <InlineRename
          className="h-6 min-w-0 flex-1 rounded-[4px] bg-background px-1.5 text-[13px] outline-none shadow-[0_0_0_1px_var(--border)]"
          onCancel={() => onEdit(null)}
          onCommit={(next) => {
            onEdit(null);
            onRename(document.id, next);
          }}
          value={document.title || ""}
        />
        <span className="w-1.5 shrink-0" />
      </div>
    );
  }

  return (
    <ContextMenu
      className="w-full"
      items={[
        { label: t("documents.rename"), onClick: () => onEdit(`document:${document.id}`) },
        {
          label: pinned ? t("documents.unpin") : t("documents.pin"),
          onClick: () => onTogglePin(document),
        },
        { danger: true, label: t("documents.delete"), onClick: () => onDelete(document) },
      ]}
    >
      <div
        // The row is what gets dragged; a folder row is what catches it. It
        // fades while in flight, so the thing under the cursor is clearly the
        // one that will land somewhere.
        className={`group/doc relative flex h-8 w-full items-center rounded-[6px] transition-[background-color,opacity] duration-150 ${
          active ? "bg-primary/10" : "hover:bg-accent/60"
        } ${dragging ? "opacity-40" : ""}`}
        draggable
        onDragEnd={() => setDragging(false)}
        onDragStart={(event) => {
          event.dataTransfer.setData("text/x-teammate-document", document.id);
          event.dataTransfer.effectAllowed = "move";
          setDragging(true);
        }}
      >
        <button
          aria-current={active ? "page" : undefined}
          className={`flex h-8 min-w-0 flex-1 items-center gap-2 pr-1 text-left text-[13px] ${
            active ? "font-medium text-primary" : "text-muted-foreground"
          }`}
          onClick={() => onOpen(document.id)}
          style={{ paddingLeft: indent }}
          type="button"
        >
          <FileTextIcon className={`size-4 shrink-0 ${active ? "" : "opacity-60"}`} />
          <span className="truncate">{document.title || t("documents.untitled")}</span>
        </button>
        {/* A pin stays visible once set; otherwise it waits to be reached for. */}
        <button
          aria-label={pinned ? t("documents.unpin") : t("documents.pin")}
          aria-pressed={pinned}
          className={`mr-1.5 flex size-5 shrink-0 items-center justify-center rounded transition-opacity hover:bg-accent ${
            pinned ? "text-primary opacity-100" : "opacity-0 group-hover/doc:opacity-60"
          }`}
          onClick={() => onTogglePin(document)}
          title={pinned ? t("documents.unpin") : t("documents.pin")}
          type="button"
        >
          <PinIcon className={`size-3.5 ${pinned ? "fill-current" : ""}`} />
        </button>
      </div>
    </ContextMenu>
  );
}

function DocumentFolderRow({
  activeDocumentId,
  editingKey,
  folder,
  onCreateIn,
  onDeleteDocument,
  onEdit,
  onImportInto,
  onMoveDocument,
  onOpenDocument,
  onRenameDocument,
  onRenameFolder,
  onToggle,
  onTogglePin,
  openFolders,
  t,
}: {
  activeDocumentId: string | null;
  editingKey: string | null;
  folder: DocumentFolder<WorkspaceDocument>;
  onCreateIn: (path: string) => void;
  onDeleteDocument: (document: WorkspaceDocument) => void;
  onEdit: (key: string | null) => void;
  onImportInto: (path: string, files: Promise<File[]>) => void;
  onMoveDocument: (documentId: string, folder: string) => void;
  onOpenDocument: (id: string) => void;
  onRenameDocument: (id: string, title: string) => void;
  onRenameFolder: (path: string, name: string) => void;
  onToggle: (path: string) => void;
  onTogglePin: (document: WorkspaceDocument) => void;
  openFolders: Set<string>;
  t: (key: TranslationKey) => string;
}) {
  const open = openFolders.has(folder.path);
  const [dropTarget, setDropTarget] = useState(false);
  const indent = 4 + folder.depth * TREE_INDENT;

  if (editingKey === `folder:${folder.path}`) {
    return (
      <div className="flex h-8 w-full items-center rounded-[6px] bg-accent/60">
        <FolderIcon
          className="size-4 shrink-0 text-primary/70"
          style={{ marginLeft: indent + 18, marginRight: 8 }}
        />
        <InlineRename
          className="h-6 min-w-0 flex-1 rounded-[4px] bg-background px-1.5 text-[13px] outline-none shadow-[0_0_0_1px_var(--border)]"
          onCancel={() => onEdit(null)}
          onCommit={(next) => {
            onEdit(null);
            onRenameFolder(folder.path, next);
          }}
          value={folder.name}
        />
        <span className="w-2 shrink-0" />
      </div>
    );
  }

  const row = (
    <>
      <button
        aria-expanded={open}
        className={`group/folder flex h-8 w-full items-center gap-1 rounded-[6px] pr-2 text-left text-[13px] transition-colors ${
          dropTarget ? "bg-primary/15 text-primary" : "text-foreground/80 hover:bg-accent/60"
        }`}
        onClick={() => onToggle(folder.path)}
        onDragLeave={() => setDropTarget(false)}
        onDragOver={(event) => {
          const { types } = event.dataTransfer;
          // A document being filed, or notes arriving from the disk.
          if (!types.includes("text/x-teammate-document") && !types.includes("Files")) return;
          // Without this the browser refuses the drop and nothing can land.
          event.preventDefault();
          event.dataTransfer.dropEffect = types.includes("Files") ? "copy" : "move";
          setDropTarget(true);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDropTarget(false);
          const id = event.dataTransfer.getData("text/x-teammate-document");
          if (id) {
            onMoveDocument(id, folder.path);
            return;
          }
          // Walking a dropped folder is asynchronous, and the items go stale
          // the moment this handler returns — so it starts here, not later.
          if (event.dataTransfer.types.includes("Files")) {
            onImportInto(folder.path, filesFromDrop(event.dataTransfer));
          }
        }}
        style={{ paddingLeft: indent }}
        type="button"
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <FolderIcon className="size-4 shrink-0 text-primary/70" />
        <span className="truncate">{folder.name}</span>
        {/* What is inside, so a closed folder is not a dead end. It steps out of
            the way on hover, where the name may need the room. */}
        <span className="ml-auto shrink-0 pl-1 text-[11px] tabular-nums text-muted-foreground group-hover/folder:opacity-0">
          {folder.totalDocuments}
        </span>
      </button>
      {/* Opening a folder should look like it opened, not like the rows were
          always there. A `0fr`→`1fr` row is the one way to animate to a height
          nobody has measured; it stays mounted so the close animates too. */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="flex min-h-0 flex-col gap-0.5 overflow-hidden">
          {folder.folders.map((child) => (
            <DocumentFolderRow
              activeDocumentId={activeDocumentId}
              editingKey={editingKey}
              folder={child}
              key={child.path}
              onCreateIn={onCreateIn}
              onDeleteDocument={onDeleteDocument}
              onEdit={onEdit}
              onImportInto={onImportInto}
              onMoveDocument={onMoveDocument}
              onOpenDocument={onOpenDocument}
              onRenameDocument={onRenameDocument}
              onRenameFolder={onRenameFolder}
              onToggle={onToggle}
              onTogglePin={onTogglePin}
              openFolders={openFolders}
              t={t}
            />
          ))}
          {folder.documents.map((document) => (
            <DocumentRow
              active={activeDocumentId === document.id}
              depth={folder.depth + 1}
              document={document}
              editing={editingKey === `document:${document.id}`}
              key={document.id}
              onDelete={onDeleteDocument}
              onEdit={onEdit}
              onOpen={onOpenDocument}
              onRename={onRenameDocument}
              onTogglePin={onTogglePin}
              t={t}
            />
          ))}
        </div>
      </div>
    </>
  );

  return (
    <ContextMenu
      className="w-full"
      items={[
        { label: t("documents.rename"), onClick: () => onEdit(`folder:${folder.path}`) },
        { label: t("documents.newInFolder"), onClick: () => onCreateIn(folder.path) },
      ]}
    >
      <div className="flex w-full flex-col gap-0.5">{row}</div>
    </ContextMenu>
  );
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
/**
 * One glyph per category. The list carried the same connector icon on every
 * row before, which is the sort of decoration that costs a column of space and
 * tells you nothing — six identical marks read as noise, not as a set. The task
 * filters below already work this way.
 */
const APP_CATEGORY_ICONS: Record<string, typeof SparklesIcon> = {
  dev: CodeIcon,
  featured: SparklesIcon,
  finance: TrendingUpIcon,
  team: UsersIcon,
  thinking: BrainIcon,
  web: GlobeIcon,
};

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
}: {
  serverSlug: string;
  serverId: string;
}) {
  const [dmChannels, setDmChannels] = useState<DmChannel[]>([]);
  const [groupChannels, setGroupChannels] = useState<Channel[]>([]);
  const [documents, setDocuments] = useState<WorkspaceDocument[]>([]);
  const [documentQuery, setDocumentQuery] = useState("");
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [looseDropTarget, setLooseDropTarget] = useState(false);
  // Which row is being renamed, as "document:<id>" or "folder:<path>".
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [userId, setUserId] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [userName, setUserName] = useState("");
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
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
  const workspaceViewRef = useRef<"home" | "documents" | "tasks" | "apps" | "settings">("home");
  const sidebarRefreshRef = useRef<ReturnType<typeof createTrailingRefreshScheduler> | null>(null);
  const loadRetryAttemptRef = useRef(0);
  const loadRetryTimerRef = useRef<number | null>(null);
  const [loadRetryToken, setLoadRetryToken] = useState(0);
  const [sidebarLoadError, setSidebarLoadError] = useState("");
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
      : pathname.endsWith("/apps")
        ? "apps"
        : pathname.endsWith("/settings")
          ? "settings"
          : "home";
  const activeTaskFilter = searchParams.get("status") || "all";
  const activeAppCategory = searchParams.get("category") || "featured";
  const activeDocumentId = searchParams.get("document");
  const documentSearch = searchParams.get("q") || "";
  // The box holds what you typed; the address holds what has been searched for.
  // When the address moves on its own — the back button, a link — the box
  // follows it. Adjusting during the render is how React would rather hear it
  // than through an effect that renders once with the stale value first.
  const [lastSearchInAddress, setLastSearchInAddress] = useState(documentSearch);
  if (lastSearchInAddress !== documentSearch) {
    setLastSearchInAddress(documentSearch);
    setDocumentQuery(documentSearch);
  }
  // The list narrows as you type. It matches on the title only, where the pane
  // on the right also reads the contents — so the pane can show a document the
  // sidebar does not, which is the right way round for a list of names.
  const visibleDocuments = useMemo(() => {
    const needle = documentQuery.trim().toLowerCase();
    if (!needle) return documents;
    // The folder is part of a document's name here, so a search for "api"
    // finds what is filed under `api/` as well as what is titled that way.
    return documents.filter((document) =>
      `${document.folder_path}/${document.title || ""}`.toLowerCase().includes(needle),
    );
  }, [documentQuery, documents]);
  const documentTree = useMemo(() => buildDocumentTree(visibleDocuments), [visibleDocuments]);

  const toggleFolder = useCallback((path: string) => {
    setOpenFolders((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  /**
   * The row moves first and the write follows. Waiting for the round trip and
   * then for the realtime echo puts a visible pause between letting go of a
   * document and seeing it land, which reads as the app thinking about it —
   * and it has nothing to think about, since the answer is already known.
   *
   * If the write fails the row goes back where it was and the error is shown.
   */
  const applyDocumentChange = useCallback(
    async (id: string, patch: Partial<WorkspaceDocument>) => {
      setDocumentActionError("");
      let previous: WorkspaceDocument | undefined;
      setDocuments((current) =>
        current.map((document) => {
          if (document.id !== id) return document;
          previous = document;
          return { ...document, ...patch };
        }),
      );
      const { error } = await supabase.from("documents").update(patch).eq("id", id);
      if (!error) return;
      setDocumentActionError(error.message);
      const restore = previous;
      if (restore) {
        setDocuments((current) =>
          current.map((document) => (document.id === id ? restore : document)),
        );
      }
    },
    [supabase],
  );

  const togglePin = useCallback(
    (document: WorkspaceDocument) => {
      void applyDocumentChange(document.id, {
        pinned_at: document.pinned_at ? null : new Date().toISOString(),
      });
    },
    [applyDocumentChange],
  );

  const moveDocument = useCallback(
    (id: string, folder: string) => {
      const document = documents.find((entry) => entry.id === id);
      if (!document || document.folder_path === folder) return;
      void applyDocumentChange(id, { folder_path: folder });
      if (folder) setOpenFolders((current) => new Set([...current, ...ancestorPaths(folder)]));
    },
    [applyDocumentChange, documents],
  );

  const renameFolder = useCallback(
    (path: string, name: string) => {
      const current = folderLabel(path);
      // A slash would silently reshape the tree; a rename should rename.
      if (!name || name === current || name.includes("/")) return;
      const parent = path.slice(0, Math.max(0, path.length - current.length - 1));
      const next = parent ? `${parent}/${name}` : name;
      // Everything filed under here moves with it, however deep.
      for (const document of documents) {
        if (document.folder_path !== path && !document.folder_path.startsWith(`${path}/`)) continue;
        void applyDocumentChange(document.id, {
          folder_path: next + document.folder_path.slice(path.length),
        });
      }
      setOpenFolders((open) => new Set([...open, ...ancestorPaths(next)]));
    },
    [applyDocumentChange, documents],
  );

  const renameDocument = useCallback(
    (id: string, title: string) => {
      if (title) void applyDocumentChange(id, { title });
    },
    [applyDocumentChange],
  );

  const deleteDocument = useCallback(
    async (document: WorkspaceDocument) => {
      setDocumentActionError("");
      // Gone from the list at once; a document you deleted should not sit there
      // while the write travels.
      setDocuments((current) => current.filter((entry) => entry.id !== document.id));
      const { error } = await supabase.from("documents").delete().eq("id", document.id);
      if (error) {
        setDocumentActionError(error.message);
        setDocuments((current) => [document, ...current]);
        return;
      }
      if (activeDocumentId === document.id) navigate(`/s/${serverSlug}/documents`);
    },
    [activeDocumentId, navigate, serverSlug, supabase],
  );

  /**
   * A folder holds documents and nothing else, so making one means making its
   * first document in it. The name is typed in the tree where the folder will
   * appear, rather than in a box over the top of it.
   *
   * Not memoised: it calls handleCreateDocument, which is redeclared each
   * render and closes over the signed-in user. Holding the first render's copy
   * would mean holding the empty user id it had before anyone had loaded.
   */
  function createInFolder(path: string) {
    setOpenFolders((current) => new Set([...current, ...ancestorPaths(path)]));
    void handleCreateDocument(path);
  }

  /** Notes dropped from the disk onto a folder land in that folder. */
  function importInto(path: string, pending: Promise<File[]>) {
    setDocumentActionError("");
    void (async () => {
      const files = await pending;
      const outcome = await importFilesAsDocuments({
        client: supabase as unknown as Parameters<typeof importFilesAsDocuments>[0]["client"],
        files,
        intoFolder: path,
        serverId,
      });
      if (outcome.error) {
        setDocumentActionError(t("documents.importFailed"));
        return;
      }
      if (outcome.added === 0) {
        setDocumentActionError(t("documents.importNothing"));
        return;
      }
      if (path) setOpenFolders((current) => new Set([...current, ...ancestorPaths(path)]));
      void loadData();
    })();
  }

  const openDocument = useCallback(
    (id: string) => {
      navigate(
        `/s/${serverSlug}/documents?document=${id}${
          documentSearch ? `&q=${encodeURIComponent(documentSearch)}` : ""
        }`,
      );
    },
    [documentSearch, navigate, serverSlug],
  );

  // Searching digs through folders, so it opens them: a match three levels down
  // that stays behind a closed folder has not really been found.
  const foldersWithMatches = documentQuery.trim()
    ? visibleDocuments.flatMap((document) => ancestorPaths(document.folder_path || "")).join("\u0000")
    : "";
  const [lastFoldersWithMatches, setLastFoldersWithMatches] = useState(foldersWithMatches);
  if (lastFoldersWithMatches !== foldersWithMatches) {
    setLastFoldersWithMatches(foldersWithMatches);
    if (foldersWithMatches) {
      setOpenFolders((current) => new Set([...current, ...foldersWithMatches.split("\u0000")]));
    }
  }

  // Opening a document from anywhere reveals where it lives.
  const activeDocumentPath =
    documents.find((document) => document.id === activeDocumentId)?.folder_path || "";
  const [lastActivePath, setLastActivePath] = useState(activeDocumentPath);
  if (lastActivePath !== activeDocumentPath) {
    setLastActivePath(activeDocumentPath);
    if (activeDocumentPath) {
      setOpenFolders((current) => new Set([...current, ...ancestorPaths(activeDocumentPath)]));
    }
  }
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
          .from("documents")
          .select("id, title, folder_path, pinned_at, updated_at")
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
  useEffect(
    () => afterPaint(() => void refreshSidebarNow()),
    [loadRetryToken, refreshSidebarNow, workspaceView],
  );

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

  // The box is here but the documents pane does the searching, so the query
  // travels in the URL — the one piece of state both sides already share. It
  // settles first: a query per keystroke would be a round trip per keystroke.
  useEffect(() => {
    if (workspaceView !== "documents") return;
    const timer = window.setTimeout(() => {
      const wanted = documentQuery.trim();
      if (wanted === documentSearch) return;
      const params = new URLSearchParams(searchParams.toString());
      if (wanted) params.set("q", wanted);
      else params.delete("q");
      const query = params.toString();
      router.replace(`${pathname}${query ? `?${query}` : ""}`);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [documentQuery, documentSearch, pathname, router, searchParams, workspaceView]);

  async function handleCreateDocument(folder = "") {
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
          folder_path: folder,
          format: "markdown",
          created_by: userId,
        })
        .select("id, title, folder_path, pinned_at, updated_at")
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
      className="desktop-sidebar relative flex h-full shrink-0 flex-col bg-rail/10"
      style={{ width: `var(${SIDEBAR_WIDTH_CSS_PROPERTY}, ${DEFAULT_SIDEBAR_WIDTH}px)` }}
    >
      <div className="flex-1 overflow-y-auto px-2 pt-3 pb-2 space-y-4">
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
            {/* Search sits over the list it searches, rather than in the header
                of the pane on the other side of the window. */}
            <div className="relative px-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                aria-label={t("documents.searchPlaceholder")}
                className="h-8 w-full rounded-lg bg-accent/70 pl-8 pr-2 text-[13px] outline-none placeholder:text-muted-foreground focus:bg-card focus:shadow-[0_0_0_1px_var(--border)]"
                onChange={(event) => setDocumentQuery(event.target.value)}
                placeholder={t("documents.searchPlaceholder")}
                type="text"
                value={documentQuery}
              />
            </div>
            <div className="flex h-[22px] items-center justify-between px-2">
              <span className="text-[12px] font-medium text-muted-foreground">
                {t("documents.title")}
              </span>
              <div className="flex items-center">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setNewFolder(true)}
                  title={t("documents.newFolder")}
                  aria-label={t("documents.newFolder")}
                >
                  <FolderPlusIcon />
                </Button>
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
            </div>
            {visibleDocuments.length === 0 ? (
              <p className="px-2 pt-2 text-xs leading-relaxed text-muted-foreground">
                {documentQuery.trim() ? t("documents.noMatches") : t("documents.sidebarEmpty")}
              </p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {/* Whatever you pinned, above everything and out of any folder.
                    A pinned document is still filed where it was — this is a
                    second way to reach it, not a place it moved to. */}
                {documentTree.pinned.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    <span className="px-2 pt-1 text-[11px] font-medium text-muted-foreground/70">
                      {t("documents.groupPinned")}
                    </span>
                    {documentTree.pinned.map((document) => (
                      <DocumentRow
                        active={activeDocumentId === document.id}
                        depth={0}
                        document={document}
                        editing={editingKey === `document:${document.id}`}
                        key={`pinned-${document.id}`}
                        onDelete={deleteDocument}
                        onEdit={setEditingKey}
                        onOpen={openDocument}
                        onRename={renameDocument}
                        onTogglePin={togglePin}
                        t={t}
                      />
                    ))}
                  </div>
                )}
                {/* Folders next, as a tree you can walk. A document that came
                    from a folder on disk belongs in that folder here too. */}
                {/* A folder being named appears where it will live, so you can
                    see what you are naming it next to. */}
                {newFolder && (
                  <div className="flex h-8 w-full items-center rounded-[6px] bg-accent/60">
                    <FolderIcon className="ml-[22px] mr-2 size-4 shrink-0 text-primary/70" />
                    <InlineRename
                      className="h-6 min-w-0 flex-1 rounded-[4px] bg-background px-1.5 text-[13px] outline-none shadow-[0_0_0_1px_var(--border)]"
                      onCancel={() => setNewFolder(false)}
                      onCommit={(name) => {
                        setNewFolder(false);
                        if (!name.includes("/")) createInFolder(name);
                      }}
                      value={t("documents.newFolder")}
                    />
                    <span className="w-2 shrink-0" />
                  </div>
                )}
                {documentTree.folders.map((folder) => (
                  <DocumentFolderRow
                    activeDocumentId={activeDocumentId}
                    editingKey={editingKey}
                    folder={folder}
                    key={folder.path}
                    onCreateIn={createInFolder}
                    onDeleteDocument={deleteDocument}
                    onEdit={setEditingKey}
                    onImportInto={importInto}
                    onMoveDocument={moveDocument}
                    onOpenDocument={openDocument}
                    onRenameDocument={renameDocument}
                    onRenameFolder={renameFolder}
                    onToggle={toggleFolder}
                    onTogglePin={togglePin}
                    openFolders={openFolders}
                    t={t}
                  />
                ))}
                {/* Then whatever is filed nowhere, still cut into the buckets a
                    person thinks in — a flat list by date tells you nothing
                    about which documents are live work. */}
                {/* Dropping out here is how a document leaves a folder — every
                    folder is a target, so the workspace itself has to be one. */}
                <div
                  className={`flex flex-col gap-0.5 rounded-[6px] transition-colors ${
                    looseDropTarget ? "bg-primary/10" : ""
                  }`}
                  onDragLeave={() => setLooseDropTarget(false)}
                  onDragOver={(event) => {
                    const { types } = event.dataTransfer;
                    if (!types.includes("text/x-teammate-document") && !types.includes("Files")) {
                      return;
                    }
                    event.preventDefault();
                    event.dataTransfer.dropEffect = types.includes("Files") ? "copy" : "move";
                    setLooseDropTarget(true);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setLooseDropTarget(false);
                    const id = event.dataTransfer.getData("text/x-teammate-document");
                    if (id) {
                      moveDocument(id, "");
                      return;
                    }
                    if (event.dataTransfer.types.includes("Files")) {
                      importInto("", filesFromDrop(event.dataTransfer));
                    }
                  }}
                >
                  {groupDocumentsByAge(documentTree.loose, t).map((group) => (
                    <div className="flex flex-col gap-0.5" key={group.label}>
                      <span className="px-2 pt-2 text-[11px] font-medium text-muted-foreground/70">
                        {group.label}
                      </span>
                      {group.documents.map((document) => (
                        <DocumentRow
                          active={activeDocumentId === document.id}
                          depth={0}
                          document={document}
                          editing={editingKey === `document:${document.id}`}
                          key={document.id}
                          onDelete={deleteDocument}
                          onEdit={setEditingKey}
                          onOpen={openDocument}
                          onRename={renameDocument}
                          onTogglePin={togglePin}
                          t={t}
                        />
                      ))}
                    </div>
                  ))}
                  {/* With everything filed away there is nothing left to drop
                      onto, so the target says it is there. */}
                  {documentTree.loose.length === 0 && (
                    <p className="px-2 py-3 text-[11px] text-muted-foreground/60">
                      {t("documents.dropToUnfile")}
                    </p>
                  )}
                </div>
              </div>
            )}
            {documentActionError && (
              <p className="px-2 text-xs leading-relaxed text-destructive" role="alert">
                {documentActionError}
              </p>
            )}
          </div>
        )}

        {workspaceView === "apps" && (
          <div className="space-y-3">
            <div className="flex h-[26px] items-center px-2">
              <span className="text-[15px] font-bold text-foreground">
                {t("apps.title")}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {CONNECTOR_CATEGORIES.map((category) => {
                const active = activeAppCategory === category.id;
                const Icon = APP_CATEGORY_ICONS[category.id];
                return (
                  <Button
                    key={category.id}
                    variant="ghost"
                    size="sm"
                    className={`w-full justify-start ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "text-foreground/80"
                    }`}
                    onClick={() => navigate(
                      category.id === "featured"
                        ? `/s/${serverSlug}/apps`
                        : `/s/${serverSlug}/apps?category=${category.id}`,
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon />
                    {category.label}
                  </Button>
                );
              })}
            </div>
          </div>
        )}

        {workspaceView === "tasks" && (
          <div className="space-y-3">
            <div className="flex h-[26px] items-center px-2">
              <span className="text-[15px] font-bold text-foreground">
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
                    className={`w-full justify-start ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "text-foreground/80"
                    }`}
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
            <div className="flex h-[26px] items-center px-2">
              <span className="text-[15px] font-bold text-foreground">
                {t("settings.title")}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {[
                { id: "profile", label: t("settings.navProfile"), icon: UserIcon },
                { id: "workspace", label: t("settings.navWorkspace"), icon: UsersIcon },
                { id: "general", label: t("settings.navGeneral"), icon: SettingsIcon },
                { id: "models", label: t("settings.navModels"), icon: BotIcon },
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
                    className={`w-full justify-start ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "text-foreground/80"
                    }`}
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
