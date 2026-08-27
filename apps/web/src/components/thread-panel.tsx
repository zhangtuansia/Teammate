'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  AlertCircleIcon,
  ArrowDownIcon,
  CheckIcon,
  LoaderCircleIcon,
  MoreVerticalIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SendHorizontalIcon,
  Trash2Icon,
  TypeIcon,
  XIcon,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAppSettings } from '@/hooks/use-app-settings';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Toggle } from '@/components/ui/toggle';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { ResizablePanelHandle } from '@/components/ui/resizable-panel-handle';
import { SafeMarkdown } from '@/components/ui/safe-markdown';
import TiptapMessageInput, {
  type FormattingAction,
  type TiptapMessageInputHandle,
} from './tiptap-message-input';
import { GeneratedAvatar } from './generated-avatar';
import { EmojiPickerButton } from './emoji-picker-button';
import { MessageDeleteDialog } from './message-delete-dialog';
import {
  ATTACHMENT_ACCEPT,
  attachmentMarkdown,
  uploadAttachment,
} from '@/lib/attachments';
import { preferredEmojiForm, reactionKey } from '@/lib/emoji';
import { formatMessageClock, parseMessageTime } from '@/lib/message-time';

const THREAD_PANEL_WIDTH_KEY = 'teammate:thread-panel-width';
const THREAD_DRAFT_STORAGE_PREFIX = 'teammate:thread-draft:';
const DEFAULT_THREAD_PANEL_WIDTH = 360;
const MIN_THREAD_PANEL_WIDTH = 320;
const MAX_THREAD_PANEL_WIDTH = 520;

function clampThreadPanelWidth(width: number) {
  const safeWidth = Number.isFinite(width) ? width : DEFAULT_THREAD_PANEL_WIDTH;
  return Math.min(MAX_THREAD_PANEL_WIDTH, Math.max(MIN_THREAD_PANEL_WIDTH, Math.round(safeWidth)));
}

function persistThreadDraft(key: string | null, content: string) {
  if (!key || typeof window === 'undefined') return;
  try {
    if (content.trim()) {
      window.localStorage.setItem(key, content);
      window.sessionStorage.removeItem(key);
    } else {
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Draft persistence is a recovery aid; storage restrictions must not block replies.
  }
}

export interface ThreadMessage {
  id: string;
  channel_id: string;
  content: string;
  sender_id: string;
  sender_type: 'human' | 'agent' | 'system';
  created_at: string;
  thread_parent_id: string | null;
  thread_broadcast?: boolean | number | null;
  profiles?: { display_name: string } | null;
  edited_at?: string | null;
  pending?: boolean;
  delivery?: 'pending' | 'sent' | 'failed';
  deliveryError?: string;
}

interface ThreadReactionRow {
  actor_id: string;
  actor_type: 'human' | 'agent';
  emoji: string;
}

interface ThreadReactionSummary {
  actorNames: string[];
  count: number;
  emoji: string;
  mine: boolean;
}

function summarizeThreadReactions(
  rows: ThreadReactionRow[] | undefined,
  viewerId: string | null,
  identityFor: ThreadPanelProps['identityFor'],
) {
  if (!rows?.length) return [];
  const byEmoji = new Map<string, ThreadReactionSummary>();
  for (const row of rows) {
    const key = reactionKey(row.emoji);
    const existing = byEmoji.get(key);
    const actorName = identityFor(row.actor_id).name;
    if (!existing) {
      byEmoji.set(key, {
        actorNames: [actorName],
        count: 1,
        emoji: row.emoji,
        mine: row.actor_id === viewerId,
      });
      continue;
    }
    existing.actorNames.push(actorName);
    existing.count += 1;
    existing.emoji = preferredEmojiForm(existing.emoji, row.emoji);
    if (row.actor_id === viewerId) existing.mine = true;
  }
  return [...byEmoji.values()];
}

interface ThreadPanelProps {
  channelId: string;
  channelLabel: string;
  formattingVisible: boolean;
  parent: ThreadMessage;
  serverId: string;
  userId: string | null;
  /** Resolved from the channel roster the message list already loaded. */
  identityFor: (senderId: string, message?: ThreadMessage) => {
    name: string;
    url: string | null;
  };
  onClose: () => void;
  onFormattingVisibleChange: (visible: boolean) => void;
  onParentDelete: () => void;
  onParentEdit: (content: string) => void;
  /** Lets the parent keep the channel's reply counts in step with the panel. */
  onRepliesChanged: (parentId: string, replies: ThreadMessage[]) => void;
  focusReplyId?: string | null;
}

function ThreadMessageEditor({
  initialContent,
  onCancel,
  onSave,
}: {
  initialContent: string;
  onCancel: () => void;
  onSave: (content: string) => void;
}) {
  const { t } = useAppSettings();
  const editorRef = useRef<TiptapMessageInputHandle>(null);
  const [hasContent, setHasContent] = useState(initialContent.trim().length > 0);
  const formattingLabels: Record<FormattingAction, string> = {
    blockquote: t('message.format.blockquote'),
    bold: t('message.format.bold'),
    bulletList: t('message.format.bulletList'),
    code: t('message.format.code'),
    codeBlock: t('message.format.codeBlock'),
    italic: t('message.format.italic'),
    orderedList: t('message.format.orderedList'),
    strike: t('message.format.strike'),
  };
  const submit = useCallback((markdown: string) => {
    const content = markdown.trim();
    if (!content) return false;
    onSave(content);
    return true;
  }, [onSave]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => editorRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="mt-1 overflow-hidden rounded-lg border bg-card shadow-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
      <TiptapMessageInput
        ariaLabel={t('message.edit')}
        formattingLabels={formattingLabels}
        initialContent={initialContent}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return false;
          onCancel();
          return true;
        }}
        onSend={submit}
        onTextUpdate={(_textBeforeCursor, fullText) => setHasContent(fullText.trim().length > 0)}
        ref={editorRef}
        showFormatting
      />
      <div className="flex justify-end gap-2 px-2 pb-2">
        <Button onClick={onCancel} size="xs" type="button" variant="ghost">
          {t('message.editCancel')}
        </Button>
        <Button
          disabled={!hasContent}
          onClick={() => submit(editorRef.current?.getMarkdown() ?? '')}
          size="xs"
          type="button"
        >
          {t('message.editSave')}
        </Button>
      </div>
    </div>
  );
}

