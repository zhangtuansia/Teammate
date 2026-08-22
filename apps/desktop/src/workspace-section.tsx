import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FOLDER_IMPORT_FILE_LIMIT, documentTitleFor, planFolderImport } from "@/lib/folder-import";
import { createClient } from "@/lib/supabase/client";
import { withRequestDeadline } from "@/lib/request-deadline";
import { useAppSettings, type TranslationKey } from "@/hooks/use-app-settings";
import { parseMessageTime } from "@/lib/message-time";
import { apiUrl } from "@/lib/api-url";
import { documentPreview } from "@/lib/document-preview";
import { canEditAsRichText } from "@/lib/markdown-round-trip";
import { DocumentEditor } from "@/components/document-editor";
import { ArrowDown, ArrowRight, CheckCircle2, Circle, Clock3, FileText, FolderPlus, ListChecks, Pencil, Plus, RefreshCw, SaveIcon, ScanEye, Search, Trash2Icon, X } from "@/components/ui/settings-icons";
import { SafeMarkdown } from "@/components/ui/safe-markdown";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GeneratedAvatar } from "@/components/generated-avatar";
import { useUnsavedChangesGuard } from "@/hooks/use-navigation-guard";

const WORKSPACE_REQUEST_TIMEOUT_MS = 18_000;

type WorkspaceSectionName = "documents" | "tasks";

interface ChannelRecord {
  id: string;
  name: string;
  type: string;
}

interface TaskRecord {
  id: string;
  message_id: string;
  channel_id: string;
  task_number: number;
  status: "todo" | "in_progress" | "in_review" | "done";
  parent_task_id: string | null;
  assignee_id: string | null;
  assignee_type: "human" | "agent" | null;
  created_at: string;
  updated_at: string;
}

const TASK_STATUSES = ["todo", "in_progress", "in_review", "done"] as const satisfies
  ReadonlyArray<TaskRecord["status"]>;

interface TaskViewModel extends TaskRecord {
  title: string;
  channel: ChannelRecord | null;
  assigneeName: string | null;
  assigneeAvatarUrl: string | null;
  parentTaskNumber: number | null;
}

interface AgentRecord {
  id: string;
  name: string;
  display_name: string;
  avatar_url: string | null;
}

interface ProfileRecord {
  id: string;
  display_name: string;
  avatar_url: string | null;
}

interface MembershipRecord {
  channel_id: string;
  member_id: string;
  member_type: "human" | "agent";
}

interface ServerMembershipRecord {
  member_id: string;
  member_type: "human" | "agent";
}

interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

interface AssigneeOption extends SelectOption {
  id: string | null;
  type: "human" | "agent" | null;
  avatarUrl: string | null;
  mentionName: string | null;
}

interface WorkspaceDocumentRecord {
  id: string;
  server_id: string;
  title: string;
  content: string;
  created_by: string | null;
  generated_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

type WorkspaceDocumentSummaryRecord = Pick<
  WorkspaceDocumentRecord,
  "id" | "server_id" | "title" | "generated_by_agent_id" | "created_at" | "updated_at"
>;

/**
 * When a document was last touched, in the terms the rest of the app uses.
 * "2026/8/22" tells you nothing at a glance about whether this is the thing
 * you were working on ten minutes ago.
 */
function formatDocumentDate(iso: string, t: (key: TranslationKey) => string) {
  const date = parseMessageTime(iso);
  if (!date) return "";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (date.toDateString() === yesterday.toDateString()) return t("message.yesterday");
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** The shape list_workspace_documents returns, before it is renamed. */
interface WorkspaceDocumentSummaryRow extends WorkspaceDocumentSummaryRecord {
  excerpt: string | null;
  content_length: number | null;
  generator_name: string | null;
  generator_avatar_url: string | null;
}

interface WorkspaceDocumentSummaryViewModel extends WorkspaceDocumentSummaryRecord {
  generatorName: string | null;
  generatorAvatarUrl: string | null;
  excerpt: string;
  content_length: number;
}

interface WorkspaceDocumentViewModel extends WorkspaceDocumentRecord {
  generatorName: string | null;
  generatorAvatarUrl: string | null;
}

interface DocumentListSnapshot {
  serverId: string;
  documents: WorkspaceDocumentSummaryViewModel[];
}

interface DocumentDetailSnapshot {
  serverId: string;
  documentId: string;
  document: WorkspaceDocumentViewModel;
}

interface SectionLoadState {
  serverId: string;
  loading: boolean;
  refreshing: boolean;
  error: string;
}

interface TasksSnapshot {
  serverId: string;
  currentUserId: string;
  tasks: TaskViewModel[];
  channels: ChannelRecord[];
  assignees: AssigneeOption[];
  channelMemberships: MembershipRecord[];
}

interface TaskDragSession {
  taskId: string;
  submitted: boolean;
}

const EMPTY_TASKS: TaskViewModel[] = [];
const EMPTY_CHANNELS: ChannelRecord[] = [];
const EMPTY_ASSIGNEES: AssigneeOption[] = [];
const EMPTY_MEMBERSHIPS: MembershipRecord[] = [];

/** Title, owner, created, last updated — the same shape in header and rows. */
const DOCUMENT_COLUMNS = "grid-cols-[1fr_auto_auto_auto]";

function SectionHeader({ title, description, action }: {
  title: string;
  /** Omitted where the title says everything, rather than padded with prose. */
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="relative flex h-16 shrink-0 items-center justify-between gap-4 border-b px-6">
      <div
        className="desktop-native-drag absolute inset-0"
        data-tauri-drag-region
        aria-hidden="true"
      />
      <div className="pointer-events-none relative min-w-0">
        <h1 className="truncate text-[15px] font-semibold">{title}</h1>
        {description && <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="relative">{action}</div>}
    </header>
  );
}

function DocumentsSection({ serverId, serverSlug }: { serverId: string; serverSlug: string }) {
  const { settings, t, updateSettings } = useAppSettings();
  const router = useRouter();
  const searchParams = useSearchParams();
  const documentId = searchParams.get("document");
  const [listSnapshot, setListSnapshot] = useState<DocumentListSnapshot | null>(null);
  const listSnapshotRef = useRef<DocumentListSnapshot | null>(null);
  const [listLoadState, setListLoadState] = useState<SectionLoadState>({
    serverId: "",
    loading: true,
    refreshing: false,
    error: "",
  });
  const [detailSnapshot, setDetailSnapshot] = useState<DocumentDetailSnapshot | null>(null);
  const detailSnapshotRef = useRef<DocumentDetailSnapshot | null>(null);
  const [detailLoadState, setDetailLoadState] = useState<SectionLoadState>({
    serverId: "",
    loading: false,
    refreshing: false,
    error: "",
  });
  const listGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);
  const documentMutationGenerationRef = useRef(0);
  const listRequestControllerRef = useRef<AbortController | null>(null);
  const detailRequestControllerRef = useRef<AbortController | null>(null);
  const documentMutationControllerRef = useRef<AbortController | null>(null);
  const listRefreshTimerRef = useRef<number | null>(null);
  const detailRefreshTimerRef = useRef<number | null>(null);
  const documentIdsRef = useRef<Set<string>>(new Set());
  const selectedDocumentIdRef = useRef<string | null>(documentId);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftUpdatedAt, setDraftUpdatedAt] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  // Typed in the sidebar, carried here in the address — one box, two panes.
  const search = searchParams.get("q") || "";
  const [activeSearch, setActiveSearch] = useState("");
  const searchRef = useRef("");
  const [sort, setSort] = useState<"created_at" | "updated_at">("updated_at");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState("");
  const folderInputRef = useRef<HTMLInputElement>(null);
  const saveTimerRef = useRef<number | null>(null);
  // Decided from what was loaded, not from what is being typed: a document that
  // opened as source stays source for the session rather than switching editors
  // under the author the moment they delete the last table row.
  const [richTextEditable, setRichTextEditable] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");

  const loadDocuments = useCallback(async (quiet = false) => {
    listRequestControllerRef.current?.abort();
    const requestController = new AbortController();
    listRequestControllerRef.current = requestController;
    const timeout = window.setTimeout(
      () => requestController.abort(),
      WORKSPACE_REQUEST_TIMEOUT_MS,
    );
    const generation = listGenerationRef.current + 1;
    listGenerationRef.current = generation;
    const isCurrent = () => listGenerationRef.current === generation;
    const hasCurrentSnapshot = listSnapshotRef.current?.serverId === serverId;
    setListLoadState({
      serverId,
      loading: !quiet || !hasCurrentSnapshot,
      refreshing: quiet && hasCurrentSnapshot,
      error: "",
    });

    const client = createClient();
    try {
      // One statement: the excerpt is cut and the writing agent joined server
      // side, so the list neither pulls whole documents nor makes a second
      // round trip for the directory.
      const { data, error: queryError } = await client
        .rpc("list_workspace_documents", { search: searchRef.current, server_uuid: serverId })
        .abortSignal(requestController.signal);
      if (requestController.signal.aborted) throw new Error("Request aborted");
      if (queryError) throw new Error(queryError.message);
      if (!isCurrent()) return;

      const documents = ((data || []) as WorkspaceDocumentSummaryRow[]).map((document) => ({
        content_length: Number(document.content_length ?? 0),
        created_at: document.created_at,
        excerpt: document.excerpt || "",
        generated_by_agent_id: document.generated_by_agent_id,
        generatorAvatarUrl: document.generator_avatar_url || null,
        generatorName: document.generator_name || null,
        id: document.id,
        server_id: document.server_id,
        title: document.title,
        updated_at: document.updated_at,
      }));
      const nextSnapshot = { serverId, documents };
      documentIdsRef.current = new Set(documents.map((document) => document.id));
      listSnapshotRef.current = nextSnapshot;
      setListSnapshot(nextSnapshot);
      setListLoadState({ serverId, loading: false, refreshing: false, error: "" });
    } catch (loadError) {
      if (listGenerationRef.current !== generation) return;
      setListLoadState({
        serverId,
        loading: false,
        refreshing: false,
        error: requestController.signal.aborted
          ? "Document loading timed out. Refresh and try again."
          : loadError instanceof Error ? loadError.message : String(loadError),
      });
    } finally {
      window.clearTimeout(timeout);
      if (listRequestControllerRef.current === requestController) {
        listRequestControllerRef.current = null;
      }
    }
  }, [serverId]);