function ThreadRow({
  canModify,
  identityFor,
  message,
  onKeyboardMove,
  onCancel,
  onDelete,
  onSubmitEdit,
  onToggleReaction,
  reactions,
  onRetry,
  sameSender,
  viewerId,
  highlighted = false,
}: {
  canModify?: boolean;
  identityFor: ThreadPanelProps['identityFor'];
  message: ThreadMessage;
  onKeyboardMove?: (
    messageId: string,
    direction: 'previous' | 'next' | 'first' | 'last',
  ) => void;
  onCancel?: (message: ThreadMessage) => void;
  onDelete?: () => void;
  onSubmitEdit?: (content: string) => void;
  onToggleReaction?: (emoji: string) => void;
  reactions?: ThreadReactionRow[];
  onRetry?: (message: ThreadMessage) => void;
  sameSender: boolean;
  viewerId: string | null;
  highlighted?: boolean;
}) {
  const { t } = useAppSettings();
  const [editing, setEditing] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const moreActionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const who = identityFor(message.sender_id, message);
  const time = formatMessageClock(message.created_at);
  const reactionSummaries = summarizeThreadReactions(reactions, viewerId, identityFor);
  return (
    <div
      id={`thread-message-${message.id}`}
      className={`group relative flex gap-2 px-5 outline-none transition-colors hover:bg-accent/40 focus-within:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 ${
        highlighted ? 'bg-primary/10 ring-1 ring-inset ring-primary/25' : ''
      } ${
        sameSender ? 'py-0.5' : 'pt-2 pb-1'
      } ${
        message.pending ? 'opacity-60' : ''
      }`}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !onKeyboardMove) return;
        const direction = event.key === 'ArrowUp'
          ? 'previous'
          : event.key === 'ArrowDown'
            ? 'next'
            : event.key === 'Home'
              ? 'first'
              : event.key === 'End'
                ? 'last'
                : null;
        if (!direction) return;
        event.preventDefault();
        onKeyboardMove(message.id, direction);
      }}
      role="article"
      tabIndex={-1}
    >
      {!editing && !message.pending && message.delivery !== 'failed'
        && ((viewerId && onToggleReaction) || (canModify && onSubmitEdit && onDelete)) && (
        <div className="absolute -top-3.5 right-5 z-10 flex gap-0.5 rounded-xl bg-card p-0.5 opacity-0 shadow-[0_0_0_1px_var(--border),0_1px_3px_0_rgba(0,0,0,0.08)] transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {viewerId && onToggleReaction && (
            <EmojiPickerButton
              label={t('message.addEmoji')}
              onPick={onToggleReaction}
              t={t}
            />
          )}
          {canModify && onSubmitEdit && onDelete && (
            <Menu>
              <MenuTrigger
                ref={moreActionsTriggerRef}
                aria-label={t('message.moreActions')}
                className="flex size-7 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
                title={t('message.moreActions')}
              >
                <MoreVerticalIcon className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end" side="bottom">
                <MenuItem onClick={() => setEditing(true)}>
                  <PencilIcon />
                  {t('message.edit')}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  onClick={() => setDeleteConfirmationOpen(true)}
                  variant="destructive"
                >
                  <Trash2Icon />
                  {t('message.delete')}
                </MenuItem>
              </MenuPopup>
            </Menu>
          )}
        </div>
      )}
      <div className="w-9 shrink-0 pt-0.5">
        {sameSender ? (
          <time
            className="block text-right text-[11px] leading-[22px] text-muted-foreground opacity-0 tabular-nums group-hover:opacity-100 group-focus-within:opacity-100"
            dateTime={message.created_at}
          >
            {time}
          </time>
        ) : (
          <GeneratedAvatar
            avatarUrl={who.url}
            id={message.sender_id}
            name={who.name}
            shape="rounded"
            size="message"
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!sameSender && (
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-black leading-[22px]">{who.name}</span>
            <span className="text-xs text-muted-foreground">{time}</span>
          </div>
        )}
        {editing && onSubmitEdit ? (
          <ThreadMessageEditor
            initialContent={message.content}
            onCancel={() => setEditing(false)}
            onSave={(content) => {
              setEditing(false);
              onSubmitEdit(content);
            }}
          />
        ) : (
          <div
            className={`prose-message wrap-break-word text-[15px] subpixel-antialiased ${
              message.edited_at ? 'has-edit-marker' : ''
            }`}
            style={{ lineHeight: '22px' }}
          >
            <SafeMarkdown mentions>
              {message.content}
            </SafeMarkdown>
            {message.edited_at && (
              <span className="ml-1 align-baseline text-xs text-muted-foreground">
                {t('message.edited')}
              </span>
            )}
          </div>
        )}
        {reactionSummaries.length > 0 && onToggleReaction && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {reactionSummaries.map((reaction) => (
              <button
                aria-pressed={reaction.mine}
                className={`flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-bold tabular-nums ${
                  reaction.mine
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-accent/50 text-muted-foreground hover:border-muted-foreground/40'
                }`}
                key={reactionKey(reaction.emoji)}
                onClick={() => onToggleReaction(reaction.emoji)}
                title={reaction.actorNames.join(', ')}
                type="button"
              >
                <span className="text-[15px] leading-none">{reaction.emoji}</span>
                <span>{reaction.count}</span>
              </button>
            ))}
          </div>
        )}
        {message.delivery && (
          <div
            className={`mt-1 flex min-h-5 items-center gap-1.5 text-[11px] ${
              message.delivery === 'failed' ? 'text-destructive' : 'text-muted-foreground'
            }`}
            role={message.delivery === 'failed' ? 'alert' : 'status'}
          >
            {message.delivery === 'pending' ? (
              <LoaderCircleIcon
                aria-hidden="true"
                className="size-3 animate-spin motion-reduce:animate-none"
              />
            ) : message.delivery === 'sent' ? (
              <CheckIcon aria-hidden="true" className="size-3" />
            ) : (
              <AlertCircleIcon aria-hidden="true" className="size-3" />
            )}
            <span title={message.deliveryError}>
              {message.delivery === 'pending'
                ? t('message.deliveryPending')
                : message.delivery === 'sent'
                  ? t('message.deliverySent')
                  : t('message.deliveryFailed')}
            </span>
            {message.delivery === 'failed' && onRetry && (
              <>
                <Button
                  className="h-5 gap-1 px-1.5 text-[11px]"
                  onClick={() => onRetry(message)}
                  size="xs"
                  variant="ghost"
                >
                  <RotateCcwIcon aria-hidden="true" className="size-3" />
                  {t('message.retryDelivery')}
                </Button>
                {onCancel && (
                  <Button
                    className="h-5 gap-1 px-1.5 text-[11px]"
                    onClick={() => onCancel(message)}
                    size="xs"
                    variant="ghost"
                  >
                    <XIcon aria-hidden="true" className="size-3" />
                    {t('message.editCancel')}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {onDelete && deleteConfirmationOpen && (
        <MessageDeleteDialog
          content={message.content}
          onConfirm={onDelete}
          onOpenChange={(open) => {
            setDeleteConfirmationOpen(open);
            if (!open) {
              window.requestAnimationFrame(() => moreActionsTriggerRef.current?.focus());
            }
          }}
          open
        />
      )}
    </div>
  );
}

/**
 * Slack's thread view: the root message, then its replies, then a composer
 * scoped to the thread. Replies never enter the channel's main flow — the
 * indicator on the root is how people get back here.
 */
export function ThreadPanel({
  channelId,
  channelLabel,
  formattingVisible,
  parent,
  serverId,
  userId,
  identityFor,
  onClose,
  onFormattingVisibleChange,
  onParentDelete,
  onParentEdit,
  onRepliesChanged,
  focusReplyId,
}: ThreadPanelProps) {
  const supabase = createClient();
  const { t } = useAppSettings();
  const legacyDraftStorageKey = useMemo(
    () => `${THREAD_DRAFT_STORAGE_PREFIX}${channelId}:${parent.id}`,
    [channelId, parent.id],
  );
  const draftStorageKey = useMemo(
    () => userId
      ? `${THREAD_DRAFT_STORAGE_PREFIX}${userId}:${serverId}:${channelId}:${parent.id}`
      : null,
    [channelId, parent.id, serverId, userId],
  );
  const initialDraft = useMemo(() => {
    if (!draftStorageKey || typeof window === 'undefined') return '';
    try {
      const persisted = window.localStorage.getItem(draftStorageKey);
      const legacyDraft = process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_MODE === 'true'
        ? window.localStorage.getItem(legacyDraftStorageKey) ||
          window.sessionStorage.getItem(legacyDraftStorageKey) ||
          ''
        : '';
      window.localStorage.removeItem(legacyDraftStorageKey);
      window.sessionStorage.removeItem(legacyDraftStorageKey);
      if (persisted !== null) return persisted;
      if (legacyDraft) window.localStorage.setItem(draftStorageKey, legacyDraft);
      return legacyDraft;
    } catch {
      return '';
    }
  }, [draftStorageKey, legacyDraftStorageKey]);
  const [replies, setReplies] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [realtimeWarning, setRealtimeWarning] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [sendError, setSendError] = useState('');
  const [reactions, setReactions] = useState<Map<string, ThreadReactionRow[]>>(new Map());
  const [newReplyCount, setNewReplyCount] = useState(0);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [highlightedReplyId, setHighlightedReplyId] = useState<string | null>(null);
  const [alsoSend, setAlsoSend] = useState(false);
  const [hasContent, setHasContent] = useState(() => initialDraft.trim().length > 0);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_THREAD_PANEL_WIDTH);
  const composerRef = useRef<TiptapMessageInputHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const formattingLabels: Record<FormattingAction, string> = {
    blockquote: t('message.format.blockquote'),
    bold: t('message.format.bold'),
    bulletList: t('message.format.bulletList'),
    code: t('message.format.code'),
    codeBlock: t('message.format.codeBlock'),
    italic: t('message.format.italic'),
    orderedList: t('message.format.orderedList'),
    strike: t('message.format.strike'),
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(!focusReplyId);
  const reactionsRef = useRef(reactions);
  const repliesRef = useRef<ThreadMessage[]>([]);
  const handledFocusReplyRef = useRef('');
  const focusHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notifyRef = useRef(onRepliesChanged);
  const latestDraftRef = useRef(initialDraft);
  useEffect(() => {
    notifyRef.current = onRepliesChanged;
  }, [onRepliesChanged]);

  useEffect(() => {
    reactionsRef.current = reactions;
  }, [reactions]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setHasContent(initialDraft.trim().length > 0);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draftStorageKey, initialDraft]);

  useEffect(() => {
    latestDraftRef.current = initialDraft;
    const draftValueRef = latestDraftRef;
    return () => {
      if (draftSaveTimeoutRef.current) {
        clearTimeout(draftSaveTimeoutRef.current);
        draftSaveTimeoutRef.current = null;
      }
      persistThreadDraft(draftStorageKey, draftValueRef.current);
    };
  }, [draftStorageKey, initialDraft]);

  const scheduleDraftSave = useCallback((content: string) => {
    latestDraftRef.current = content;
    if (!draftStorageKey) return;
    if (draftSaveTimeoutRef.current) clearTimeout(draftSaveTimeoutRef.current);
    const key = draftStorageKey;
    draftSaveTimeoutRef.current = setTimeout(() => {
      draftSaveTimeoutRef.current = null;
      persistThreadDraft(key, latestDraftRef.current);
    }, 250);
  }, [draftStorageKey]);

  const attachFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setAttachmentBusy(true);
    setAttachmentError('');
    try {
      for (const file of files) {
        const uploaded = await uploadAttachment(file);
        composerRef.current?.insertText(`\n${attachmentMarkdown(uploaded)}\n`);
      }
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : t('message.attachFile'));
    } finally {
      setAttachmentBusy(false);
    }
  }, [t]);

  const applyReplies = useCallback(
    (next: ThreadMessage[]) => {
      repliesRef.current = next;
      setReplies(next);
      notifyRef.current(
        parent.id,
        next.filter((reply) => !reply.pending && reply.delivery !== 'failed'),
      );
    },
    [parent.id],
  );

  const loadReactions = useCallback(async (messageIds?: string[]) => {
    const ids = messageIds ?? [parent.id, ...repliesRef.current.map((reply) => reply.id)];
    if (ids.length === 0) {
      setReactions(new Map());
      return;
    }
    const { data, error } = await supabase
      .from('message_reactions')
      .select('message_id, actor_id, actor_type, emoji')
      .in('message_id', ids);
    if (error || !data) return;
    const byMessage = new Map<string, ThreadReactionRow[]>();
    for (const row of data as Array<ThreadReactionRow & { message_id: string }>) {
      const reaction = {
        actor_id: row.actor_id,
        actor_type: row.actor_type,
        emoji: row.emoji,
      } satisfies ThreadReactionRow;
      const current = byMessage.get(row.message_id);
      if (current) current.push(reaction);
      else byMessage.set(row.message_id, [reaction]);
    }
    setReactions(byMessage);
  }, [parent.id, supabase]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('channel_id', channelId)
        .eq('thread_parent_id', parent.id)
        .order('seq', { ascending: true });
      if (!active) return;
      if (error) {
        setLoadError(t('message.thread.loadFailed'));
        setLoading(false);
        return;
      }
      setLoadError('');
      const loaded = (data ?? []) as ThreadMessage[];
      const localDrafts = repliesRef.current.filter(
        (reply) =>
          (reply.pending || reply.delivery === 'failed') &&
          !loaded.some((item) => item.id === reply.id),
      );
      applyReplies([...loaded, ...localDrafts]);
      void loadReactions([parent.id, ...loaded.map((reply) => reply.id)]);
      setLoading(false);
    })();

    const subscription = supabase
      .channel(`thread:${parent.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channelId}`,
        },
        (payload: { new: ThreadMessage }) => {
          const incoming = payload.new;
          if (!active || incoming.thread_parent_id !== parent.id) return;
          const current = repliesRef.current;
          const matchingIndex = current.findIndex((reply) => reply.id === incoming.id);
          if (matchingIndex !== -1) {
            if (current[matchingIndex].pending || current[matchingIndex].delivery === 'pending') {
              applyReplies(current.map((reply, index) => index === matchingIndex ? incoming : reply));
            }
            return;
          }
          // Drop the optimistic row this insert confirms.
          const settled = current.filter(
            (reply) =>
              !(reply.pending && reply.content === incoming.content && reply.sender_id === incoming.sender_id),
          );
          if (!isNearBottomRef.current) {
            setNewReplyCount((count) => count + 1);
          }
          applyReplies([...settled, incoming]);
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channelId}`,
        },
        (payload: { new: ThreadMessage }) => {
          if (!active || payload.new.thread_parent_id !== parent.id) return;
          applyReplies(
            repliesRef.current.map((reply) => reply.id === payload.new.id ? payload.new : reply),
          );
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channelId}`,
        },
        (payload: { old: ThreadMessage }) => {
          if (!active || !payload.old?.id) return;
          if (!repliesRef.current.some((reply) => reply.id === payload.old.id)) return;
          applyReplies(repliesRef.current.filter((reply) => reply.id !== payload.old.id));
        },
      )
      .subscribe((status: string) => {
        if (!active) return;
        if (status === 'SUBSCRIBED') {
          setRealtimeWarning('');
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtimeWarning(t('message.thread.realtimeDegraded'));
        }
      });

    return () => {
      active = false;
      void supabase.removeChannel(subscription);
    };
  }, [applyReplies, channelId, loadReactions, parent.id, reloadToken, supabase, t]);

  useEffect(() => {
    let active = true;
    const subscription = supabase
      .channel(`thread-reactions:${parent.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'message_reactions' },
        () => {
          if (active) void loadReactions();
        },
      )
      .subscribe();
    return () => {
      active = false;
      void supabase.removeChannel(subscription);
    };
  }, [loadReactions, parent.id, supabase]);

  useLayoutEffect(() => {
    if (!isNearBottomRef.current) return;
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    setNewReplyCount(0);
    setScrolledUp(false);
  }, [replies]);

  useEffect(() => {
    if (!focusReplyId) return;
    const focusKey = `${parent.id}:${focusReplyId}`;
    if (handledFocusReplyRef.current === focusKey) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`thread-message-${focusReplyId}`);
      if (!target) return;
      handledFocusReplyRef.current = focusKey;
      setHighlightedReplyId(focusReplyId);
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
      if (focusHighlightTimerRef.current) clearTimeout(focusHighlightTimerRef.current);
      focusHighlightTimerRef.current = setTimeout(() => {
        setHighlightedReplyId((current) => current === focusReplyId ? null : current);
        focusHighlightTimerRef.current = null;
      }, 2400);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusReplyId, parent.id, replies]);

  useEffect(() => () => {
    if (focusHighlightTimerRef.current) clearTimeout(focusHighlightTimerRef.current);
  }, []);

  const applyPanelWidth = useCallback((nextWidth: number) => {
    const width = clampThreadPanelWidth(nextWidth);
    panelRef.current?.style.setProperty('--thread-panel-width', `${width}px`);
    return width;
  }, []);

  const commitPanelWidth = useCallback((nextWidth: number) => {
    const width = applyPanelWidth(nextWidth);
    setPanelWidth(width);
    try {
      window.localStorage.setItem(THREAD_PANEL_WIDTH_KEY, String(width));
    } catch {
      // A blocked local store only makes the width session-scoped.
    }
  }, [applyPanelWidth]);

  useLayoutEffect(() => {
    let preferredWidth = DEFAULT_THREAD_PANEL_WIDTH;
    try {
      const storedWidth = Number(window.localStorage.getItem(THREAD_PANEL_WIDTH_KEY));
      if (Number.isFinite(storedWidth) && storedWidth > 0) {
        preferredWidth = clampThreadPanelWidth(storedWidth);
      }
    } catch {
      // The inline CSS fallback keeps the default width when storage is unavailable.
    }
    const width = applyPanelWidth(preferredWidth);
    const frame = window.requestAnimationFrame(() => setPanelWidth(width));
    return () => window.cancelAnimationFrame(frame);
  }, [applyPanelWidth]);

  const persistReply = useCallback(async (optimistic: ThreadMessage) => {
    const { data, error } = await supabase
      .from('messages')
      .insert({
        channel_id: channelId,
        content: optimistic.content,
        id: optimistic.id,
        sender_id: optimistic.sender_id,
        sender_type: 'human',
        thread_broadcast: optimistic.thread_broadcast === true || optimistic.thread_broadcast === 1,
        thread_parent_id: parent.id,
      })
      .select()
      .single();

    let settled = error ? null : data as ThreadMessage | null;
    if (!settled) {
      // A timed-out response can still have committed. Resolve by the stable
      // optimistic id before presenting a retry that would duplicate it.
      const existing = await supabase
        .from('messages')
        .select('*')
        .eq('channel_id', channelId)
        .eq('id', optimistic.id)
        .maybeSingle();
      settled = existing.data as ThreadMessage | null;
    }

    if (settled) {
      setSendError('');
      applyReplies(
        repliesRef.current.map((reply) => reply.id === optimistic.id ? settled : reply),
      );
      return;
    }

    const detail = error?.message || t('message.sendFailed');
    setSendError(t('message.sendFailedInline'));
    applyReplies(
      repliesRef.current.map((reply) => reply.id === optimistic.id
        ? { ...reply, delivery: 'failed', deliveryError: detail, pending: false }
        : reply),
    );
  }, [applyReplies, channelId, parent.id, supabase, t]);

  const retryReply = useCallback((reply: ThreadMessage) => {
    const optimistic: ThreadMessage = {
      ...reply,
      delivery: 'pending',
      deliveryError: undefined,
      pending: true,
    };
    setSendError('');
    applyReplies(
      repliesRef.current.map((current) => current.id === reply.id ? optimistic : current),
    );
    void persistReply(optimistic);
  }, [applyReplies, persistReply]);

  const cancelReply = useCallback((reply: ThreadMessage) => {
    applyReplies(repliesRef.current.filter((current) =>
      current.id !== reply.id || current.delivery !== 'failed'));
    setSendError('');
  }, [applyReplies]);

  const editReply = useCallback((messageId: string, content: string) => {
    const previous = repliesRef.current.find((reply) => reply.id === messageId);
    if (!previous) return;
    const editedAt = new Date().toISOString();
    setSendError('');
    applyReplies(repliesRef.current.map((reply) => reply.id === messageId
      ? { ...reply, content, edited_at: editedAt }
      : reply));
    void (async () => {
      const { error } = await supabase
        .from('messages')
        .update({ content, edited_at: editedAt })
        .eq('id', messageId);
      if (!error) return;
      setSendError(t('message.editFailed'));
      applyReplies(repliesRef.current.map((reply) =>
        reply.id === messageId && reply.edited_at === editedAt ? previous : reply));
    })();
  }, [applyReplies, supabase, t]);

  const deleteReply = useCallback((messageId: string) => {
    const previousReplies = repliesRef.current;
    const removedIndex = previousReplies.findIndex((reply) => reply.id === messageId);
    if (removedIndex === -1) return;
    const removed = previousReplies[removedIndex];
    setSendError('');
    applyReplies(previousReplies.filter((reply) => reply.id !== messageId));
    void (async () => {
      const { error } = await supabase.from('messages').delete().eq('id', messageId);
      if (!error) return;
      setSendError(t('message.deleteFailed'));
      if (repliesRef.current.some((reply) => reply.id === messageId)) return;
      const restored = [...repliesRef.current];
      restored.splice(Math.min(removedIndex, restored.length), 0, removed);
      applyReplies(restored);
    })();
  }, [applyReplies, supabase, t]);

  const toggleReaction = useCallback((messageId: string, emoji: string) => {
    if (!userId) return;
    const current = reactionsRef.current.get(messageId) ?? [];
    const key = reactionKey(emoji);
    const stored = current.find(
      (reaction) => reaction.actor_id === userId && reactionKey(reaction.emoji) === key,
    );
    const mine = stored !== undefined;
    setReactions((all) => {
      const existing = all.get(messageId) ?? [];
      const withoutMine = existing.filter(
        (reaction) => !(reaction.actor_id === userId && reactionKey(reaction.emoji) === key),
      );
      const next = new Map(all);
      if (mine) {
        if (withoutMine.length === 0) next.delete(messageId);
        else next.set(messageId, withoutMine);
      } else {
        next.set(messageId, [
          ...withoutMine,
          { actor_id: userId, actor_type: 'human', emoji },
        ]);
      }
      return next;
    });

    void (async () => {
      const request = mine
        ? supabase
            .from('message_reactions')
            .delete()
            .eq('message_id', messageId)
            .eq('actor_id', userId)
            .eq('emoji', stored?.emoji ?? emoji)
        : supabase.from('message_reactions').insert({
            actor_id: userId,
            actor_type: 'human',
            emoji,
            message_id: messageId,
          });
      const { error } = await request;
      if (!error) return;
      setReactions((all) => {
        const existing = all.get(messageId) ?? [];
        const withoutMine = existing.filter(
          (reaction) => !(reaction.actor_id === userId && reactionKey(reaction.emoji) === key),
        );
        const next = new Map(all);
        if (mine) {
          next.set(messageId, [
            ...withoutMine,
            { actor_id: userId, actor_type: 'human', emoji: stored?.emoji ?? emoji },
          ]);
        } else if (withoutMine.length === 0) {
          next.delete(messageId);
        } else {
          next.set(messageId, withoutMine);
        }
        return next;
      });
    })();
  }, [supabase, userId]);

  const send = useCallback(
    (markdown: string) => {
      const content = markdown.trim();
      if (!content || !userId) return false;
      const optimistic: ThreadMessage = {
        channel_id: channelId,
        content,
        created_at: new Date().toISOString(),
        delivery: 'pending',
        id: globalThis.crypto.randomUUID(),
        pending: true,
        sender_id: userId,
        sender_type: 'human',
        thread_broadcast: alsoSend,
        thread_parent_id: parent.id,
      };
      setSendError('');
      if (draftSaveTimeoutRef.current) {
        clearTimeout(draftSaveTimeoutRef.current);
        draftSaveTimeoutRef.current = null;
      }
      latestDraftRef.current = '';
      persistThreadDraft(draftStorageKey, '');
      isNearBottomRef.current = true;
      setNewReplyCount(0);
      setScrolledUp(false);
      applyReplies([...repliesRef.current, optimistic]);
      void persistReply(optimistic);
      return true;
    },
    [alsoSend, applyReplies, channelId, draftStorageKey, parent.id, persistReply, userId],
  );

  const deliveredReplyCount = replies.filter(
    (reply) => !reply.pending && reply.delivery !== 'failed',
  ).length;

  const retryThread = useCallback(() => {
    setLoading(true);
    setLoadError('');
    setRealtimeWarning('');
    setReloadToken((token) => token + 1);
  }, []);

  const handleThreadScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const fromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    isNearBottomRef.current = fromBottom < 80;
    if (isNearBottomRef.current) setNewReplyCount(0);
    setScrolledUp(fromBottom > container.clientHeight * 0.5);
  }, []);

  const scrollToLatestReply = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    isNearBottomRef.current = true;
    setNewReplyCount(0);
    setScrolledUp(false);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    container.scrollTo({
      behavior: reduceMotion ? 'auto' : 'smooth',
      top: container.scrollHeight,
    });
  }, []);

  const newReplyLabel = newReplyCount === 1
    ? t('message.thread.newReply')
    : t('message.thread.newReplies', { count: String(newReplyCount) });

  const focusThreadMessageAtIndex = useCallback((index: number) => {
    const threadMessages = [parent, ...repliesRef.current];
    const message = threadMessages[index];
    if (!message) return;
    const row = document.getElementById(`thread-message-${message.id}`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
  }, [parent]);

  const moveThreadMessageFocus = useCallback((
    messageId: string,
    direction: 'previous' | 'next' | 'first' | 'last',
  ) => {
    const threadMessages = [parent, ...repliesRef.current];
    const currentIndex = threadMessages.findIndex((message) => message.id === messageId);
    if (currentIndex === -1) return;
    if (direction === 'first') {
      focusThreadMessageAtIndex(0);
      return;
    }
    if (direction === 'last') {
      focusThreadMessageAtIndex(threadMessages.length - 1);
      return;
    }
    const offset = direction === 'previous' ? -1 : 1;
    focusThreadMessageAtIndex(
      Math.max(0, Math.min(threadMessages.length - 1, currentIndex + offset)),
    );
  }, [focusThreadMessageAtIndex, parent]);

  return (
    // flex-1 rather than w-full below xl: two width utilities on one element
    // race in the cascade, and flex-basis does not fight the fixed width above.
    <aside
      className="relative flex flex-1 flex-col border-l-[0.5px] bg-card xl:w-[var(--thread-panel-width)] xl:flex-none"
      ref={panelRef}
      style={{ '--thread-panel-width': `${panelWidth}px` } as CSSProperties}
    >
      <ResizablePanelHandle
        ariaLabel={t('message.thread.resize')}
        defaultValue={DEFAULT_THREAD_PANEL_WIDTH}
        max={MAX_THREAD_PANEL_WIDTH}
        min={MIN_THREAD_PANEL_WIDTH}
        onResize={applyPanelWidth}
        onResizeEnd={commitPanelWidth}
        value={panelWidth}
      />
      <div className="flex items-center gap-2 border-b-[0.5px] px-3 py-2">
        <h2 className="text-[14px] font-semibold">{t('message.thread.title')}</h2>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {channelLabel}
        </span>
        <Button
          aria-label={t('message.thread.close')}
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon className="size-4" />
        </Button>
      </div>

      {(loadError || realtimeWarning) && (
        <div
          className="flex items-center justify-between gap-3 border-b bg-warning/5 px-4 py-1.5 text-xs text-warning-foreground"
          role={loadError ? 'alert' : 'status'}
        >
          <span>{loadError || realtimeWarning}</span>
          <Button
            onClick={retryThread}
            size="xs"
            type="button"
            variant="ghost"
          >
            {t('runtime.retry')}
          </Button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          aria-busy={loading}
          aria-label={t('message.thread.history')}
          className="h-full overflow-y-auto py-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
          data-workspace-keyboard-section
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            focusThreadMessageAtIndex(
              event.key === 'ArrowDown' ? 0 : repliesRef.current.length,
            );
          }}
          onScroll={handleThreadScroll}
          ref={scrollRef}
          role="region"
          tabIndex={0}
        >
          <ThreadRow
            canModify={parent.sender_type === 'human' && parent.sender_id === userId && !parent.delivery}
            identityFor={identityFor}
            message={parent}
            onKeyboardMove={moveThreadMessageFocus}
            onDelete={onParentDelete}
            onSubmitEdit={onParentEdit}
            onToggleReaction={parent.sender_type === 'system'
              ? undefined
              : (emoji) => toggleReaction(parent.id, emoji)}
            reactions={reactions.get(parent.id)}
            sameSender={false}
            viewerId={userId}
          />
          <div className="my-2 flex items-center gap-2 px-5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {loading && (
                <LoaderCircleIcon
                  aria-hidden="true"
                  className="size-3 animate-spin motion-reduce:animate-none"
                />
              )}
              {loading
                ? t('message.thread.loading')
                : loadError
                  ? t('message.thread.repliesUnavailable')
                : deliveredReplyCount === 0
                  ? t('message.thread.empty')
                  : deliveredReplyCount === 1
                    ? t('message.thread.oneReply')
                    : t('message.thread.replyCount', { count: String(deliveredReplyCount) })}
            </span>
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
          </div>
          {replies.map((reply, index) => {
            const previous = replies[index - 1];
            const sameSender =
              Boolean(previous) &&
              previous.sender_id === reply.sender_id &&
              (parseMessageTime(reply.created_at)?.getTime() ?? NaN) -
                (parseMessageTime(previous.created_at)?.getTime() ?? NaN) <
                5 * 60 * 1000;
            return (
              <ThreadRow
                canModify={reply.sender_type === 'human' && reply.sender_id === userId && !reply.delivery}
                highlighted={highlightedReplyId === reply.id}
                identityFor={identityFor}
                key={reply.id}
                message={reply}
                onCancel={reply.delivery === 'failed' ? cancelReply : undefined}
                onKeyboardMove={moveThreadMessageFocus}
                onDelete={() => deleteReply(reply.id)}
                onRetry={reply.delivery === 'failed' ? retryReply : undefined}
                onSubmitEdit={(content) => editReply(reply.id, content)}
                onToggleReaction={reply.sender_type === 'system'
                  ? undefined
                  : (emoji) => toggleReaction(reply.id, emoji)}
                reactions={reactions.get(reply.id)}
                sameSender={sameSender}
                viewerId={userId}
              />
            );
          })}
        </div>
        {newReplyCount > 0 && (
          <span aria-live="polite" className="sr-only" role="status">
            {newReplyLabel}
          </span>
        )}
        {(newReplyCount > 0 || scrolledUp) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-4">
            <Button
              aria-label={newReplyCount > 0 ? newReplyLabel : t('message.jumpToLatest')}
              className="pointer-events-auto shadow-lg"
              onClick={scrollToLatestReply}
              size={newReplyCount > 0 ? 'sm' : 'icon-sm'}
              variant="secondary"
            >
              <ArrowDownIcon />
              {newReplyCount > 0 && newReplyLabel}
            </Button>
          </div>
        )}
      </div>

      <div className="px-5 pb-5 pt-2">
        <div
          className={`overflow-hidden rounded-[8px] border bg-card shadow-[0_1px_3px_0_rgba(0,0,0,0.08)] transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24 ${
            draggingFiles ? 'border-ring ring-[3px] ring-ring/24' : ''
          }`}
          onDragEnter={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            dragDepthRef.current += 1;
            setDraggingFiles(true);
          }}
          onDragLeave={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) setDraggingFiles(false);
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            dragDepthRef.current = 0;
            setDraggingFiles(false);
            void attachFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <TiptapMessageInput
            ariaLabel={t('message.thread.placeholder')}
            autoFocus
            disabled={!userId}
            formattingLabels={formattingLabels}
            initialContent={initialDraft}
            key={draftStorageKey ?? parent.id}
            onPasteFiles={(files) => void attachFiles(files)}
            onSend={send}
            onTextUpdate={(_textBeforeCursor, fullText) => {
              setHasContent(Boolean(fullText.trim()));
              scheduleDraftSave(fullText);
            }}
            placeholder={t('message.thread.placeholder')}
            ref={composerRef}
            showFormatting={formattingVisible}
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2">
            <div className="flex min-w-0 items-center gap-2">
              <input
                accept={ATTACHMENT_ACCEPT.join(',')}
                className="hidden"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.target.files || []);
                  event.target.value = '';
                  void attachFiles(files);
                }}
                ref={fileInputRef}
                type="file"
              />
              <Button
                aria-label={t('message.attachFile')}
                disabled={attachmentBusy}
                onClick={() => fileInputRef.current?.click()}
                onMouseDown={(event) => event.preventDefault()}
                size="icon-sm"
                title={t('message.attachFile')}
                type="button"
                variant="ghost"
              >
                {attachmentBusy ? (
                  <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <PlusIcon />
                )}
              </Button>
              <Toggle
                aria-label={t('message.showFormatting')}
                onPressedChange={onFormattingVisibleChange}
                pressed={formattingVisible}
                size="sm"
                title={t('message.showFormatting')}
              >
                <TypeIcon />
              </Toggle>
              <EmojiPickerButton
                label={t('message.addEmoji')}
                onPick={(emoji) => composerRef.current?.insertText(emoji)}
                t={t}
              />
              <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <Checkbox checked={alsoSend} onCheckedChange={(next) => setAlsoSend(next === true)} />
                <span className="truncate">
                  {t('message.thread.alsoSend', { channel: channelLabel })}
                </span>
              </label>
            </div>
            <Button
              aria-label={t('message.send')}
              disabled={!userId || !hasContent}
              onClick={() => {
                const markdown = composerRef.current?.getMarkdown() ?? '';
                if (send(markdown) !== false) composerRef.current?.clear();
              }}
              size="icon-sm"
              title={t('message.send')}
            >
              <SendHorizontalIcon />
            </Button>
          </div>
        </div>
        {sendError && (
          <p className="mt-1.5 text-xs text-destructive" role="alert">
            {sendError}
          </p>
        )}
        {attachmentError && (
          <p className="mt-1.5 text-xs text-destructive" role="alert">
            {attachmentError}
          </p>
        )}
      </div>
    </aside>
  );
}