  const loadDocument = useCallback(async (nextDocumentId: string, quiet = false) => {
    detailRequestControllerRef.current?.abort();
    const requestController = new AbortController();
    detailRequestControllerRef.current = requestController;
    const timeout = window.setTimeout(
      () => requestController.abort(),
      WORKSPACE_REQUEST_TIMEOUT_MS,
    );
    const generation = detailGenerationRef.current + 1;
    detailGenerationRef.current = generation;
    const isCurrent = () => detailGenerationRef.current === generation;
    const hasCurrentSnapshot = detailSnapshotRef.current?.serverId === serverId &&
      detailSnapshotRef.current.documentId === nextDocumentId;
    setDetailLoadState({
      serverId,
      loading: !quiet || !hasCurrentSnapshot,
      refreshing: quiet && hasCurrentSnapshot,
      error: "",
    });

    const client = createClient();
    try {
      const { data, error: queryError } = await client
        .from("documents")
        .select("id, server_id, title, content, created_by, generated_by_agent_id, created_at, updated_at")
        .eq("id", nextDocumentId)
        .eq("server_id", serverId)
        .abortSignal(requestController.signal)
        .maybeSingle();
      if (requestController.signal.aborted) throw new Error("Request aborted");
      if (queryError) throw new Error(queryError.message);
      if (!data) throw new Error("Document not found");
      if (!isCurrent()) return;

      const record = data as WorkspaceDocumentRecord;
      const generatorResult = record.generated_by_agent_id
        ? await client.rpc("list_workspace_agent_directory", {
            server_uuid: serverId,
          }).abortSignal(requestController.signal)
        : { data: [], error: null };
      if (requestController.signal.aborted) throw new Error("Request aborted");
      if (generatorResult.error) throw new Error(generatorResult.error.message);
      if (!isCurrent()) return;

      const generator = ((generatorResult.data || []) as AgentRecord[]).find(
        (agent) => agent.id === record.generated_by_agent_id,
      );
      const document = {
        ...record,
        generatorName: generator?.display_name || null,
        generatorAvatarUrl: generator?.avatar_url || null,
      };
      const nextSnapshot = { serverId, documentId: nextDocumentId, document };
      detailSnapshotRef.current = nextSnapshot;
      setDetailSnapshot(nextSnapshot);
      setDetailLoadState({ serverId, loading: false, refreshing: false, error: "" });
    } catch (loadError) {
      if (detailGenerationRef.current !== generation) return;
      setDetailLoadState({
        serverId,
        loading: false,
        refreshing: false,
        error: requestController.signal.aborted
          ? "Document loading timed out. Refresh and try again."
          : loadError instanceof Error ? loadError.message : String(loadError),
      });
    } finally {
      window.clearTimeout(timeout);
      if (detailRequestControllerRef.current === requestController) {
        detailRequestControllerRef.current = null;
      }
    }
  }, [serverId]);

  /**
   * Every note in the folder becomes a document. They are copied, not linked:
   * the workspace owns what it holds, and a document that quietly rewrote a
   * file on disk — or went missing when one was renamed — would be a surprise
   * nobody asked for. Importing the same folder twice makes second copies.
   */
  async function handleImportFolder(files: File[]) {
    if (importing || files.length === 0) return;
    const plan = planFolderImport(files);
    if (plan.candidates.length === 0) {
      setImportStatus(t("documents.importNothing"));
      return;
    }
    setImporting(true);
    setImportStatus(t("documents.importReading", { count: String(plan.candidates.length) }));
    try {
      const client = createClient();
      const { data: auth } = await client.auth.getUser();
      if (!auth.user) throw new Error(t("documents.createFailed"));
      const rows = await Promise.all(
        plan.candidates.map(async (candidate) => ({
          content: await candidate.file.text(),
          created_by: auth.user!.id,
          server_id: serverId,
          title: documentTitleFor(candidate.path),
        })),
      );
      const { error: insertError } = await client.from("documents").insert(rows);
      if (insertError) throw new Error(insertError.message);
      setImportStatus(
        plan.skippedOverLimit > 0
          ? t("documents.importedSome", {
              count: String(rows.length),
              limit: String(FOLDER_IMPORT_FILE_LIMIT),
            })
          : t("documents.imported", { count: String(rows.length) }),
      );
      void loadDocuments(true);
    } catch (importError) {
      setImportStatus(
        importError instanceof Error ? importError.message : t("documents.importFailed"),
      );
    } finally {
      setImporting(false);
    }
  }

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const client = createClient();
      const { data: auth } = await client.auth.getUser();
      if (!auth.user) throw new Error(t("documents.createFailed"));
      const { data, error: createError } = await client
        .from("documents")
        .insert({
          content: "",
          created_by: auth.user.id,
          server_id: serverId,
          title: t("documents.untitled"),
        })
        .select("id")
        .single();
      if (createError || !data) throw new Error(createError?.message || t("documents.createFailed"));
      router.push(`/s/${serverSlug}/documents?document=${(data as { id: string }).id}`);
    } catch (createError) {
      setListLoadState({
        error: createError instanceof Error ? createError.message : t("documents.createFailed"),
        loading: false,
        refreshing: false,
        serverId,
      });
    } finally {
      setCreating(false);
    }
  }

  // The address only changes once typing has settled, so this can run on it.
  useEffect(() => {
    searchRef.current = search.trim();
    setActiveSearch(search.trim());
    void loadDocuments(true);
    // loadDocuments is stable per server; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const scheduleDocumentsRefresh = useCallback(() => {
    if (listRefreshTimerRef.current !== null) window.clearTimeout(listRefreshTimerRef.current);
    listRefreshTimerRef.current = window.setTimeout(() => {
      listRefreshTimerRef.current = null;
      void loadDocuments(true);
    }, 140);
  }, [loadDocuments]);

  const scheduleDocumentRefresh = useCallback((nextDocumentId: string) => {
    if (detailRefreshTimerRef.current !== null) window.clearTimeout(detailRefreshTimerRef.current);
    detailRefreshTimerRef.current = window.setTimeout(() => {
      detailRefreshTimerRef.current = null;
      void loadDocument(nextDocumentId, true);
    }, 140);
  }, [loadDocument]);

  useEffect(() => {
    selectedDocumentIdRef.current = documentId;
  }, [documentId]);

  useEffect(() => {
    documentIdsRef.current = new Set();
    const frame = window.requestAnimationFrame(() => void loadDocuments());
    let active = true;
    const client = createClient();
    const subscription = client
      .channel(`workspace-documents:${serverId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "documents",
          filter: `server_id=eq.${serverId}`,
        },
        (payload: {
          new?: Partial<WorkspaceDocumentRecord>;
          old?: Partial<WorkspaceDocumentRecord>;
        }) => {
          if (!active) return;
          const record = payload.new?.id ? payload.new : payload.old;
          if (!record?.id) return;
          const belongsToServer = record.server_id === serverId || (
            !record.server_id && (
              documentIdsRef.current.has(record.id) || record.id === selectedDocumentIdRef.current
            )
          );
          if (!belongsToServer) return;
          scheduleDocumentsRefresh();
          if (record.id === selectedDocumentIdRef.current) scheduleDocumentRefresh(record.id);
        },
      )
      .subscribe((status: string) => {
        if (!active || (status !== "CHANNEL_ERROR" && status !== "TIMED_OUT")) return;
        setListLoadState((current) => current.serverId === serverId
          ? { ...current, refreshing: false, error: "Document updates could not connect. Refresh to try again." }
          : current);
      });
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      listGenerationRef.current += 1;
      listRequestControllerRef.current?.abort();
      listRequestControllerRef.current = null;
      documentMutationControllerRef.current?.abort();
      documentMutationControllerRef.current = null;
      documentMutationGenerationRef.current += 1;
      savingRef.current = false;
      deletingRef.current = false;
      if (listRefreshTimerRef.current !== null) {
        window.clearTimeout(listRefreshTimerRef.current);
        listRefreshTimerRef.current = null;
      }
      if (detailRefreshTimerRef.current !== null) {
        window.clearTimeout(detailRefreshTimerRef.current);
        detailRefreshTimerRef.current = null;
      }
      client.removeChannel(subscription);
    };
  }, [loadDocuments, scheduleDocumentRefresh, scheduleDocumentsRefresh, serverId]);

  useEffect(() => {
    detailGenerationRef.current += 1;
    if (!documentId) {
      if (detailRefreshTimerRef.current !== null) {
        window.clearTimeout(detailRefreshTimerRef.current);
        detailRefreshTimerRef.current = null;
      }
      return;
    }
    const frame = window.requestAnimationFrame(() => void loadDocument(documentId));
    return () => {
      window.cancelAnimationFrame(frame);
      detailGenerationRef.current += 1;
      detailRequestControllerRef.current?.abort();
      detailRequestControllerRef.current = null;
      if (detailRefreshTimerRef.current !== null) {
        window.clearTimeout(detailRefreshTimerRef.current);
        detailRefreshTimerRef.current = null;
      }
    };
  }, [documentId, loadDocument]);

  const currentListSnapshot = listSnapshot?.serverId === serverId ? listSnapshot : null;
  const documents = currentListSnapshot?.documents || [];
  // Which column the table is read by. The list arrives newest-updated first,
  // so that order is the one the server already gives us.
  const sortedDocuments = useMemo(() => {
    if (sort === "updated_at") return documents;
    return [...documents].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [documents, sort]);
  const currentDetailSnapshot = detailSnapshot?.serverId === serverId &&
    detailSnapshot.documentId === documentId
    ? detailSnapshot
    : null;
  const selectedDocument = currentDetailSnapshot?.document || null;
  const currentListLoadState = listLoadState.serverId === serverId ? listLoadState : null;
  const currentDetailLoadState = detailLoadState.serverId === serverId ? detailLoadState : null;
  const listLoading = !currentListSnapshot && (currentListLoadState?.loading ?? true);
  const detailLoading = Boolean(documentId) && !currentDetailSnapshot &&
    (currentDetailLoadState?.loading ?? true);

  const useRichText = richTextEditable && settings.documentEditor !== "source";

  // The context's updater only moves local state; the settings page persists
  // through its own form, so a preference set from here writes itself.
  const chooseDocumentEditor = useCallback(
    (mode: "rich" | "source") => {
      updateSettings?.({ ...settings, documentEditor: mode });
      void fetch(apiUrl("/api/settings"), {
        body: JSON.stringify({ documentEditor: mode }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      }).catch(() => undefined);
    },
    [settings, updateSettings],
  );

  useEffect(() => {
    if (selectedDocument?.id === draftId && dirty) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (!selectedDocument) {
        setDraftId(null);
        setDraftUpdatedAt(null);
        setTitle("");
        setContent("");
        setDirty(false);
        setError("");
        return;
      }
      setDraftId(selectedDocument.id);
      setDraftUpdatedAt(selectedDocument.updated_at);
      setTitle(selectedDocument.title);
      setContent(selectedDocument.content);
      setRichTextEditable(canEditAsRichText(selectedDocument.content));
      setDirty(false);
      if (selectedDocument.id !== draftId) {
        setError("");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dirty, draftId, selectedDocument]);

  async function saveDocument() {
    if (!selectedDocument || savingRef.current || deletingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    documentMutationControllerRef.current?.abort();
    const requestController = new AbortController();
    documentMutationControllerRef.current = requestController;
    const mutationGeneration = documentMutationGenerationRef.current + 1;
    documentMutationGenerationRef.current = mutationGeneration;
    const isCurrentMutation = () =>
      documentMutationGenerationRef.current === mutationGeneration;
    const timeout = window.setTimeout(
      () => requestController.abort(),
      WORKSPACE_REQUEST_TIMEOUT_MS,
    );
    const nextTitle = title.trim() || t("documents.untitled");
    const nextUpdatedAt = new Date().toISOString();
    try {
      let updateQuery = createClient()
        .from("documents")
        .update({ title: nextTitle, content, updated_at: nextUpdatedAt })
        .eq("id", selectedDocument.id)
        .eq("server_id", serverId);
      if (draftUpdatedAt) updateQuery = updateQuery.eq("updated_at", draftUpdatedAt);
      const { data: updatedDocument, error: updateError } = await updateQuery
        .select("id, server_id, title, content, created_by, generated_by_agent_id, created_at, updated_at")
        .abortSignal(requestController.signal)
        .maybeSingle();
      if (!isCurrentMutation()) return;
      if (updateError) {
        setError(updateError.message);
        return;
      }
      if (!updatedDocument) {
        // A teammate wrote to this document while it was open. Their version
        // wins the write; the reload puts it on screen rather than letting the
        // autosave keep retrying over the top of it.
        setConflict(true);
        setDirty(false);
        await loadDocument(selectedDocument.id, true);
        return;
      }
      setConflict(false);
      const updatedRecord = updatedDocument as WorkspaceDocumentRecord;
      const nextDetailSnapshot = {
        serverId,
        documentId: selectedDocument.id,
        document: {
          ...updatedRecord,
          generatorName: selectedDocument.generatorName,
          generatorAvatarUrl: selectedDocument.generatorAvatarUrl,
        },
      };
      detailSnapshotRef.current = nextDetailSnapshot;
      setDetailSnapshot(nextDetailSnapshot);
      setListSnapshot((current) => {
        if (!current || current.serverId !== serverId) return current;
        const documents = current.documents
          .map((document) => document.id === updatedRecord.id
            ? {
                ...document,
                title: updatedRecord.title,
                updated_at: updatedRecord.updated_at,
              }
            : document)
          .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime());
        const nextSnapshot = { ...current, documents };
        listSnapshotRef.current = nextSnapshot;
        return nextSnapshot;
      });
      setTitle(nextTitle);
      setDraftUpdatedAt(updatedRecord.updated_at);
      setDirty(false);
      scheduleDocumentsRefresh();
    } catch (saveError) {
      if (!isCurrentMutation()) return;
      setError(
        requestController.signal.aborted
          ? "Document save timed out. Your draft is still here; try again."
          : saveError instanceof Error ? saveError.message : t("documents.saveFailed"),
      );
    } finally {
      window.clearTimeout(timeout);
      if (documentMutationControllerRef.current === requestController) {
        documentMutationControllerRef.current = null;
      }
      if (isCurrentMutation()) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  // Nothing is unsaved for long now, so leaving only has to wait for a save
  // already in flight rather than ask the person to decide about a draft.
  useUnsavedChangesGuard(saving, () => undefined, false);

  // Autosave. A pause in typing is the signal — saving on every keystroke would
  // put a partial sentence in front of whichever teammate reads it next.
  useEffect(() => {
    if (!dirty || !selectedDocument) return;
    const timer = window.setTimeout(() => {
      void saveDocument();
    }, 900);
    saveTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (saveTimerRef.current === timer) saveTimerRef.current = null;
    };
    // saveDocument closes over the current draft, which is exactly what should
    // be written when the pause happens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, dirty, selectedDocument, title]);

  async function deleteDocument() {
    if (!selectedDocument || deletingRef.current || savingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setError("");
    documentMutationControllerRef.current?.abort();
    const requestController = new AbortController();
    documentMutationControllerRef.current = requestController;
    const mutationGeneration = documentMutationGenerationRef.current + 1;
    documentMutationGenerationRef.current = mutationGeneration;
    const isCurrentMutation = () =>
      documentMutationGenerationRef.current === mutationGeneration;
    const timeout = window.setTimeout(
      () => requestController.abort(),
      WORKSPACE_REQUEST_TIMEOUT_MS,
    );
    try {
      const { error: deleteError } = await createClient()
        .from("documents")
        .delete()
        .eq("id", selectedDocument.id)
        .eq("server_id", serverId)
        .abortSignal(requestController.signal);
      if (!isCurrentMutation()) return;
      if (deleteError) {
        setError(deleteError.message);
        return;
      }
      setListSnapshot((current) => {
        if (!current || current.serverId !== serverId) return current;
        const nextSnapshot = {
          ...current,
          documents: current.documents.filter((document) => document.id !== selectedDocument.id),
        };
        listSnapshotRef.current = nextSnapshot;
        documentIdsRef.current.delete(selectedDocument.id);
        return nextSnapshot;
      });
      setConfirmDelete(false);
      setDirty(false);
      window.requestAnimationFrame(() => {
        router.push(`/s/${serverSlug}/documents`);
      });
      scheduleDocumentsRefresh();
    } catch (deleteError) {
      if (!isCurrentMutation()) return;
      setError(
        requestController.signal.aborted
          ? "Document deletion timed out. Refresh before trying again."
          : deleteError instanceof Error ? deleteError.message : t("documents.deleteFailed"),
      );
    } finally {
      window.clearTimeout(timeout);
      if (documentMutationControllerRef.current === requestController) {
        documentMutationControllerRef.current = null;
      }
      if (isCurrentMutation()) {
        deletingRef.current = false;
        setDeleting(false);
      }
    }
  }

  if ((!documentId && listLoading) || (documentId && detailLoading)) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center bg-card text-sm text-muted-foreground">
        {t("documents.loading")}
      </div>
    );
  }

  if (documentId && !selectedDocument && currentDetailLoadState?.error) {
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-card px-6 text-center">
        <p role="alert" className="max-w-md text-sm text-destructive">
          {currentDetailLoadState.error}
        </p>
        <Button variant="outline" size="sm" onClick={() => void loadDocument(documentId)}>
          <RefreshCw />
          {t("runtime.retry")}
        </Button>
      </div>
    );
  }

  if (!documentId && !currentListSnapshot && currentListLoadState?.error) {
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-card px-6 text-center">
        <p role="alert" className="max-w-md text-sm text-destructive">
          {currentListLoadState.error}
        </p>
        <Button variant="outline" size="sm" onClick={() => void loadDocuments()}>
          <RefreshCw />
          {t("runtime.retry")}
        </Button>
      </div>
    );
  }

  if (selectedDocument) {
    return (
      <div className="flex min-w-0 flex-1 flex-col bg-card">
        <SectionHeader
          // The document carries its own title now, so the bar above it says
          // where you are and what state the document is in instead of saying
          // the title a second time.
          title={t("documents.title")}
          description={
            conflict
              ? t("documents.conflict")
              : saving
                ? t("documents.saving")
                : dirty
                  ? t("documents.unsaved")
                  : t("documents.saved")
          }
          action={(
            <div className="flex items-center gap-1">
              {/* Both modes write the same Markdown; this is a preference for
                  how you would rather see it, and it is remembered. */}
              <div className="mr-1 flex items-center rounded-lg bg-accent/60 p-0.5">
                {(["rich", "source"] as const).map((mode) => (
                  <button
                    aria-pressed={useRichText === (mode === "rich")}
                    className={`rounded-[6px] px-2 py-1 text-[12px] transition-colors disabled:opacity-40 ${
                      useRichText === (mode === "rich")
                        ? "bg-card text-foreground shadow-[0_0_0_1px_var(--border)]"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    disabled={mode === "rich" && !richTextEditable}
                    key={mode}
                    onClick={() => chooseDocumentEditor(mode)}
                    title={
                      mode === "rich" && !richTextEditable
                        ? t("documents.editModeLocked")
                        : undefined
                    }
                    type="button"
                  >
                    {mode === "rich" ? t("documents.editRich") : t("documents.editSource")}
                  </button>
                ))}
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setConfirmDelete(true)}
                title={t("documents.delete")}
                aria-label={t("documents.delete")}
              >
                <Trash2Icon />
              </Button>
            </div>
          )}
        />
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-3xl space-y-5 px-5 py-6">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {selectedDocument.generatorName && selectedDocument.generated_by_agent_id && (
                <>
                  <GeneratedAvatar
                    id={selectedDocument.generated_by_agent_id}
                    name={selectedDocument.generatorName}
                    avatarUrl={selectedDocument.generatorAvatarUrl}
                    shape="rounded"
                    size="xs"
                  />
                  <span>{t("documents.generatedBy", { name: selectedDocument.generatorName })}</span>
                  <span aria-hidden="true">·</span>
                </>
              )}
              <span className="tabular-nums">
                {formatDocumentDate(selectedDocument.updated_at, t)}
              </span>
            </div>
            {/* There is no reading mode and no writing mode. The document is
                the surface, and it saves itself. */}
            <input
              className="w-full border-0 bg-transparent p-0 text-[28px] font-bold leading-tight outline-none placeholder:text-muted-foreground/60"
              onChange={(event) => {
                setTitle(event.target.value);
                setDirty(true);
              }}
              placeholder={t("documents.untitled")}
              value={title}
            />
            {useRichText ? (
              <DocumentEditor
                content={content}
                onChange={(markdown) => {
                  setContent(markdown);
                  setDirty(true);
                }}
                placeholder={t("documents.contentPlaceholder")}
              />
            ) : (
              <div className="space-y-2">
                {!richTextEditable && (
                  <p className="text-xs text-muted-foreground">{t("documents.editModeLocked")}</p>
                )}
                <Textarea
                  className="min-h-[55vh] resize-none border-0 bg-transparent p-0 font-mono text-[13px] leading-[20px] shadow-none focus-visible:ring-0"
                  onChange={(event) => {
                    setContent(event.target.value);
                    setDirty(true);
                  }}
                  placeholder={t("documents.contentPlaceholder")}
                  value={content}
                />
              </div>
            )}
            {(error || currentDetailLoadState?.error) && (
              <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
                <span>{error || currentDetailLoadState?.error}</span>
                {currentDetailLoadState?.error && (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => void loadDocument(selectedDocument.id, true)}
                  >
                    <RefreshCw />
                    {t("runtime.retry")}
                  </Button>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("documents.deleteTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("documents.deleteDescription")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                {t("documents.cancel")}
              </Button>
              <Button variant="destructive" onClick={() => void deleteDocument()} loading={deleting}>
                {t("documents.delete")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-card">
      {/* The search box lives in the sidebar, over the list it searches, and
          the list keeps itself current over the realtime channel — so this bar
          is left with the one thing it is for: saying where you are. */}
      <SectionHeader
        title={t("documents.title")}
        description={activeSearch ? t("documents.searchingFor", { query: activeSearch }) : undefined}
      />
      {documents.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><FileText /></EmptyMedia>
            <EmptyTitle>
              {activeSearch ? t("documents.noMatches") : t("documents.emptyTitle")}
            </EmptyTitle>
            <EmptyDescription>
              {activeSearch
                ? t("documents.noMatchesDescription", { query: activeSearch })
                : t("documents.emptyDescription")}
            </EmptyDescription>
          </EmptyHeader>
          {!activeSearch && (
            <Button loading={creating} onClick={() => void handleCreate()} size="sm">
              <Plus />
              {t("documents.new")}
            </Button>
          )}
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="w-full px-6 pb-6">
            {/* Making something is the first thing you came here to do, so it
                is the first thing on the page rather than a "+" in a corner. */}
            <div className="flex gap-3 py-4">
              <button
                className="flex flex-1 items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:border-muted-foreground/30 hover:bg-accent/40 disabled:opacity-60"
                disabled={creating}
                onClick={() => void handleCreate()}
                type="button"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Plus className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold">
                    {t("documents.new")}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t("documents.newHint")}
                  </span>
                </span>
              </button>
              {/* There is no server to upload to — the workspace is a file on
                  this disk. So the gesture is to point at a folder already on
                  it, which is what "upload" was ever standing in for. */}
              <button
                className="flex flex-1 items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:border-muted-foreground/30 hover:bg-accent/40 disabled:opacity-60"
                disabled={importing}
                onClick={() => folderInputRef.current?.click()}
                type="button"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  {importing ? <RefreshCw className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold">
                    {t("documents.importFolder")}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {importStatus || t("documents.importFolderHint")}
                  </span>
                </span>
              </button>
              <input
                className="hidden"
                multiple
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  // Cleared so choosing the same folder twice fires again.
                  event.target.value = "";
                  void handleImportFolder(files);
                }}
                ref={folderInputRef}
                type="file"
                // Not in the React DOM types; WebKit and Chromium both take it.
                {...{ directory: "", webkitdirectory: "" }}
              />
            </div>

            {/* A table, not a wall of cards: with more than a handful of
                documents the columns are what let you find one. */}
            <div className={`grid ${DOCUMENT_COLUMNS} items-center gap-x-4 border-b px-3 pb-2 text-[12px] text-muted-foreground`}>
              <span>{t("documents.columnTitle")}</span>
              <span>{t("documents.columnOwner")}</span>
              {(["created_at", "updated_at"] as const).map((column) => (
                <button
                  className="flex items-center justify-end gap-1 transition-colors hover:text-foreground"
                  key={column}
                  onClick={() => setSort(column)}
                  type="button"
                >
                  {t(column === "created_at" ? "documents.columnCreated" : "documents.columnUpdated")}
                  {sort === column && <ArrowDown className="size-3" />}
                </button>
              ))}
            </div>
            {sortedDocuments.map((document) => (
              // The whole row opens the document. It used to carry a separate
              // "open" button, which made the row itself dead space and asked
              // for a decision where there was only one thing to do.
              <button
                className={`grid w-full ${DOCUMENT_COLUMNS} items-center gap-x-4 border-b border-border/60 px-3 py-2.5 text-left hover:bg-accent/50`}
                key={document.id}
                onClick={() => router.push(`/s/${serverSlug}/documents?document=${document.id}`)}
                type="button"
              >
                <span className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded bg-primary/10 text-primary">
                    <FileText className="size-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-semibold leading-[20px]">
                      {document.title || t("documents.untitled")}
                    </span>
                    {document.excerpt.trim() && (
                      <span className="mt-0.5 block truncate text-[12px] leading-[17px] text-muted-foreground">
                        {documentPreview(document.excerpt)}
                      </span>
                    )}
                  </span>
                </span>
                <span className="flex w-32 items-center gap-1.5 text-xs text-muted-foreground">
                  {document.generatorName && document.generated_by_agent_id ? (
                    <>
                      <GeneratedAvatar
                        id={document.generated_by_agent_id}
                        name={document.generatorName}
                        avatarUrl={document.generatorAvatarUrl}
                        shape="rounded"
                        size="xs"
                      />
                      <span className="truncate">{document.generatorName}</span>
                    </>
                  ) : (
                    <span className="truncate">{t("documents.ownerYou")}</span>
                  )}
                </span>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {formatDocumentDate(document.created_at, t)}
                </span>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {formatDocumentDate(document.updated_at, t)}
                </span>
              </button>
            ))}
          </div>
        </ScrollArea>
      )}
      {(error || currentListLoadState?.error) && (
        <div role="alert" className="flex flex-wrap items-center gap-2 px-6 pb-4 text-sm text-destructive">
          <span>{error || currentListLoadState?.error}</span>
          {currentListLoadState?.error && (
            <Button variant="outline" size="xs" onClick={() => void loadDocuments(true)}>
              <RefreshCw />
              {t("runtime.retry")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function OptionSelect<T extends string>({
  items,
  value,
  onValueChange,
  className,
  disabled,
  ariaLabel,
  triggerId,
}: {
  items: Array<SelectOption<T>>;
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  triggerId?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = items.find((item) => item.value === value) || items[0];
  return (
    <Select
      items={items}
      open={open}
      value={selected}
      disabled={disabled}
      onOpenChange={setOpen}
      onValueChange={(next) => {
        if (next) onValueChange((next as SelectOption<T>).value);
      }}
    >
      <SelectTrigger
        size="sm"
        className={className}
        aria-label={ariaLabel}
        data-task-status-id={triggerId}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {open && items.map((item) => (
          <SelectItem key={item.value} value={item}>{item.label}</SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function TasksSection({ serverId, serverSlug }: { serverId: string; serverSlug: string }) {
  const { t } = useAppSettings();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [taskSnapshot, setTaskSnapshot] = useState<TasksSnapshot | null>(null);
  const taskSnapshotRef = useRef<TasksSnapshot | null>(null);
  const taskChannelIdsRef = useRef<Set<string>>(new Set());
  const taskLoadGenerationRef = useRef(0);
  const taskLoadControllerRef = useRef<AbortController | null>(null);
  const taskRefreshTimerRef = useRef<number | null>(null);
  const [taskLoadState, setTaskLoadState] = useState<SectionLoadState>({
    serverId: "",
    loading: true,
    refreshing: false,
    error: "",
  });
  const [updatingTaskIds, setUpdatingTaskIds] = useState<Set<string>>(() => new Set());
  const updatingTaskIdsRef = useRef<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createChannelId, setCreateChannelId] = useState("");
  const [createAssigneeValue, setCreateAssigneeValue] = useState("unassigned");
  const [createParentId, setCreateParentId] = useState("none");
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const pendingStatusFocusRef = useRef<string | null>(null);
  const taskFocusFallbackRef = useRef<HTMLButtonElement | null>(null);
  const taskDragSessionRef = useRef<TaskDragSession | null>(null);
  const [taskDragState, setTaskDragState] = useState<{
    taskId: string;
    overStatus: TaskRecord["status"] | null;
  } | null>(null);
  const [error, setError] = useState("");

  const loadTasks = useCallback(async (quiet = false) => {
    taskLoadControllerRef.current?.abort();
    const requestController = new AbortController();
    taskLoadControllerRef.current = requestController;
    const timeout = window.setTimeout(
      () => requestController.abort(),
      WORKSPACE_REQUEST_TIMEOUT_MS,
    );
    const generation = taskLoadGenerationRef.current + 1;
    taskLoadGenerationRef.current = generation;
    const isCurrent = () => taskLoadGenerationRef.current === generation;
    const hasCurrentSnapshot = taskSnapshotRef.current?.serverId === serverId;
    setTaskLoadState({
      serverId,
      loading: !quiet || !hasCurrentSnapshot,
      refreshing: quiet && hasCurrentSnapshot,
      error: "",
    });

    const commitSnapshot = (nextSnapshot: TasksSnapshot) => {
      if (!isCurrent()) return;
      taskSnapshotRef.current = nextSnapshot;
      taskChannelIdsRef.current = new Set(nextSnapshot.channels.map((channel) => channel.id));
      setTaskSnapshot(nextSnapshot);
      setTaskLoadState({ serverId, loading: false, refreshing: false, error: "" });
      if (!quiet) setError("");
    };

    const client = createClient();
    try {
      const userRequest = client.auth.getUser();
      const userResult = await withRequestDeadline<Awaited<typeof userRequest>>(
        userRequest,
        WORKSPACE_REQUEST_TIMEOUT_MS,
        () => requestController.abort(),
      );
      if (requestController.signal.aborted) throw new Error("Request aborted");
      if (userResult.error) throw new Error(userResult.error.message);
      const user = userResult.data.user;
      if (!user) throw new Error("Could not load the current user");
      if (!isCurrent()) return;

      const [serverMembershipsResult, ownChannelMembershipsResult] = await Promise.all([
        client
          .from("server_members")
          .select("member_id, member_type")
          .eq("server_id", serverId)
          .abortSignal(requestController.signal),
        client
          .from("channel_members")
          .select("channel_id")
          .eq("member_id", user.id)
          .eq("member_type", "human")
          .abortSignal(requestController.signal),
      ]);
      if (requestController.signal.aborted) throw new Error("Request aborted");
      if (serverMembershipsResult.error) throw new Error(serverMembershipsResult.error.message);
      if (ownChannelMembershipsResult.error) throw new Error(ownChannelMembershipsResult.error.message);

      const ownChannelIds = Array.from(new Set(
        ((ownChannelMembershipsResult.data || []) as Array<{ channel_id: string }>).map(
          (membership) => membership.channel_id,
        ),
      ));
      const unassigned: AssigneeOption = {
        value: "unassigned",
        label: t("tasks.unassigned"),
        id: null,
        type: null,
        avatarUrl: null,
        mentionName: null,
      };
      if (ownChannelIds.length === 0) {
        commitSnapshot({
          serverId,
          currentUserId: user.id,
          tasks: [],
          channels: [],
          assignees: [unassigned],
          channelMemberships: [],
        });
        return;
      }

      const channelsResult = await client
        .from("channels")
        .select("id, name, type")
        .eq("server_id", serverId)
        .in("id", ownChannelIds)
        .order("created_at")
        .abortSignal(requestController.signal);
      if (requestController.signal.aborted) throw new Error("Request aborted");
      if (channelsResult.error) throw new Error(channelsResult.error.message);
      if (!isCurrent()) return;
      const channelRecords = (channelsResult.data || []) as ChannelRecord[];

      const channelIds = channelRecords.map((channel) => channel.id);
      if (channelIds.length === 0) {
        commitSnapshot({
          serverId,
          currentUserId: user.id,
          tasks: [],
          channels: [],
          assignees: [unassigned],
          channelMemberships: [],
        });
        return;
      }

      const serverMemberships = (serverMembershipsResult.data || []) as ServerMembershipRecord[];
      const humanIds = serverMemberships
        .filter((membership) => membership.member_type === "human")
        .map((membership) => membership.member_id);
      const [membershipsResult, agentsResult, profilesResult, tasksResult] = await Promise.all([
        client
          .from("channel_members")
          .select("channel_id, member_id, member_type")
          .in("channel_id", channelIds)
          .abortSignal(requestController.signal),
        client.rpc("list_workspace_agent_directory", { server_uuid: serverId })
          .abortSignal(requestController.signal),
        humanIds.length > 0
          ? client
              .from("profiles")
              .select("id, display_name, avatar_url")
              .in("id", humanIds)
              .order("created_at")
              .abortSignal(requestController.signal)
          : Promise.resolve({ data: [], error: null }),
        client
          .from("tasks")
          .select("id, message_id, channel_id, task_number, status, parent_task_id, assignee_id, assignee_type, created_at, updated_at")
          .in("channel_id", channelIds)
          .order("task_number", { ascending: true })
          .abortSignal(requestController.signal),
      ]);
      if (requestController.signal.aborted) throw new Error("Request aborted");
      if (membershipsResult.error) throw new Error(membershipsResult.error.message);
      if (agentsResult.error) throw new Error(agentsResult.error.message);
      if (profilesResult.error) throw new Error(profilesResult.error.message);
      if (tasksResult.error) throw new Error(tasksResult.error.message);
      if (!isCurrent()) return;

      const agentRecords = (agentsResult.data || []) as AgentRecord[];
      const workspaceMemberKeys = new Set([
        ...serverMemberships
          .filter((membership) => membership.member_type === "human")
          .map((membership) => `human:${membership.member_id}`),
        ...agentRecords.map((agent) => `agent:${agent.id}`),
      ]);
      const membershipRecords = ((membershipsResult.data || []) as MembershipRecord[]).filter(
        (membership) => workspaceMemberKeys.has(`${membership.member_type}:${membership.member_id}`),
      );

      const profileRecords = (profilesResult.data || []) as ProfileRecord[];
      const nextAssignees: AssigneeOption[] = [
        unassigned,
        ...profileRecords.map((profile) => ({
          value: `human:${profile.id}`,
          label: profile.id === user.id ? `${profile.display_name} (${t("message.you")})` : profile.display_name,
          id: profile.id,
          type: "human" as const,
          avatarUrl: profile.avatar_url,
          mentionName: null,
        })),
        ...agentRecords.map((agent) => ({
          value: `agent:${agent.id}`,
          label: agent.display_name,
          id: agent.id,
          type: "agent" as const,
          avatarUrl: agent.avatar_url,
          mentionName: agent.name,
        })),
      ];

      const records = (tasksResult.data || []) as TaskRecord[];
      const messageIds = records.map((task) => task.message_id);
      const messagesResult = messageIds.length
        ? await client.from("messages")
            .select("id, content")
            .in("id", messageIds)
            .abortSignal(requestController.signal)
        : { data: [], error: null };
      if (requestController.signal.aborted) throw new Error("Request aborted");
      if (messagesResult.error) throw new Error(messagesResult.error.message);
      if (!isCurrent()) return;
      const messages = new Map(
        ((messagesResult.data || []) as Array<{ id: string; content: string }>).map((message) => [message.id, message.content]),
      );
      const channelMap = new Map(channelRecords.map((channel) => [channel.id, channel]));
      const taskNumberMap = new Map(records.map((task) => [task.id, task.task_number]));
      const assigneeMap = new Map(
        nextAssignees
          .filter((item) => item.id && item.type)
          .map((item) => [`${item.type}:${item.id}`, item]),
      );

      const tasks = records.map((task) => {
        const assignee = task.assignee_id && task.assignee_type
          ? assigneeMap.get(`${task.assignee_type}:${task.assignee_id}`)
          : null;
        return {
          ...task,
          title: messages.get(task.message_id)?.split("\n")[0]?.replace(/^#+\s*/, "") || t("tasks.untitled"),
          channel: channelMap.get(task.channel_id) || null,
          assigneeName: assignee?.label || null,
          assigneeAvatarUrl: assignee?.avatarUrl || null,
          parentTaskNumber: task.parent_task_id ? taskNumberMap.get(task.parent_task_id) || null : null,
        };
      });
      commitSnapshot({
        serverId,
        currentUserId: user.id,
        tasks,
        channels: channelRecords,
        assignees: nextAssignees,
        channelMemberships: membershipRecords,
      });
    } catch (loadError) {
      if (taskLoadGenerationRef.current !== generation) return;
      setTaskLoadState({
        serverId,
        loading: false,
        refreshing: false,
        error: requestController.signal.aborted
          ? "Task loading timed out. Refresh and try again."
          : loadError instanceof Error ? loadError.message : String(loadError),
      });
    } finally {
      window.clearTimeout(timeout);
      if (taskLoadControllerRef.current === requestController) {
        taskLoadControllerRef.current = null;
      }
    }
  }, [serverId, t]);

  const currentTaskSnapshot = taskSnapshot?.serverId === serverId ? taskSnapshot : null;
  const tasks = currentTaskSnapshot?.tasks || EMPTY_TASKS;
  const channels = currentTaskSnapshot?.channels || EMPTY_CHANNELS;
  const assignees = currentTaskSnapshot?.assignees || EMPTY_ASSIGNEES;
  const channelMemberships = currentTaskSnapshot?.channelMemberships || EMPTY_MEMBERSHIPS;
  const currentUserId = currentTaskSnapshot?.currentUserId || null;
  const currentTaskLoadState = taskLoadState.serverId === serverId ? taskLoadState : null;
  const loading = !currentTaskSnapshot && (currentTaskLoadState?.loading ?? true);
  const refreshing = currentTaskLoadState?.refreshing ?? false;
  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );

  useLayoutEffect(() => {
    const taskId = pendingStatusFocusRef.current;
    if (!taskId) return;
    let settleFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      settleFrame = window.requestAnimationFrame(() => {
        const escapedTaskId = CSS.escape(taskId);
        const trigger = document.querySelector<HTMLElement>(
          `[data-task-status-id="${escapedTaskId}"]`,
        );
        pendingStatusFocusRef.current = null;
        (trigger || taskFocusFallbackRef.current)?.focus();
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(settleFrame);
    };
  }, [tasks]);

  const updateSnapshotTasks = useCallback((
    updater: (current: TaskViewModel[]) => TaskViewModel[],
  ) => {
    setTaskSnapshot((current) => {
      if (!current || current.serverId !== serverId) return current;
      const nextSnapshot = { ...current, tasks: updater(current.tasks) };
      taskSnapshotRef.current = nextSnapshot;
      return nextSnapshot;
    });
  }, [serverId]);

  const unassignedAssignee = useMemo<AssigneeOption>(() => (
    assignees.find((item) => item.value === "unassigned") || {
      value: "unassigned",
      label: t("tasks.unassigned"),
      id: null,
      type: null,
      avatarUrl: null,
      mentionName: null,
    }
  ), [assignees, t]);
  const { assigneeItemsByChannel, assigneeOptionsByChannel } = useMemo(() => {
    const optionByMember = new Map(
      assignees
        .filter((option) => option.id && option.type)
        .map((option) => [`${option.type}:${option.id}`, option]),
    );
    const optionsByChannel = new Map<string, AssigneeOption[]>();
    const seenByChannel = new Map<string, Set<string>>();
    for (const channel of channels) {
      optionsByChannel.set(channel.id, [unassignedAssignee]);
      seenByChannel.set(channel.id, new Set());
    }
    for (const membership of channelMemberships) {
      const channelOptions = optionsByChannel.get(membership.channel_id);
      const seen = seenByChannel.get(membership.channel_id);
      if (!channelOptions || !seen) continue;
      const key = `${membership.member_type}:${membership.member_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const option = optionByMember.get(key);
      if (option) channelOptions.push(option);
    }
    const itemsByChannel = new Map(
      Array.from(optionsByChannel, ([channelId, options]) => [
        channelId,
        options.map(({ value, label }) => ({ value, label })),
      ]),
    );
    return {
      assigneeItemsByChannel: itemsByChannel,
      assigneeOptionsByChannel: optionsByChannel,
    };
  }, [assignees, channelMemberships, channels, unassignedAssignee]);
  const effectiveCreateChannelId = channels.some((channel) => channel.id === createChannelId)
    ? createChannelId
    : channels[0]?.id || "";
  const createAssigneeOptions = useMemo(
    () => assigneeOptionsByChannel.get(effectiveCreateChannelId) || [unassignedAssignee],
    [assigneeOptionsByChannel, effectiveCreateChannelId, unassignedAssignee],
  );
  const effectiveCreateAssigneeValue = createAssigneeOptions.some(
    (option) => option.value === createAssigneeValue,
  ) ? createAssigneeValue : "unassigned";
  const effectiveCreateParentId = createParentId !== "none" && tasks.some(
    (task) => task.id === createParentId && task.channel_id === effectiveCreateChannelId,
  ) ? createParentId : "none";

  const scheduleTaskRefresh = useCallback(() => {
    if (taskRefreshTimerRef.current !== null) window.clearTimeout(taskRefreshTimerRef.current);
    taskRefreshTimerRef.current = window.setTimeout(() => {
      taskRefreshTimerRef.current = null;
      void loadTasks(true);
    }, 140);
  }, [loadTasks]);

  useEffect(() => {
    taskChannelIdsRef.current = new Set();
    updatingTaskIdsRef.current.clear();
    const initialLoadFrame = window.requestAnimationFrame(() => void loadTasks());
    let active = true;
    const client = createClient();
    const subscription = client
      .channel(`workspace-tasks:${serverId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks" },
        (payload: { new?: Partial<TaskRecord>; old?: Partial<TaskRecord> }) => {
          if (!active) return;
          const record = payload.new?.id ? payload.new : payload.old;
          if (!record?.id) return;
          const channelId = record.channel_id || taskSnapshotRef.current?.tasks.find(
            (task) => task.id === record.id,
          )?.channel_id;
          if (!channelId || !taskChannelIdsRef.current.has(channelId)) return;
          scheduleTaskRefresh();
        },
      )
      .subscribe((status: string) => {
        if (!active || (status !== "CHANNEL_ERROR" && status !== "TIMED_OUT")) return;
        setTaskLoadState((current) => current.serverId === serverId
          ? { ...current, refreshing: false, error: "Task updates could not connect. Refresh to try again." }
          : current);
      });
    return () => {
      active = false;
      window.cancelAnimationFrame(initialLoadFrame);
      taskLoadGenerationRef.current += 1;
      taskLoadControllerRef.current?.abort();
      taskLoadControllerRef.current = null;
      taskChannelIdsRef.current = new Set();
      if (taskRefreshTimerRef.current !== null) {
        window.clearTimeout(taskRefreshTimerRef.current);
        taskRefreshTimerRef.current = null;
      }
      client.removeChannel(subscription);
    };
  }, [loadTasks, scheduleTaskRefresh, serverId]);

  const statusMeta = useMemo(() => ({
    todo: { label: t("tasks.todo"), icon: Circle, iconClass: "text-muted-foreground" },
    in_progress: { label: t("tasks.inProgress"), icon: Clock3, iconClass: "text-info-foreground" },
    in_review: { label: t("tasks.inReview"), icon: ScanEye, iconClass: "text-warning-foreground" },
    done: { label: t("tasks.done"), icon: CheckCircle2, iconClass: "text-success-foreground" },
  }), [t]);
  const statusItems = useMemo<Array<SelectOption<TaskRecord["status"]>>>(() => (
    TASK_STATUSES.map((status) => ({
      value: status,
      label: statusMeta[status].label,
    }))
  ), [statusMeta]);
  const channelItems = channels.map((channel) => ({
    value: channel.id,
    label: channel.type === "dm" ? channel.name : `#${channel.name}`,
  }));
  const parentItems = [
    { value: "none", label: t("tasks.noParent") },
    ...tasks
      .filter((task) => task.channel_id === effectiveCreateChannelId)
      .map((task) => ({ value: task.id, label: `#${task.task_number} · ${task.title}` })),
  ];

  const requestedStatus = searchParams.get("status") as TaskRecord["status"] | null;
  const selectedStatus = TASK_STATUSES.find((status) => status === requestedStatus) || null;
  const statusOrder: Array<TaskRecord["status"]> = [...TASK_STATUSES];
  const orderedStatuses = selectedStatus
    ? [selectedStatus, ...statusOrder.filter((status) => status !== selectedStatus)]
    : statusOrder;
  const groups = orderedStatuses
    .map((status) => ({
      status,
      tasks: tasks
        .filter((task) => task.status === status)
        .sort((left, right) => {
          if (right.parent_task_id === left.id) return -1;
          if (left.parent_task_id === right.id) return 1;
          return left.task_number - right.task_number;
        }),
    }));

  function resolveAgentAssignmentMentionName(
    channelId: string,
    assignee: AssigneeOption,
  ) {
    if (assignee.type !== "agent") return null;
    if (!assignee.id || !assignee.mentionName) {
      throw new Error("The selected agent could not be notified");
    }
    const mentionName = assignee.mentionName;
    const matchingAgents = (assigneeOptionsByChannel.get(channelId) || []).filter(
      (option) => option.type === "agent" &&
        option.mentionName?.localeCompare(mentionName, undefined, { sensitivity: "accent" }) === 0,
    );
    if (matchingAgents.length !== 1 || matchingAgents[0].id !== assignee.id) {
      throw new Error("Agents in this channel need unique display names before one can be assigned");
    }
    return mentionName;
  }

  async function updateTask(
    task: TaskViewModel,
    patch: Partial<TaskViewModel>,
    nextAssignee?: AssigneeOption,
  ) {
    if (updatingTaskIdsRef.current.has(task.id)) return;
    const assigneeChanged = patch.assignee_id !== undefined && (
      patch.assignee_id !== task.assignee_id || patch.assignee_type !== task.assignee_type
    );
    if (patch.status === task.status && !assigneeChanged) return;
    updatingTaskIdsRef.current.add(task.id);
    setUpdatingTaskIds(new Set(updatingTaskIdsRef.current));
    setError("");
    updateSnapshotTasks((current) => current.map(
      (item) => item.id === task.id ? { ...item, ...patch } : item,
    ));
    const client = createClient();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      let expectedUpdatedAt = task.updated_at;
      if (assigneeChanged) {
        if (!nextAssignee) throw new Error("The selected assignee is unavailable");
        const { data: assignmentResult, error: assignmentError } = await client
          .rpc("assign_task_with_notification", {
            task_uuid: task.id,
            assignee_uuid: nextAssignee.id,
            assignee_type: nextAssignee.type,
            assignee_mention_name: resolveAgentAssignmentMentionName(
              task.channel_id,
              nextAssignee,
            ),
            sender_agent_uuid: null,
            expected_updated_at: task.updated_at,
          })
          .abortSignal(controller.signal);
        if (
          assignmentError ||
          !assignmentResult ||
          typeof assignmentResult !== "object" ||
          !("task" in assignmentResult)
        ) {
          throw new Error(assignmentError?.message || "The task is no longer available");
        }
        const assignedTask = assignmentResult.task as { updated_at?: unknown };
        if (typeof assignedTask.updated_at === "string") {
          expectedUpdatedAt = assignedTask.updated_at;
        }
      }

      if (patch.status !== undefined && patch.status !== task.status) {
        const { data: statusResult, error: updateError } = await client
          .rpc("update_task_status", {
            task_uuid: task.id,
            task_status: patch.status,
            sender_agent_uuid: null,
            expected_updated_at: expectedUpdatedAt,
          })
          .abortSignal(controller.signal);
        if (
          updateError ||
          !statusResult ||
          typeof statusResult !== "object" ||
          !("task" in statusResult)
        ) {
          throw new Error(updateError?.message || "The task is no longer available");
        }
      }
    } catch (updateError) {
      const message = controller.signal.aborted
        ? "Task update timed out. Refresh and try again."
        : updateError instanceof Error ? updateError.message : String(updateError);
      void loadTasks(true);
      setError(message);
    } finally {
      window.clearTimeout(timeout);
      updatingTaskIdsRef.current.delete(task.id);
      setUpdatingTaskIds(new Set(updatingTaskIdsRef.current));
    }
  }

  function clearTaskDrag() {
    taskDragSessionRef.current = null;
    setTaskDragState(null);
  }

  function handleTaskDragStart(event: DragEvent<HTMLElement>, task: TaskViewModel) {
    if (updatingTaskIdsRef.current.has(task.id)) {
      event.preventDefault();
      return;
    }
    taskDragSessionRef.current = { taskId: task.id, submitted: false };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", task.id);
    setTaskDragState({ taskId: task.id, overStatus: null });
  }

  function handleTaskDragOver(
    event: DragEvent<HTMLElement>,
    status: TaskRecord["status"],
  ) {
    const session = taskDragSessionRef.current;
    const task = session ? taskById.get(session.taskId) : null;
    if (!session || session.submitted || !task || task.status === status) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setTaskDragState((current) =>
      current?.taskId === session.taskId && current.overStatus === status
        ? current
        : { taskId: session.taskId, overStatus: status },
    );
  }

  function handleTaskDragLeave(event: DragEvent<HTMLElement>, status: TaskRecord["status"]) {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) return;
    setTaskDragState((current) => current?.overStatus === status
      ? { ...current, overStatus: null }
      : current);
  }

  function handleTaskDrop(event: DragEvent<HTMLElement>, status: TaskRecord["status"]) {
    event.preventDefault();
    const session = taskDragSessionRef.current;
    if (!session || session.submitted) return;
    const task = taskById.get(session.taskId);
    const transferredTaskId = event.dataTransfer.getData("text/plain");
    if (
      !task ||
      (transferredTaskId && transferredTaskId !== session.taskId) ||
      task.status === status ||
      updatingTaskIdsRef.current.has(task.id)
    ) {
      clearTaskDrag();
      return;
    }
    session.submitted = true;
    pendingStatusFocusRef.current = task.id;
    clearTaskDrag();
    void updateTask(task, { status });
  }

  async function createTask() {
    const title = createTitle.trim();
    if (!title || !effectiveCreateChannelId || !currentUserId || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setError("");
    const client = createClient();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const parent = effectiveCreateParentId === "none"
        ? null
        : tasks.find((task) => task.id === effectiveCreateParentId);
      if (parent && parent.channel_id !== effectiveCreateChannelId) throw new Error("Parent task must use the same channel");
      const assignee = createAssigneeOptions.find(
        (item) => item.value === effectiveCreateAssigneeValue,
      ) || unassignedAssignee;
      const { data: result, error: taskError } = await client
        .rpc("create_task_with_message", {
          channel_uuid: effectiveCreateChannelId,
          task_title: title,
          parent_task_uuid: parent?.id || null,
          assignee_uuid: assignee.id,
          assignee_type: assignee.type,
          assignee_mention_name: resolveAgentAssignmentMentionName(
            effectiveCreateChannelId,
            assignee,
          ),
          sender_agent_uuid: null,
        })
        .abortSignal(controller.signal);
      if (
        taskError ||
        !result ||
        typeof result !== "object" ||
        !("task" in result)
      ) {
        throw new Error(taskError?.message || "Could not create task");
      }
      setCreateTitle("");
      setCreateAssigneeValue("unassigned");
      setCreateParentId("none");
      setCreateOpen(false);
      await loadTasks(true);
    } catch (createError) {
      setError(
        controller.signal.aborted
          ? "Task creation timed out. Refresh before trying again."
          : createError instanceof Error ? createError.message : String(createError),
      );
    } finally {
      window.clearTimeout(timeout);
      creatingRef.current = false;
      setCreating(false);
    }
  }

  function openTaskChannel(task: TaskViewModel) {
    if (!task.channel) return;
    const prefix = task.channel.type === "dm" ? "dm" : "channel";
    router.push(`/s/${serverSlug}/${prefix}/${task.channel.id}`);
  }

  const visibleTaskError = error || currentTaskLoadState?.error || "";

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-card">
      <SectionHeader
        title={t("tasks.title")}
        description={t("tasks.description")}
        action={(
          <div className="flex items-center gap-1.5">
            <Button
              ref={taskFocusFallbackRef}
              size="sm"
              onClick={() => setCreateOpen(true)}
              disabled={!currentTaskSnapshot}
            >
              <Plus />
              {t("tasks.new")}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void loadTasks(true)}
              disabled={loading || refreshing}
              aria-label={t("tasks.refresh")}
              title={t("tasks.refresh")}
            >
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
            </Button>
          </div>
        )}
      />
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("tasks.loading")}
        </div>
      ) : visibleTaskError && tasks.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p role="alert" className="max-w-md text-sm text-destructive">{visibleTaskError}</p>
          <Button variant="outline" size="sm" onClick={() => void loadTasks()}>
            <RefreshCw />
            {t("tasks.refresh")}
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {visibleTaskError && (
            <div role="alert" className="flex flex-wrap items-center gap-2 border-b px-6 py-2 text-sm text-destructive">
              <span>{visibleTaskError}</span>
              <Button variant="outline" size="xs" onClick={() => void loadTasks(true)}>
                <RefreshCw />
                {t("tasks.refresh")}
              </Button>
            </div>
          )}
          <ScrollArea className="min-h-0 flex-1" scrollFade scrollbarGutter>
            <div
              className="flex min-h-full min-w-max items-stretch gap-4 p-5 sm:p-6"
              aria-label={t("tasks.title")}
              role="region"
            >
            {groups.map((group) => {
              const meta = statusMeta[group.status];
              const StatusIcon = meta.icon;
              const isDropTarget = taskDragState?.overStatus === group.status;
              return (
                <section
                  key={group.status}
                  className={`flex min-h-80 w-72 min-w-72 flex-col rounded-2xl p-2 transition-[background-color,box-shadow] motion-reduce:transition-none ${
                    isDropTarget
                      ? "bg-accent/80 ring-2 ring-ring/40"
                      : "bg-muted/40 ring-1 ring-border/60"
                  }`}
                  data-drop-target={isDropTarget ? "true" : undefined}
                  onDragOver={(event) => handleTaskDragOver(event, group.status)}
                  onDragLeave={(event) => handleTaskDragLeave(event, group.status)}
                  onDrop={(event) => handleTaskDrop(event, group.status)}
                  aria-labelledby={`task-column-${group.status}`}
                >
                  <div className="flex h-9 shrink-0 items-center gap-2 px-1.5">
                    <StatusIcon className={`size-4 ${meta.iconClass}`} aria-hidden="true" />
                    <h2 id={`task-column-${group.status}`} className="text-sm font-semibold">
                      {meta.label}
                    </h2>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                      {t("tasks.count", { count: String(group.tasks.length) })}
                    </span>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col gap-2" role="list">
                    {isDropTarget && (
                      <div
                        className="flex min-h-16 items-center justify-center rounded-xl border border-dashed border-ring/60 bg-background/70 px-3 text-center text-xs font-medium text-foreground"
                        role="status"
                      >
                        {t("tasks.dropHere")}
                      </div>
                    )}
                    {group.tasks.length === 0 && !isDropTarget && (
                      <div className="flex min-h-24 flex-1 items-center justify-center rounded-xl border border-dashed border-border/70 px-4 text-center text-xs text-muted-foreground">
                        {t("tasks.emptyColumn")}
                      </div>
                    )}
                    {group.tasks.map((task) => {
                      const assigneeValue = task.assignee_id && task.assignee_type
                        ? `${task.assignee_type}:${task.assignee_id}`
                        : "unassigned";
                      const taskAssigneeOptions = assigneeOptionsByChannel.get(task.channel_id) || [unassignedAssignee];
                      const taskAssigneeItems = assigneeItemsByChannel.get(task.channel_id) || [{
                        value: unassignedAssignee.value,
                        label: unassignedAssignee.label,
                      }];
                      const isDragging = taskDragState?.taskId === task.id;
                      const isUpdating = updatingTaskIds.has(task.id);
                      return (
                        <Card
                          key={task.id}
                          draggable={!isUpdating}
                          onDragStart={(event) => handleTaskDragStart(event, task)}
                          onDragEnd={clearTaskDrag}
                          aria-grabbed={isDragging}
                          data-task-card={task.id}
                          data-dragging={isDragging ? "true" : undefined}
                          title={t("tasks.dragHint")}
                          role="listitem"
                          className={`${isUpdating ? "cursor-wait" : "cursor-grab active:cursor-grabbing"} transition-[opacity,box-shadow] motion-reduce:transition-none ${
                            isDragging ? "opacity-45 ring-2 ring-ring/30" : ""
                          } ${task.status === "done" ? "text-muted-foreground" : ""}`}
                        >
                          <CardPanel className="space-y-3 p-3">
                            <div className="flex items-center gap-2">
                              <span className="text-xs tabular-nums text-muted-foreground">
                                #{task.task_number}
                              </span>
                              <span className="ml-auto select-none text-xs tracking-[-0.16em] text-muted-foreground" aria-hidden="true">
                                ⋮⋮
                              </span>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                disabled={!task.channel}
                                onClick={() => openTaskChannel(task)}
                                title={t("tasks.open")}
                                aria-label={t("tasks.open")}
                              >
                                <ArrowRight />
                              </Button>
                            </div>
                            <button
                              type="button"
                              onClick={() => openTaskChannel(task)}
                              disabled={!task.channel}
                              className="block w-full min-w-0 text-left disabled:cursor-default"
                            >
                              <span className={`block text-sm font-semibold leading-snug ${task.status === "done" ? "line-through decoration-border" : ""}`}>
                                {task.title}
                              </span>
                            </button>
                            <div className="space-y-1 text-xs text-muted-foreground">
                              <p className="truncate" title={task.channel?.name}>
                                {task.channel
                                  ? task.channel.type === "dm" ? task.channel.name : `#${task.channel.name}`
                                  : t("tasks.unknownChannel")}
                              </p>
                              <p className="truncate">
                                {task.parentTaskNumber
                                  ? t("tasks.subtaskOf", { number: String(task.parentTaskNumber) })
                                  : t("tasks.noParent")}
                              </p>
                            </div>
                            <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2">
                              <div className="flex min-w-0 items-center gap-1">
                                {task.assignee_id && (
                                  <GeneratedAvatar
                                    id={task.assignee_id}
                                    name={task.assigneeName || undefined}
                                    avatarUrl={task.assigneeAvatarUrl}
                                    initials={task.assignee_type === "human"}
                                    size="xs"
                                  />
                                )}
                                <OptionSelect
                                  items={taskAssigneeItems}
                                  value={assigneeValue}
                                  ariaLabel={`${t("tasks.assigneeField")}: ${task.title}`}
                                  disabled={isUpdating}
                                  className="min-h-7 w-full min-w-0 border-transparent bg-transparent px-1 shadow-none before:hidden"
                                  onValueChange={(value) => {
                                    const next = taskAssigneeOptions.find((item) => item.value === value) || unassignedAssignee;
                                    void updateTask(task, {
                                      assignee_id: next.id,
                                      assignee_type: next.type,
                                      assigneeName: next.label,
                                      assigneeAvatarUrl: next.avatarUrl,
                                    }, next);
                                  }}
                                />
                              </div>
                              <OptionSelect
                                items={statusItems}
                                value={task.status}
                                ariaLabel={`${t("tasks.statusField")}: ${task.title}`}
                                triggerId={task.id}
                                disabled={isUpdating}
                                className="min-h-7 w-full min-w-0 border-transparent bg-transparent px-1 shadow-none before:hidden"
                                onValueChange={(status) => {
                                  pendingStatusFocusRef.current = task.id;
                                  void updateTask(task, { status });
                                }}
                              />
                            </div>
                          </CardPanel>
                        </Card>
                      );
                    })}
                  </div>
                </section>
              );
            })}
            </div>
          </ScrollArea>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("tasks.new")}</DialogTitle>
            <DialogDescription>{t("tasks.newDescription")}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <Field>
              <FieldLabel>{t("tasks.titleField")}</FieldLabel>
              <Input
                autoFocus
                value={createTitle}
                onChange={(event) => setCreateTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) void createTask();
                }}
                placeholder={t("tasks.titlePlaceholder")}
              />
            </Field>
            <Field>
              <FieldLabel>{t("tasks.channelField")}</FieldLabel>
              <OptionSelect
                items={channelItems}
                value={effectiveCreateChannelId}
                ariaLabel={t("tasks.channelField")}
                onValueChange={(channelId) => {
                  setCreateChannelId(channelId);
                  setCreateAssigneeValue("unassigned");
                  setCreateParentId("none");
                }}
              />
            </Field>
            <Field>
              <FieldLabel>{t("tasks.assigneeField")}</FieldLabel>
              <OptionSelect
                items={assigneeItemsByChannel.get(effectiveCreateChannelId) || [{
                  value: unassignedAssignee.value,
                  label: unassignedAssignee.label,
                }]}
                value={effectiveCreateAssigneeValue}
                ariaLabel={t("tasks.assigneeField")}
                onValueChange={setCreateAssigneeValue}
              />
            </Field>
            <Field>
              <FieldLabel>{t("tasks.parentField")}</FieldLabel>
              <OptionSelect
                items={parentItems}
                value={effectiveCreateParentId}
                ariaLabel={t("tasks.parentField")}
                onValueChange={setCreateParentId}
              />
            </Field>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" disabled={creating} />}>
              {t("tasks.cancel")}
            </DialogClose>
            <Button
              onClick={() => void createTask()}
              loading={creating}
              disabled={!createTitle.trim() || !effectiveCreateChannelId || !currentUserId}
            >
              {creating ? t("tasks.creating") : t("tasks.create")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

export function WorkspaceSection({
  section,
  serverId,
  serverSlug,
}: {
  section: WorkspaceSectionName;
  serverId: string;
  serverSlug: string;
}) {
  if (section === "documents") {
    return <DocumentsSection key={`documents:${serverId}`} serverId={serverId} serverSlug={serverSlug} />;
  }
  return <TasksSection key={`tasks:${serverId}`} serverId={serverId} serverSlug={serverSlug} />;
}
