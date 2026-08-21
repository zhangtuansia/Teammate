'use client';

import { memo, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  AlertCircleIcon,
  ArrowDownIcon,
  CheckIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  SettingsIcon,
  XIcon,
} from 'lucide-react';
import TiptapMessageInput, { type TiptapMessageInputHandle } from './tiptap-message-input';
import { useAgentActivity } from '@/hooks/use-agent-activity';
import { useAppSettings } from '@/hooks/use-app-settings';
import { useMessageSounds } from '@/hooks/use-message-sounds';
import { useWorkspaceNavigation } from '@/hooks/use-navigation-guard';
import { useWorkspaceServer } from '@/components/workspace-server-context';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SafeMarkdown } from '@/components/ui/safe-markdown';
import { ThinkingIndicator } from '@/components/ui/thinking-indicator';
import { GeneratedAvatar } from './generated-avatar';
import { createTrailingRefreshScheduler } from '@/lib/trailing-refresh';
import { parseRuntimeError } from '@/lib/runtime-error';

const RUNTIME_ERROR_MESSAGE_PREFIX = '<!-- teammate:runtime-error -->';
const DRAFT_STORAGE_PREFIX = 'teammate:message-draft:';
const AGENT_RESPONSE_TIMEOUT_MS = 130_000;
const MESSAGE_REQUEST_TIMEOUT_MS = 18_000;

function persistDraft(key: string | null, content: string) {
  if (!key || typeof window === 'undefined') return;
  try {
    if (content.trim()) window.sessionStorage.setItem(key, content);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Draft persistence is a convenience; storage restrictions must never block chat.
  }
}

interface Message {
  id: string;
  channel_id: string;
  content: string;
  sender_id: string;
  sender_type: 'human' | 'agent' | 'system';
  seq: number | null;
  created_at: string;
  thread_parent_id: string | null;
  profiles?: { display_name: string } | null;
  motion?: 'send' | 'receive';
  delivery?: 'pending' | 'sent' | 'failed';
  deliveryError?: string;
}

interface HumanProfile {
  id: string;
  display_name: string;
  avatar_url: string | null;
}

interface Channel {
  id: string;
  server_id: string;
  name: string;
  type: string;
  description: string | null;
}

interface AgentInfo {
  id: string;
  name: string;
  display_name: string;
  status: string;
  description: string | null;
  avatar_url: string | null;
  is_owner: boolean;
}

type AgentRealtimeUpdate = Partial<AgentInfo> & Pick<AgentInfo, 'id'>;

function patchAgentInfo(current: AgentInfo, update: AgentRealtimeUpdate): AgentInfo {
  return {
    ...current,
    name: typeof update.name === 'string' ? update.name : current.name,
    display_name: typeof update.display_name === 'string'
      ? update.display_name
      : current.display_name,
    status: typeof update.status === 'string' ? update.status : current.status,
    description: update.description === null || typeof update.description === 'string'
      ? update.description
      : current.description,
    avatar_url: update.avatar_url === null || typeof update.avatar_url === 'string'
      ? update.avatar_url
      : current.avatar_url,
    is_owner: typeof update.is_owner === 'boolean' ? update.is_owner : current.is_owner,
  };
}

interface AgentSettingsTarget {
  id: string;
  display_name: string;
  status: string;
  description: string | null;
  avatar_url: string | null;
  owner_id: string;
}

interface MessageTargets {
  addressedAgentIds: string[];
  targetedAgentIds: string[];
  offlineTargetNames: string[];
}

interface MessageRowProps {
  message: Message;
  sameSender: boolean;
  senderName: string;
  avatarUrl: string | null | undefined;
  agentBadgeLabel: string;
  runtimeErrorLabel: string;
  runtimeErrorDescription: (detail: string) => string;
  deliveryPendingLabel: string;
  deliverySentLabel: string;
  deliveryFailedLabel: string;
  retryDeliveryLabel: string;
  onRetryDelivery: (messageId: string) => void;
}

const MessageRow = memo(function MessageRow({
  message,
  sameSender,
  senderName,
  avatarUrl,
  agentBadgeLabel,
  runtimeErrorLabel,
  runtimeErrorDescription,
  deliveryPendingLabel,
  deliverySentLabel,
  deliveryFailedLabel,
  retryDeliveryLabel,
  onRetryDelivery,
}: MessageRowProps) {
  const runtimeErrorDetail = message.content.startsWith(RUNTIME_ERROR_MESSAGE_PREFIX)
    ? message.content.slice(RUNTIME_ERROR_MESSAGE_PREFIX.length).trim()
    : null;
  const formattedTime = new Date(message.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      className={`group flex gap-3 rounded-lg px-2 py-1.5 transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_56px] ${
        message.motion === 'send'
          ? 'animate-message-send'
          : message.motion === 'receive'
            ? 'animate-message-receive'
            : ''
      } ${sameSender ? '' : 'mt-5 first:mt-0'}`}
    >
      <div className="w-8 shrink-0 pt-0.5">
        {!sameSender && (
          <GeneratedAvatar
            id={message.sender_id}
            name={senderName}
            size="md"
            avatarUrl={avatarUrl}
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!sameSender && (
          <div className="mb-0.5 flex items-baseline gap-2">
            <span className="text-[13px] font-semibold">{senderName}</span>
            {message.sender_type === 'agent' && (
              <Badge variant="secondary" className="py-0 text-[10px]">
                {agentBadgeLabel}
              </Badge>
            )}
            <time
              className="text-[11px] text-muted-foreground"
              dateTime={message.created_at}
            >
              {formattedTime}
            </time>
          </div>
        )}
        <div
          className="prose-message wrap-break-word text-[15px] subpixel-antialiased prose-headings:antialiased"
          style={{ lineHeight: '1.54' }}
        >
          {runtimeErrorDetail !== null ? (
            <Alert className="my-1" variant="error">
              <AlertCircleIcon />
              <AlertTitle>{runtimeErrorLabel}</AlertTitle>
              <AlertDescription>{runtimeErrorDescription(runtimeErrorDetail)}</AlertDescription>
            </Alert>
          ) : message.sender_type === 'agent' ? (
            <SafeMarkdown>{message.content}</SafeMarkdown>
          ) : (
            <span className="whitespace-pre-wrap">
              {message.content.split(/(@[^\s,.:!?，。！？]+)/g).map((part, index) =>
                part.startsWith('@') ? (
                  <span
                    key={index}
                    className="rounded bg-primary/10 px-0.5 font-medium text-primary"
                  >
                    {part}
                  </span>
                ) : (
                  part
                ),
              )}
            </span>
          )}
        </div>
        {message.delivery && (
          <div
            aria-atomic="true"
            className={`mt-1 flex min-h-5 items-center gap-1.5 text-[11px] ${
              message.delivery === 'failed'
                ? 'text-destructive'
                : 'text-muted-foreground'
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
                ? deliveryPendingLabel
                : message.delivery === 'sent'
                  ? deliverySentLabel
                  : deliveryFailedLabel}
            </span>
            {message.delivery === 'failed' && (
              <Button
                className="h-5 gap-1 px-1.5 text-[11px]"
                onClick={() => onRetryDelivery(message.id)}
                size="xs"
                variant="ghost"
              >
                <RotateCcwIcon aria-hidden="true" className="size-3" />
                {retryDeliveryLabel}
              </Button>
            )}
          </div>
        )}
      </div>

      {sameSender && (
        <>
          <time className="sr-only" dateTime={message.created_at}>
            {formattedTime}
          </time>
          <time
            aria-hidden="true"
            className="hidden shrink-0 self-center text-[11px] text-muted-foreground group-hover:block"
            dateTime={message.created_at}
          >
            {formattedTime}
          </time>
        </>
      )}
    </div>
  );
});

interface MessageAreaProps {
  channel: Channel | null;
  onToggleSettings?: (agent: AgentSettingsTarget | null) => void;
  showSettings?: boolean;
}

export function MessageArea(props: MessageAreaProps) {
  const server = useWorkspaceServer();
  const { t } = useAppSettings();

  if (props.channel && props.channel.server_id !== server.id) {
    return (
      <div className="flex flex-1 items-center justify-center bg-card px-6 text-center">
        <p className="text-sm text-destructive" role="alert">
          {t('conversation.notFound')}
        </p>
      </div>
    );
  }

  const scopeKey = `${server.id}:${props.channel?.id || 'empty'}`;
  return <MessageAreaContent key={scopeKey} {...props} />;
}

function MessageAreaContent({
  channel,
  onToggleSettings,
  showSettings,
}: MessageAreaProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasContent, setHasContent] = useState(false);
  const [sendError, setSendError] = useState("");
  const [sendWarning, setSendWarning] = useState("");
  const [snapshotChannelId, setSnapshotChannelId] = useState<string | null>(null);
  const [channelLoadError, setChannelLoadError] = useState("");
  const [realtimeWarning, setRealtimeWarning] = useState("");
  const [agentDirectoryError, setAgentDirectoryError] = useState("");
  const [channelReloadToken, setChannelReloadToken] = useState(0);
  const [userId, setUserId] = useState<string | null>(null);
  const [identityLoading, setIdentityLoading] = useState(true);
  const [identityError, setIdentityError] = useState("");
  const [identityReloadToken, setIdentityReloadToken] = useState(0);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [agentMembersLoading, setAgentMembersLoading] = useState(true);
  const [channelAgents, setChannelAgents] = useState<Map<string, AgentInfo>>(new Map());
  const [currentProfile, setCurrentProfile] = useState<HumanProfile | null>(null);
  const [agentTyping, setAgentTyping] = useState(false);
  const [pendingAgentIds, setPendingAgentIds] = useState<string[]>([]);
  const [failedAgentIds, setFailedAgentIds] = useState<string[]>([]);
  const [timedOutAgentIds, setTimedOutAgentIds] = useState<string[]>([]);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [liveAnnouncement, setLiveAnnouncement] = useState<{ id: string; text: string } | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const requestControllersRef = useRef(
    new Map<AbortController, ReturnType<typeof setTimeout>>(),
  );
  const agentDirectoryControllerRef = useRef<AbortController | null>(null);
  const agentDirectoryRequestGenerationRef = useRef(0);
  const olderMessagesRequestGenerationRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const retryAgentDirectoryRef = useRef<() => void>(() => undefined);
  const pendingScrollRestorationRef = useRef<{
    token: number;
    channelId: string;
    generation: number;
    previousScrollTop: number;
    previousScrollHeight: number;
  } | null>(null);
  const scrollRestorationTokenRef = useRef(0);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentReceiptTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const typingStartRef = useRef<string | null>(null);
  const typingStartedAtRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const inputRef = useRef<TiptapMessageInputHandle>(null);
  const userIdRef = useRef<string | null>(null);
  const channelAgentsRef = useRef<Map<string, AgentInfo>>(new Map());
  const pendingAgentIdsRef = useRef<string[]>([]);
  const channelGenerationRef = useRef(0);
  const currentChannelIdRef = useRef<string | null>(null);
  const soundReadyGenerationRef = useRef(0);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const messageRealtimeRef = useRef({ generation: 0, ready: false });
  const supabase = createClient();
  const agentActivities = useAgentActivity();
  const { settings, t } = useAppSettings();
  const { run: runGuardedAction } = useWorkspaceNavigation();
  const playMessageCue = useMessageSounds(settings.messageSounds);
  const describeRuntimeError = useCallback((detail: string) => {
    const parsed = parseRuntimeError(detail);
    if (parsed.kind === 'unsupported-model') return t('message.runtimeErrorUnsupportedModel');
    if (parsed.kind === 'authentication') return t('message.runtimeErrorAuthentication');
    if (parsed.kind === 'rate-limit') return t('message.runtimeErrorRateLimit');
    if (parsed.kind === 'network') return t('message.runtimeErrorNetwork');
    return parsed.detail || t('message.runtimeErrorUnknown');
  }, [t]);
  const draftChannelId = channel?.id || null;
  const draftStorageKey = useMemo(
    () => draftChannelId ? `${DRAFT_STORAGE_PREFIX}${draftChannelId}` : null,
    [draftChannelId],
  );
  const initialDraft = useMemo(() => {
    if (!draftStorageKey || typeof window === 'undefined') return '';
    try {
      return window.sessionStorage.getItem(draftStorageKey) || '';
    } catch {
      return '';
    }
  }, [draftStorageKey]);
  const latestDraftRef = useRef(initialDraft);
  const mentionAgents = useMemo(() => {
    if (mentionQuery === null || channel?.type === 'dm') return [];
    const normalizedQuery = mentionQuery.toLowerCase();
    return Array.from(channelAgents.values()).filter((agent) =>
      agent.name.toLowerCase().includes(normalizedQuery) ||
      agent.display_name.toLowerCase().includes(normalizedQuery),
    );
  }, [channel?.type, channelAgents, mentionQuery]);
  const mentionListboxId = channel ? `mention-suggestions-${channel.id}` : undefined;
  const mentionOpen = mentionAgents.length > 0;
  const activeMentionId = mentionOpen
    ? mentionAgents[Math.min(mentionIndex, mentionAgents.length - 1)]?.id
    : undefined;

  useLayoutEffect(() => {
    currentChannelIdRef.current = draftChannelId;
  }, [draftChannelId]);

  const beginMessageRequest = useCallback(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MESSAGE_REQUEST_TIMEOUT_MS);
    requestControllersRef.current.set(controller, timeout);
    return controller;
  }, []);

  const finishMessageRequest = useCallback((controller: AbortController) => {
    const timeout = requestControllersRef.current.get(controller);
    if (timeout) clearTimeout(timeout);
    requestControllersRef.current.delete(controller);
  }, []);

  const abortMessageRequests = useCallback(() => {
    for (const [controller, timeout] of requestControllersRef.current) {
      clearTimeout(timeout);
      controller.abort();
    }
    requestControllersRef.current.clear();
    agentDirectoryControllerRef.current = null;
    loadingMoreRef.current = false;
  }, []);
  const getChannelActivity = useCallback(
    (agentId: string) => {
      const activity = agentActivities.get(agentId);
      if (activity?.channelId && activity.channelId !== channel?.id) return undefined;
      return activity;
    },
    [agentActivities, channel?.id],
  );

  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  useEffect(() => () => {
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    for (const timer of sentReceiptTimersRef.current.values()) clearTimeout(timer);
    sentReceiptTimersRef.current.clear();
    abortMessageRequests();
  }, [abortMessageRequests]);

  useEffect(() => {
    const sentMessageIds = new Set(
      messages
        .filter((message) => message.delivery === 'sent')
        .map((message) => message.id),
    );

    for (const [messageId, timer] of sentReceiptTimersRef.current) {
      if (sentMessageIds.has(messageId)) continue;
      clearTimeout(timer);
      sentReceiptTimersRef.current.delete(messageId);
    }

    for (const messageId of sentMessageIds) {
      if (sentReceiptTimersRef.current.has(messageId)) continue;
      const channelId = currentChannelIdRef.current;
      const generation = channelGenerationRef.current;
      const timer = setTimeout(() => {
        sentReceiptTimersRef.current.delete(messageId);
        if (
          currentChannelIdRef.current !== channelId ||
          channelGenerationRef.current !== generation
        ) {
          return;
        }
        setMessages((current) => current.map((message) =>
          message.id === messageId && message.delivery === 'sent'
            ? { ...message, delivery: undefined }
            : message));
      }, 1_800);
      sentReceiptTimersRef.current.set(messageId, timer);
    }
  }, [messages]);

  useLayoutEffect(() => {
    const restoration = pendingScrollRestorationRef.current;
    const scrollElement = scrollContainerRef.current;
    if (!restoration || !scrollElement) return;
    if (
      restoration.channelId !== currentChannelIdRef.current ||
      restoration.generation !== channelGenerationRef.current
    ) {
      pendingScrollRestorationRef.current = null;
      return;
    }

    const restorePosition = () => {
      if (
        pendingScrollRestorationRef.current?.token !== restoration.token ||
        restoration.channelId !== currentChannelIdRef.current ||
        restoration.generation !== channelGenerationRef.current
      ) {
        return;
      }
      const heightDelta = scrollElement.scrollHeight - restoration.previousScrollHeight;
      scrollElement.scrollTop = restoration.previousScrollTop + heightDelta;
    };

    restorePosition();
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      restorePosition();
      secondFrame = window.requestAnimationFrame(() => {
        restorePosition();
        if (pendingScrollRestorationRef.current?.token === restoration.token) {
          pendingScrollRestorationRef.current = null;
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [messages]);

  useEffect(() => {
    latestDraftRef.current = initialDraft;
    const draftValueRef = latestDraftRef;
    return () => {
      if (draftSaveTimeoutRef.current) {
        clearTimeout(draftSaveTimeoutRef.current);
        draftSaveTimeoutRef.current = null;
      }
      persistDraft(draftStorageKey, draftValueRef.current);
    };
  }, [draftStorageKey, initialDraft]);

  const scheduleDraftSave = useCallback((content: string) => {
    if (!draftStorageKey) return;
    latestDraftRef.current = content;
    if (draftSaveTimeoutRef.current) clearTimeout(draftSaveTimeoutRef.current);
    const key = draftStorageKey;
    draftSaveTimeoutRef.current = setTimeout(() => {
      draftSaveTimeoutRef.current = null;
      persistDraft(key, latestDraftRef.current);
    }, 250);
  }, [draftStorageKey]);

  const noteIncomingMessages = useCallback((incoming: Message[], generation: number) => {
    if (
      incoming.length === 0 ||
      soundReadyGenerationRef.current !== generation
    ) {
      return;
    }

    const currentUserId = userIdRef.current;
    const received = incoming.filter((message) =>
      currentUserId === null
        ? message.sender_type === 'agent'
        : message.sender_id !== currentUserId,
    );
    if (!isNearBottomRef.current && received.length > 0) {
      setNewMessageCount((count) => count + received.length);
    }

    const agentReplies = incoming.filter((message) => message.sender_type === 'agent');
    if (agentReplies.length > 0) {
      const lastReply = agentReplies[agentReplies.length - 1];
      setLiveAnnouncement({
        id: lastReply.id,
        text: agentReplies.length === 1
          ? t('message.agentReplyAnnouncement')
          : t('message.agentRepliesAnnouncement', { count: String(agentReplies.length) }),
      });
    }
  }, [t]);

  const clearAgentFeedback = useCallback((agentIds: Iterable<string>) => {
    const cleared = new Set(agentIds);
    if (cleared.size === 0) return;
    setFailedAgentIds((current) => current.filter((agentId) => !cleared.has(agentId)));
    setTimedOutAgentIds((current) => current.filter((agentId) => !cleared.has(agentId)));
  }, []);

  const startWaitingForAgents = useCallback((agentIds: Iterable<string>, since?: string) => {
    const requestedAgentIds = Array.from(new Set(agentIds));
    if (requestedAgentIds.length === 0) return;

    const channelId = currentChannelIdRef.current;
    const generation = channelGenerationRef.current;
    const wasWaiting = pendingAgentIdsRef.current.length > 0;
    const uniqueAgentIds = Array.from(new Set([
      ...pendingAgentIdsRef.current,
      ...requestedAgentIds,
    ]));
    pendingAgentIdsRef.current = uniqueAgentIds;
    setPendingAgentIds(uniqueAgentIds);
    setAgentTyping(true);
    const nextStart = since || new Date().toISOString();
    if (!typingStartRef.current || nextStart < typingStartRef.current) {
      typingStartRef.current = nextStart;
    }
    if (!wasWaiting) typingStartedAtRef.current = Date.now();
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      if (
        currentChannelIdRef.current !== channelId ||
        channelGenerationRef.current !== generation
      ) {
        return;
      }
      const awaitingAgentIds = pendingAgentIdsRef.current;
      if (awaitingAgentIds.length === 0) return;
      setTimedOutAgentIds((current) => Array.from(new Set([
        ...current,
        ...awaitingAgentIds,
      ])));
      pendingAgentIdsRef.current = [];
      setPendingAgentIds([]);
      setAgentTyping(false);
      typingStartRef.current = null;
      typingStartedAtRef.current = 0;
      typingTimeoutRef.current = null;
    }, AGENT_RESPONSE_TIMEOUT_MS);
  }, []);

  const updateMentionFromCursor = useCallback((textBeforeCursor: string) => {
    const nextQuery = channel?.type === 'dm'
      ? null
      : textBeforeCursor.match(/@([^\s@]*)$/)?.[1] ?? null;
    if (nextQuery === mentionQuery) return;
    setMentionQuery(nextQuery);
    setMentionIndex(0);
  }, [channel?.type, mentionQuery]);

  const markAgentsResponded = useCallback((respondingIds: Iterable<string>) => {
    const responding = new Set(respondingIds);
    clearAgentFeedback(responding);
    const remaining = pendingAgentIdsRef.current.filter((agentId) => !responding.has(agentId));
    if (remaining.length === pendingAgentIdsRef.current.length) return;
    pendingAgentIdsRef.current = remaining;
    setPendingAgentIds(remaining);
    if (remaining.length === 0) {
      setAgentTyping(false);
      typingStartRef.current = null;
      typingStartedAtRef.current = 0;
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    }
  }, [clearAgentFeedback]);

  useEffect(() => {
    const terminalAgentIds = pendingAgentIdsRef.current.flatMap((agentId) => {
      const state = getChannelActivity(agentId);
      if (!state?.terminal || state.receivedAt < typingStartedAtRef.current) return [];
      return [{ agentId, terminal: state.terminal }];
    });
    if (terminalAgentIds.length === 0) return;

    const completed = new Set(terminalAgentIds.map(({ agentId }) => agentId));
    const failed = terminalAgentIds
      .filter(({ terminal }) => terminal === 'failure')
      .map(({ agentId }) => agentId);
    const timedOut = terminalAgentIds
      .filter(({ terminal }) => terminal === 'timeout')
      .map(({ agentId }) => agentId);
    if (failed.length > 0) {
      setFailedAgentIds((current) => Array.from(new Set([...current, ...failed])));
    }
    if (timedOut.length > 0) {
      setTimedOutAgentIds((current) => Array.from(new Set([...current, ...timedOut])));
    }
    const remaining = pendingAgentIdsRef.current.filter((agentId) => !completed.has(agentId));
    pendingAgentIdsRef.current = remaining;
    setPendingAgentIds(remaining);
    if (remaining.length === 0) {
      setAgentTyping(false);
      typingStartRef.current = null;
      typingStartedAtRef.current = 0;
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    }
  }, [agentActivities, getChannelActivity, pendingAgentIds]);

  useEffect(() => {
    let cancelled = false;
    async function loadCurrentProfile() {
      setIdentityLoading(true);
      setIdentityError("");
      let currentUserId: string;
      try {
        const result = await supabase.auth.getUser() as {
          data: { user: { id: string } | null };
          error?: { message: string } | null;
        };
        if (result.error) throw new Error(result.error.message);
        const { user } = result.data;
        if (!user) throw new Error(t('conversation.loadFailed'));
        if (cancelled) return;
        currentUserId = user.id;
        setUserId(currentUserId);
        setIdentityLoading(false);
      } catch (loadError) {
        if (cancelled) return;
        setUserId(null);
        setCurrentProfile(null);
        setIdentityLoading(false);
        setIdentityError(
          loadError instanceof Error ? loadError.message : t('conversation.loadFailed'),
        );
        return;
      }

      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id, display_name, avatar_url')
          .eq('id', currentUserId)
          .single();
        if (profile && !cancelled) setCurrentProfile(profile as HumanProfile);
      } catch {
        // Profile metadata is optional for sending; keep the authenticated identity usable.
      }
    }
    void loadCurrentProfile();
    return () => {
      cancelled = true;
    };
  }, [identityReloadToken, supabase, t]);

  useEffect(() => {
    if (!userId) return;
    const profileSubscription = supabase
      .channel(`profile:${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` },
        (payload: { new: HumanProfile }) => setCurrentProfile(payload.new),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(profileSubscription);
    };
  }, [supabase, userId]);

  useEffect(() => {
    if (!channel) return;
    const channelId = channel.id;
    const channelType = channel.type;
    currentChannelIdRef.current = channelId;
    const generation = channelGenerationRef.current + 1;
    channelGenerationRef.current = generation;
    messageRealtimeRef.current = { generation, ready: false };
    soundReadyGenerationRef.current = 0;
    seenMessageIdsRef.current = new Set();
    let cancelled = false;
    const isCurrent = () => !cancelled && channelGenerationRef.current === generation;
    const agentDirectoryRefresh = createTrailingRefreshScheduler(loadAgentMembers, 120);

    const resetFrame = window.requestAnimationFrame(() => {
      if (!isCurrent()) return;
      setSnapshotChannelId(null);
      setChannelLoadError("");
      setRealtimeWarning("");
      setAgentDirectoryError("");
      setMessages([]);
      setHasContent(initialDraft.trim().length > 0);
      setAgentInfo(null);
      channelAgentsRef.current = new Map();
      setChannelAgents(new Map());
      setAgentMembersLoading(true);
      setAgentTyping(false);
      pendingAgentIdsRef.current = [];
      typingStartRef.current = null;
      typingStartedAtRef.current = 0;
      setPendingAgentIds([]);
      setFailedAgentIds([]);
      setTimedOutAgentIds([]);
      setNewMessageCount(0);
      setLiveAnnouncement(null);
      setSendError("");
      setSendWarning("");
      setHasMore(true);
      setLoadingMore(false);
      loadingMoreRef.current = false;
      setOlderMessagesError("");
      void loadMessages();
      void agentDirectoryRefresh.runNow();
    });
    isNearBottomRef.current = true;
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    async function loadAgentMembers(showLoading = false) {
      const requestGeneration = agentDirectoryRequestGenerationRef.current + 1;
      agentDirectoryRequestGenerationRef.current = requestGeneration;
      agentDirectoryControllerRef.current?.abort();
      const controller = beginMessageRequest();
      agentDirectoryControllerRef.current = controller;
      const isCurrentRequest = () =>
        isCurrent() &&
        agentDirectoryRequestGenerationRef.current === requestGeneration;
      if (isCurrentRequest() && showLoading) {
        setAgentMembersLoading(true);
        setAgentDirectoryError("");
      }
      try {
        const { data: agentsData, error: agentsError } = await supabase
          .rpc('list_channel_agent_mentions', { channel_uuid: channelId })
          .abortSignal(controller.signal);
        if (!isCurrentRequest()) return;
        if (agentsError || !Array.isArray(agentsData)) {
          throw new Error(agentsError?.message || t('conversation.agentDirectoryUnavailable'));
        }

        if (agentsData.length > 0) {
          const agentMap = new Map<string, AgentInfo>();
          for (const agent of agentsData as AgentInfo[]) {
            agentMap.set(agent.id, agent);
          }
          channelAgentsRef.current = agentMap;
          setChannelAgents(agentMap);

          if (channelType === 'dm' && agentsData.length === 1) {
            setAgentInfo(agentsData[0] as AgentInfo);
          } else {
            setAgentInfo(null);
          }
        } else {
          channelAgentsRef.current = new Map();
          setChannelAgents(new Map());
          setAgentInfo(null);
        }
        setAgentDirectoryError("");
      } catch (loadError) {
        if (isCurrentRequest()) {
          channelAgentsRef.current = new Map();
          setChannelAgents(new Map());
          setAgentInfo(null);
          setMentionQuery(null);
          setAgentDirectoryError(
            controller.signal.aborted
              ? t('conversation.agentDirectoryUnavailable')
              : loadError instanceof Error
                ? loadError.message
                : t('conversation.agentDirectoryUnavailable'),
          );
        }
      } finally {
        finishMessageRequest(controller);
        if (agentDirectoryControllerRef.current === controller) {
          agentDirectoryControllerRef.current = null;
        }
        if (isCurrentRequest()) setAgentMembersLoading(false);
      }
    }

    retryAgentDirectoryRef.current = () => {
      if (!isCurrent()) return;
      setAgentMembersLoading(true);
      setAgentDirectoryError("");
      void agentDirectoryRefresh.runNow();
    };

    async function loadMessages() {
      const controller = beginMessageRequest();
      try {
        const { data, error } = await supabase
          .from('messages')
          .select('*')
          .eq('channel_id', channelId)
          .is('thread_parent_id', null)
          .order('seq', { ascending: false })
          .limit(50)
          .abortSignal(controller.signal);
        if (error || !data) {
          if (isCurrent()) {
            setChannelLoadError(
              controller.signal.aborted
                ? t('conversation.loadFailed')
                : error?.message || t('conversation.loadFailed'),
            );
          }
          return;
        }
        if (isCurrent()) {
          const reversed = (data as Message[]).reverse();
          for (const message of reversed) {
            seenMessageIdsRef.current.add(message.id);
          }
          setMessages((current) => {
            const merged = new Map(reversed.map((message) => [message.id, message]));
            for (const message of current) {
              if (message.channel_id === channelId && !merged.has(message.id)) {
                merged.set(message.id, message);
              }
            }
            return Array.from(merged.values()).sort((left, right) => {
              if (left.seq !== null && right.seq !== null) return left.seq - right.seq;
              return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
            });
          });
          setHasMore(data.length === 50);
          requestAnimationFrame(() => {
            if (!isCurrent()) return;
            const scrollElement = scrollContainerRef.current;
            if (scrollElement) scrollElement.scrollTop = scrollElement.scrollHeight;
          });
          soundReadyGenerationRef.current = generation;
          setSnapshotChannelId(channelId);
          setChannelLoadError("");
        }
        requestAnimationFrame(() => {
          if (!isCurrent()) return;
          const activeElement = document.activeElement;
          const focusIsIdle =
            activeElement === null ||
            activeElement === document.body ||
            activeElement === document.documentElement ||
            (activeElement instanceof HTMLElement && activeElement.closest('.tiptap-input'));
          if (focusIsIdle) inputRef.current?.focus();
        });
      } catch (loadError) {
        if (isCurrent()) {
          setChannelLoadError(
            controller.signal.aborted
              ? t('conversation.loadFailed')
              : loadError instanceof Error
                ? loadError.message
                : t('conversation.loadFailed'),
          );
        }
      } finally {
        finishMessageRequest(controller);
      }
    }

    const failedRealtimeSubscriptions = new Set<string>();
    const handleRealtimeStatus = (name: string, status: string) => {
      if (!isCurrent()) return;
      if (name === 'messages') {
        messageRealtimeRef.current = {
          generation,
          ready: status === 'SUBSCRIBED',
        };
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        failedRealtimeSubscriptions.add(name);
      } else if (status === 'SUBSCRIBED') {
        failedRealtimeSubscriptions.delete(name);
      }
      setRealtimeWarning(
        failedRealtimeSubscriptions.size > 0 ? t('conversation.realtimeDegraded') : '',
      );
    };

    const subscription = supabase
      .channel(`messages:${channelId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channelId}`,
        },
        (payload: { new: Message }) => {
          if (!isCurrent()) return;
          const newMsg = payload.new;
          if (newMsg.channel_id !== channelId) return;
          if (!newMsg.thread_parent_id) {
            const isNewMessage = !seenMessageIdsRef.current.has(newMsg.id);
            seenMessageIdsRef.current.add(newMsg.id);
            setMessages((prev) => {
              const existingIndex = prev.findIndex((message) => message.id === newMsg.id);
              if (existingIndex >= 0) {
                const existing = prev[existingIndex];
                if (!existing.delivery) return prev;
                const next = [...prev];
                next[existingIndex] = {
                  ...newMsg,
                  delivery: 'sent',
                  motion: existing.motion,
                };
                return next;
              }
              if (newMsg.sender_id === userIdRef.current && newMsg.sender_type === 'human') {
                let optimisticIndex = -1;
                for (let index = prev.length - 1; index >= 0; index -= 1) {
                  const message = prev[index];
                  if (message.delivery && message.content === newMsg.content) {
                    optimisticIndex = index;
                    break;
                  }
                }
                if (optimisticIndex >= 0) {
                  const next = [...prev];
                  // The optimistic row already played the send motion. Mount the
                  // confirmed row without replaying it when realtime wins the race.
                  next[optimisticIndex] = { ...newMsg, delivery: 'sent', motion: undefined };
                  return next;
                }
              }
              return [...prev, { ...newMsg, motion: 'receive' }];
            });
            if (isNewMessage) noteIncomingMessages([newMsg], generation);
            const currentUserId = userIdRef.current;
            if (
              isNewMessage &&
              soundReadyGenerationRef.current === generation &&
              currentUserId !== null &&
              newMsg.sender_type !== 'system' &&
              newMsg.sender_id !== currentUserId
            ) {
              playMessageCue('receive');
            }
            if (newMsg.sender_type === 'agent') {
              markAgentsResponded([newMsg.sender_id]);
            }
          }
        },
      )
      .subscribe((status: string) => handleRealtimeStatus('messages', status));

    const membershipSubscription = supabase
      .channel(`channel-members:${channelId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'channel_members',
          filter: `channel_id=eq.${channelId}`,
        },
        () => {
          if (isCurrent()) agentDirectoryRefresh.schedule();
        },
      )
      .subscribe((status: string) => handleRealtimeStatus('members', status));

    const agentSubscription = supabase
      .channel(`channel-agents:${channelId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'agents',
          filter: `server_id=eq.${channel.server_id}`,
        },
        (payload: { new: AgentRealtimeUpdate }) => {
          if (!isCurrent()) return;
          const update = payload.new;
          if (!channelAgentsRef.current.has(update.id)) return;
          setChannelAgents((current) => {
            const existing = current.get(update.id);
            if (!existing) return current;
            const next = new Map(current);
            next.set(update.id, patchAgentInfo(existing, update));
            channelAgentsRef.current = next;
            return next;
          });
          setAgentInfo((current) => current?.id === update.id
            ? patchAgentInfo(current, update)
            : current);
        },
      )
      .subscribe((status: string) => handleRealtimeStatus('agents', status));

    return () => {
      cancelled = true;
      agentDirectoryRefresh.cancel();
      retryAgentDirectoryRef.current = () => undefined;
      if (messageRealtimeRef.current.generation === generation) {
        messageRealtimeRef.current = { generation, ready: false };
      }
      if (channelGenerationRef.current === generation) {
        channelGenerationRef.current = generation + 1;
      }
      if (currentChannelIdRef.current === channelId) {
        currentChannelIdRef.current = null;
      }
      pendingScrollRestorationRef.current = null;
      window.cancelAnimationFrame(resetFrame);
      abortMessageRequests();
      supabase.removeChannel(subscription);
      supabase.removeChannel(membershipSubscription);
      supabase.removeChannel(agentSubscription);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- channel is memoized; only re-run when channel ID changes
  }, [channel?.id, channelReloadToken, supabase]);

  useEffect(() => {
    if (!agentTyping || !channel) return;
    const generation = channelGenerationRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollAttempt = 0;

    const poll = async () => {
      const since = typingStartRef.current;
      if (!since) return;

      let queryResult;
      try {
        queryResult = await supabase
          .from('messages')
          .select('*')
          .eq('channel_id', channel.id)
          .is('thread_parent_id', null)
          .eq('sender_type', 'agent')
          .gt('created_at', since)
          .order('created_at', { ascending: true })
          .limit(10);
      } catch {
        if (!cancelled && channelGenerationRef.current === generation) {
          setRealtimeWarning(t('conversation.realtimeDegraded'));
        }
        return;
      }
      const { data, error } = queryResult;

      if (error && !cancelled && channelGenerationRef.current === generation) {
        setRealtimeWarning(t('conversation.realtimeDegraded'));
        return;
      }

      if (
        !cancelled &&
        data &&
        data.length > 0 &&
        channelGenerationRef.current === generation
      ) {
        const freshMessages = (data as Message[]).filter((message) => {
          if (seenMessageIdsRef.current.has(message.id)) return false;
          seenMessageIdsRef.current.add(message.id);
          return true;
        });
        setMessages((prev) => {
          const updated = [...prev];
          for (const msg of data) {
            if (!updated.some((m) => m.id === msg.id)) {
              updated.push({ ...(msg as Message), motion: 'receive' });
            }
          }
          return updated.length > prev.length ? updated : prev;
        });
        noteIncomingMessages(freshMessages, generation);
        if (
          freshMessages.length > 0 &&
          soundReadyGenerationRef.current === generation
        ) {
          playMessageCue('receive');
        }
        const respondingAgentIds = new Set(
          (data as Message[]).map((message) => message.sender_id),
        );
        markAgentsResponded(respondingAgentIds);
      }
    };

    const scheduleNextPoll = () => {
      if (cancelled) return;
      const since = typingStartRef.current;
      if (!since) return;
      const elapsed = Math.max(0, Date.now() - new Date(since).getTime());
      const realtimeReady =
        messageRealtimeRef.current.generation === generation &&
        messageRealtimeRef.current.ready;
      const fallbackWindowRemaining = Math.max(0, 12_000 - elapsed);
      const backoff = Math.min(3_000 * 2 ** Math.max(0, pollAttempt - 1), 24_000);
      const delay = realtimeReady && fallbackWindowRemaining > 0
        ? fallbackWindowRemaining
        : pollAttempt === 0 && !realtimeReady
          ? 1_500
          : backoff;
      timer = setTimeout(async () => {
        const currentElapsed = Math.max(0, Date.now() - new Date(since).getTime());
        const currentRealtimeReady =
          messageRealtimeRef.current.generation === generation &&
          messageRealtimeRef.current.ready;
        if (!currentRealtimeReady || currentElapsed >= 12_000) {
          await poll();
          pollAttempt += 1;
        }
        scheduleNextPoll();
      }, delay);
    };

    scheduleNextPoll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agentTyping, channel, markAgentsResponded, noteIncomingMessages, playMessageCue, supabase, t]);

  useLayoutEffect(() => {
    if (isNearBottomRef.current) {
      const el = scrollContainerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
        setNewMessageCount(0);
      }
    }
  }, [messages, agentTyping]);

  const scrollToLatestMessage = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = true;
    setNewMessageCount(0);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, []);

  const loadOlderMessages = useCallback(async () => {
    if (!channel || loadingMoreRef.current || !hasMore || messages.length === 0) return;
    const channelId = channel.id;
    const generation = channelGenerationRef.current;
    const requestGeneration = olderMessagesRequestGenerationRef.current + 1;
    olderMessagesRequestGenerationRef.current = requestGeneration;
    const oldestSeq = messages[0]?.seq;
    if (oldestSeq === null || oldestSeq === undefined) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    const el = scrollContainerRef.current;
    const prevScrollHeight = el?.scrollHeight || 0;
    const prevScrollTop = el?.scrollTop || 0;
    const controller = beginMessageRequest();

    const isCurrent = () =>
      channelGenerationRef.current === generation &&
      currentChannelIdRef.current === channelId &&
      olderMessagesRequestGenerationRef.current === requestGeneration;
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('channel_id', channelId)
        .is('thread_parent_id', null)
        .lt('seq', oldestSeq)
        .order('seq', { ascending: false })
        .limit(50)
        .abortSignal(controller.signal);

      if (error) throw new Error(error.message || t('message.loadOlderFailed'));
      if (data && isCurrent()) {
        const older = (data as Message[]).reverse();
        for (const message of older) {
          seenMessageIdsRef.current.add(message.id);
        }
        setHasMore(data.length === 50);
        setOlderMessagesError("");
        if (older.length > 0 && el) {
          const token = scrollRestorationTokenRef.current + 1;
          scrollRestorationTokenRef.current = token;
          pendingScrollRestorationRef.current = {
            token,
            channelId,
            generation,
            previousScrollTop: prevScrollTop,
            previousScrollHeight: prevScrollHeight,
          };
        }
        setMessages((prev) => {
          const existingIds = new Set(prev.map((message) => message.id));
          return [...older.filter((message) => !existingIds.has(message.id)), ...prev];
        });
      }
    } catch (loadError) {
      if (isCurrent()) {
        setOlderMessagesError(
          controller.signal.aborted
            ? t('message.loadOlderFailed')
            : loadError instanceof Error
              ? loadError.message
              : t('message.loadOlderFailed'),
        );
      }
    } finally {
      finishMessageRequest(controller);
      if (isCurrent()) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [beginMessageRequest, channel, finishMessageRequest, hasMore, messages, supabase, t]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottomRef.current) setNewMessageCount(0);
    if (el.scrollTop < 100 && hasMore && !loadingMore && !olderMessagesError) {
      loadOlderMessages();
    }
  }, [hasMore, loadingMore, loadOlderMessages, olderMessagesError]);

  const resolveMessageTargets = useCallback((content: string): MessageTargets => {
    if (channel?.type === 'dm' && agentInfo) {
      const isOnline = agentInfo.status === 'online' || agentInfo.status === 'active';
      return {
        addressedAgentIds: [agentInfo.id],
        targetedAgentIds: isOnline ? [agentInfo.id] : [],
        offlineTargetNames: isOnline ? [] : [agentInfo.display_name],
      };
    }

    if (!channel || channelAgents.size === 0) {
      return { addressedAgentIds: [], targetedAgentIds: [], offlineTargetNames: [] };
    }

    const agents = Array.from(channelAgents.values());
    const stableNameOwners = new Map<string, Set<string>>();
    const displayNameCounts = new Map<string, number>();
    for (const agent of agents) {
      const stableKey = agent.name.toLowerCase();
      const stableOwners = stableNameOwners.get(stableKey) || new Set<string>();
      stableOwners.add(agent.id);
      stableNameOwners.set(stableKey, stableOwners);
      const displayKey = agent.display_name.toLowerCase();
      displayNameCounts.set(displayKey, (displayNameCounts.get(displayKey) || 0) + 1);
    }
    const hasMention = (value: string) => new RegExp(
      `@${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,.:!?，。！？、；]|$)`,
      'i',
    ).test(content);
    const addressedAgents = agents.filter((agent) => {
      const stableOwners = stableNameOwners.get(agent.name.toLowerCase());
      if (stableOwners?.size === 1 && hasMention(agent.name)) return true;
      const displayKey = agent.display_name.toLowerCase();
      const displayStableOwners = stableNameOwners.get(displayKey);
      return displayNameCounts.get(displayKey) === 1 &&
        (!displayStableOwners ||
          (displayStableOwners.size === 1 && displayStableOwners.has(agent.id))) &&
        hasMention(agent.display_name);
    });

    return {
      addressedAgentIds: addressedAgents.map((agent) => agent.id),
      targetedAgentIds: addressedAgents
        .filter((agent) => agent.status === 'online' || agent.status === 'active')
        .map((agent) => agent.id),
      offlineTargetNames: addressedAgents
        .filter((agent) => agent.status !== 'online' && agent.status !== 'active')
        .map((agent) => agent.display_name),
    };
  }, [agentInfo, channel, channelAgents]);

  const findPersistedMessage = useCallback(async (
    messageId: string,
    channelId: string,
  ): Promise<Message | null> => {
    const controller = beginMessageRequest();
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('id', messageId)
        .eq('channel_id', channelId)
        .single()
        .abortSignal(controller.signal);
      if (error || !data) return null;
      return data as Message;
    } catch {
      return null;
    } finally {
      finishMessageRequest(controller);
    }
  }, [beginMessageRequest, finishMessageRequest, supabase]);

  const deliverMessage = useCallback(async (
    outgoing: Message,
    targets: MessageTargets,
    retrying = false,
  ) => {
    const sendChannelId = outgoing.channel_id;
    const sendGeneration = channelGenerationRef.current;
    const isCurrentSend = () =>
      currentChannelIdRef.current === sendChannelId &&
      channelGenerationRef.current === sendGeneration;

    setMessages((current) => current.map((message) => message.id === outgoing.id
      ? { ...message, delivery: 'pending', deliveryError: undefined }
      : message));

    const finishDelivery = (inserted: Message) => {
      if (!isCurrentSend()) return;
      seenMessageIdsRef.current.add(inserted.id);
      clearAgentFeedback(targets.addressedAgentIds);
      setMessages((current) => current.map((message) => message.id === outgoing.id
        ? {
            ...inserted,
            profiles: null,
            delivery: 'sent',
            motion: message.motion,
          }
        : message));
      setSendError('');
      playMessageCue('send');
      if (targets.offlineTargetNames.length > 0) {
        setSendWarning(t('message.mentionedAgentsOffline', {
          names: targets.offlineTargetNames.join(', '),
        }));
      }
      if (targets.targetedAgentIds.length > 0) {
        startWaitingForAgents(targets.targetedAgentIds, inserted.created_at);
      }
    };

    if (retrying) {
      const existing = await findPersistedMessage(outgoing.id, sendChannelId);
      if (existing) {
        finishDelivery(existing);
        return;
      }
    }

    const controller = beginMessageRequest();
    try {
      const { data: inserted, error: insertError } = await supabase
        .from('messages')
        .insert({
          id: outgoing.id,
          channel_id: sendChannelId,
          sender_id: outgoing.sender_id,
          sender_type: 'human',
          content: outgoing.content,
        })
        .select()
        .single()
        .abortSignal(controller.signal);

      if (insertError || !inserted) {
        throw new Error(insertError?.message || t('message.sendFailed'));
      }
      finishDelivery(inserted as Message);
    } catch (error) {
      const existing = isCurrentSend()
        ? await findPersistedMessage(outgoing.id, sendChannelId)
        : null;
      if (existing) {
        finishDelivery(existing);
        return;
      }
      if (!isCurrentSend()) return;
      const reason = controller.signal.aborted
        ? t('message.sendTimedOut')
        : error instanceof Error
          ? error.message
          : t('message.sendFailed');
      setMessages((current) => current.map((message) => message.id === outgoing.id
        ? { ...message, delivery: 'failed', deliveryError: reason }
        : message));
      setSendError(t('message.sendFailedInline'));
    } finally {
      finishMessageRequest(controller);
    }
  }, [
    beginMessageRequest,
    clearAgentFeedback,
    findPersistedMessage,
    finishMessageRequest,
    playMessageCue,
    startWaitingForAgents,
    supabase,
    t,
  ]);

  const doSend = useCallback((markdown: string) => {
    const content = markdown.trim();
    if (!content || !channel) return false;
    if (!userId) {
      setSendError(identityError || t('message.agentLoading'));
      return false;
    }
    if (snapshotChannelId !== channel.id) {
      setSendError(t('message.agentLoading'));
      return false;
    }
    if (channel.type === 'dm' && (agentMembersLoading || agentDirectoryError)) {
      setSendError(
        agentDirectoryError
          ? t('conversation.agentDirectoryUnavailable')
          : t('message.agentLoading'),
      );
      return false;
    }
    if (channel.type === 'dm' && !agentInfo) {
      setSendError(t('message.agentUnavailable'));
      return false;
    }

    const optimisticMessage: Message = {
      id: globalThis.crypto.randomUUID(),
      channel_id: channel.id,
      content,
      sender_id: userId,
      sender_type: 'human',
      seq: null,
      created_at: new Date().toISOString(),
      thread_parent_id: null,
      profiles: null,
      motion: 'send',
      delivery: 'pending',
    };
    const targets = resolveMessageTargets(content);
    setSendError('');
    setSendWarning('');
    setMentionQuery(null);
    setHasContent(false);
    isNearBottomRef.current = true;
    setNewMessageCount(0);
    setMessages((current) => [...current, optimisticMessage]);
    if (draftSaveTimeoutRef.current) {
      clearTimeout(draftSaveTimeoutRef.current);
      draftSaveTimeoutRef.current = null;
    }
    latestDraftRef.current = '';
    persistDraft(draftStorageKey, '');
    void deliverMessage(optimisticMessage, targets);
    return true;
  }, [
    agentDirectoryError,
    agentInfo,
    agentMembersLoading,
    channel,
    deliverMessage,
    draftStorageKey,
    identityError,
    resolveMessageTargets,
    snapshotChannelId,
    t,
    userId,
  ]);

  const retryMessageDelivery = useCallback((messageId: string) => {
    const outgoing = messages.find((message) =>
      message.id === messageId && message.delivery === 'failed');
    if (!outgoing || outgoing.channel_id !== channel?.id) return;
    setSendError('');
    setSendWarning('');
    void deliverMessage(outgoing, resolveMessageTargets(outgoing.content), true);
  }, [channel?.id, deliverMessage, messages, resolveMessageTargets]);

  const commitMention = useCallback((handle: string) => {
    if (mentionQuery === null) return;
    inputRef.current?.replaceMention(mentionQuery, `@${handle} `);
    setMentionQuery(null);
    setMentionIndex(0);
    inputRef.current?.focus();
  }, [mentionQuery]);

  const handleMentionMouseDown = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const handle = event.currentTarget.dataset.agentHandle;
    if (handle) commitMention(handle);
  }, [commitMention]);

  const retryTimedOutResponses = useCallback(() => {
    const retryableAgentIds = timedOutAgentIds.filter((agentId) =>
      channelAgents.has(agentId) || agentInfo?.id === agentId,
    );
    setTimedOutAgentIds([]);
    if (retryableAgentIds.length === 0) {
      typingStartRef.current = null;
      return;
    }
    startWaitingForAgents(retryableAgentIds, typingStartRef.current || undefined);
  }, [agentInfo?.id, channelAgents, startWaitingForAgents, timedOutAgentIds]);

  if (!channel) {
    return (
      <div className="flex flex-1 items-center justify-center bg-card">
        <div className="text-center">
          <div className="mb-4 text-5xl font-light text-muted-foreground/20">T</div>
          <p className="text-sm text-muted-foreground">{t('conversation.select')}</p>
        </div>
      </div>
    );
  }

  if (snapshotChannelId !== channel.id) {
    return (
      <div className="flex flex-1 items-center justify-center bg-card px-6">
        <div className="max-w-sm text-center">
          <p
            className={channelLoadError ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
            role={channelLoadError ? 'alert' : 'status'}
          >
            {channelLoadError ? t('conversation.loadFailed') : t('conversation.loading')}
          </p>
          {channelLoadError && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2"
              title={channelLoadError}
              onClick={() => setChannelReloadToken((token) => token + 1)}
            >
              {t('runtime.retry')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  function getSenderName(msg: Message) {
    if (msg.sender_type === 'system') return t('message.system');
    if (msg.sender_type === 'agent') {
      const agent = channelAgents.get(msg.sender_id);
      return agent?.display_name || agentInfo?.display_name || t('message.agent');
    }
    if (msg.profiles?.display_name) return msg.profiles.display_name;
    if (msg.sender_id === currentProfile?.id) return currentProfile.display_name;
    return t('message.you');
  }

  const visibleFailedAgentIds = Array.from(new Set([
    ...failedAgentIds,
    ...pendingAgentIds.filter(
      (agentId) => getChannelActivity(agentId)?.activity === 'error',
    ),
  ]));
  const newMessageLabel = newMessageCount === 1
    ? t('message.newMessage')
    : t('message.newMessages', { count: String(newMessageCount) });

  const composerPlaceholder =
    channel.type === 'dm'
      ? t('message.agentPlaceholder', {
          name: agentInfo?.display_name || channel.name || t('message.agent'),
        })
      : t('message.channelPlaceholder', { name: channel.name });

  return (
    <div className="flex flex-1 flex-col bg-card max-w-full text-pretty">
      {/* Channel header */}
      <div
        className="flex items-center gap-3 border-b-[0.5px] py-2 px-3 select-none"
        data-tauri-drag-region="deep">
        {channel.type === 'dm' && agentInfo ? (
          <>
            <div className="pointer-events-none relative size-8">
              <GeneratedAvatar
                id={agentInfo.id}
                name={agentInfo.display_name}
                size="md"
                avatarUrl={agentInfo.avatar_url}
              />
              {(() => {
                const act = getChannelActivity(agentInfo.id);
                const isActive = act?.activity === 'thinking' || act?.activity === 'working';
                const isOnline = agentInfo.status === 'online' || agentInfo.status === 'active';
                const dotColor = act?.activity === 'error'
                  ? 'bg-destructive'
                  : isActive
                    ? 'bg-success animate-status-pulse'
                    : isOnline
                      ? 'bg-success'
                      : agentInfo.status === 'sleeping'
                        ? 'bg-warning'
                        : 'bg-muted-foreground/55';
                return (
                  <div
                    className={`absolute bottom-0 right-0 h-2.5 w-2.5 translate-x-[2px] translate-y-[2px] rounded-full border-2 border-card ${dotColor}`}
                  />
                );
              })()}
            </div>
            <div className="pointer-events-none flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-[14px] font-semibold">{agentInfo.display_name}</h2>
                {(() => {
                  const act = getChannelActivity(agentInfo.id);
                  if (!act || act.activity === 'idle') return null;
                  if (act.activity === 'error') {
                    return (
                      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-destructive">
                        <span className="shrink-0 font-medium">{t('message.runtimeError')}</span>
                        {settings.showActivityDetails && act.detail && (
                          <span className="truncate text-muted-foreground max-w-[240px]">{act.detail}</span>
                        )}
                      </span>
                    );
                  }
                  const label = act.label || (act.activity === 'thinking' ? t('message.thinking') : t('message.working'));
                  return (
                    <span className="flex items-center gap-1.5 text-[11px] text-primary">
                      <span className="font-medium">{label}</span>
                      {settings.showActivityDetails && act.detail && (
                        <span className="text-muted-foreground truncate max-w-[200px]">{act.detail}</span>
                      )}
                    </span>
                  );
                })()}
              </div>
              {agentInfo.description && (
                <p className="text-[12px] text-muted-foreground truncate">{agentInfo.description}</p>
              )}
            </div>
            {onToggleSettings && agentInfo.is_owner && userId && (
              <Button
                onClick={() => {
                  runGuardedAction(() => onToggleSettings(showSettings ? null : {
                    id: agentInfo.id,
                    display_name: agentInfo.display_name,
                    status: agentInfo.status,
                    description: agentInfo.description,
                    avatar_url: agentInfo.avatar_url,
                    owner_id: userId,
                  }));
                }}
                variant={showSettings ? 'secondary' : 'ghost'}
                size="icon-xs"
                aria-label={t('message.agentSettings')}>
                <SettingsIcon className="size-4.5" />
              </Button>
            )}
          </>
        ) : (
          <>
            <span className="pointer-events-none text-lg text-muted-foreground">#</span>
            <div className="pointer-events-none flex-1 min-w-0">
              <h2 className="text-[14px] font-semibold">{channel.name}</h2>
              {channel.description && (
                <p className="text-[12px] text-muted-foreground truncate">{channel.description}</p>
              )}
            </div>
            {channelAgents.size > 0 && (
              <div className="pointer-events-none flex items-center gap-1">
                {Array.from(channelAgents.values()).map((agent) => (
                  <GeneratedAvatar
                    key={agent.id}
                    id={agent.id}
                    name={agent.display_name}
                    size="xs"
                    avatarUrl={agent.avatar_url}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Messages */}
      {realtimeWarning && (
        <div className="flex items-center justify-between gap-3 border-b bg-warning/5 px-5 py-1.5 text-xs text-warning-foreground" role="status">
          <span>{realtimeWarning}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setChannelReloadToken((token) => token + 1)}
          >
            {t('runtime.retry')}
          </Button>
        </div>
      )}
      {agentMembersLoading && !agentDirectoryError && (
        <div
          className="border-b bg-muted/25 px-5 py-1.5 text-xs text-muted-foreground"
          role="status"
        >
          {t('conversation.agentDirectoryLoading')}
        </div>
      )}
      {agentDirectoryError && (
        <div
          className="flex items-center justify-between gap-3 border-b bg-warning/5 px-5 py-1.5 text-xs text-warning-foreground"
          role="status"
          title={agentDirectoryError}
        >
          <span>{t('conversation.agentDirectoryUnavailable')}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => retryAgentDirectoryRef.current()}
          >
            {t('runtime.retry')}
          </Button>
        </div>
      )}
      <div aria-atomic="true" aria-live="polite" className="sr-only">
        {liveAnnouncement && (
          <span key={liveAnnouncement.id}>{liveAnnouncement.text}</span>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
      <div
        aria-busy={messages.some((message) => message.delivery === 'pending')}
        className="h-full space-y-1 overflow-y-auto px-5 py-4"
        onScroll={handleScroll}
        ref={scrollContainerRef}
      >
        {loadingMore && (
          <div className="flex justify-center py-3" role="status">
            <span className="text-xs text-muted-foreground">{t('message.loadingOlder')}</span>
          </div>
        )}
        {olderMessagesError && (
          <div className="flex items-center justify-center gap-2 py-3" role="alert">
            <span className="text-xs text-destructive" title={olderMessagesError}>
              {t('message.loadOlderFailed')}
            </span>
            <Button
              onClick={() => {
                setOlderMessagesError("");
                void loadOlderMessages();
              }}
              size="xs"
              variant="ghost"
            >
              {t('message.retryOlder')}
            </Button>
          </div>
        )}
        {!hasMore && messages.length > 0 && (
          <div className="flex justify-center py-3">
            <span className="text-xs text-muted-foreground">{t('message.beginning')}</span>
          </div>
        )}
        {messages.map((msg, i) => {
          const prevMsg = messages[i - 1];
          const sameSender =
            prevMsg &&
            prevMsg.sender_id === msg.sender_id &&
            new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime() < 5 * 60 * 1000;
          return (
            <MessageRow
              agentBadgeLabel={t('message.agentBadge')}
              avatarUrl={
                msg.sender_type === 'agent'
                  ? channelAgents.get(msg.sender_id)?.avatar_url || agentInfo?.avatar_url
                  : msg.sender_id === currentProfile?.id
                    ? currentProfile.avatar_url
                    : null
              }
              key={msg.id}
              message={msg}
              deliveryFailedLabel={t('message.deliveryFailed')}
              deliveryPendingLabel={t('message.deliveryPending')}
              deliverySentLabel={t('message.deliverySent')}
              onRetryDelivery={retryMessageDelivery}
              retryDeliveryLabel={t('message.retryDelivery')}
              runtimeErrorLabel={t('message.runtimeError')}
              runtimeErrorDescription={describeRuntimeError}
              sameSender={Boolean(sameSender)}
              senderName={getSenderName(msg)}
            />
          );
        })}

        {/* Agent response indicators. A channel may have several agents working in parallel. */}
        {(() => {
          const candidates = channel.type === 'dm' && agentInfo
            ? [agentInfo]
            : Array.from(channelAgents.values());
          const indicators = candidates.flatMap((agent) => {
            const activity = getChannelActivity(agent.id);
            if (activity?.activity !== 'thinking' && activity?.activity !== 'working') return [];
            return [{
              agent,
              // Labels stay coarse observable states ("Searching web"); detail
              // carries live context — tool target, reasoning stream — and is
              // gated by the "show activity details" setting.
              label: activity.label || (activity.activity === 'working'
                ? t('message.working')
                : t('message.thinking')),
              detail: settings.showActivityDetails ? activity.detail || '' : '',
            }];
          });
          const shownAgentIds = new Set(indicators.map(({ agent }) => agent.id));

          if (agentTyping) {
            for (const agentId of pendingAgentIds) {
              if (shownAgentIds.has(agentId)) continue;
              if (getChannelActivity(agentId)?.activity === 'error') continue;
              const agent = channelAgents.get(agentId) || (agentInfo?.id === agentId ? agentInfo : null);
              if (agent) {
                indicators.push({ agent, label: t('message.thinking'), detail: '' });
                shownAgentIds.add(agentId);
              }
            }
          }

          return indicators.map(({ agent, label, detail }, index) => (
            <div
              className={`flex gap-3 px-2 py-1 ${index === 0 ? 'mt-4' : 'mt-1'}`}
              key={agent.id}
            >
              <div className="w-8 flex-shrink-0 pt-0.5">
                <GeneratedAvatar
                  id={agent.id}
                  name={agent.display_name}
                  size="md"
                  avatarUrl={agent.avatar_url}
                />
              </div>
              <div className="flex-1 min-w-0 py-1.5">
                <ThinkingIndicator label={`${agent.display_name} · ${label}`} detail={detail} />
              </div>
            </div>
          ));
        })()}

        <div ref={bottomRef} />
      </div>
      {newMessageCount > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-4">
          <Button
            aria-label={newMessageLabel}
            className="pointer-events-auto animate-message-receive shadow-lg"
            onClick={scrollToLatestMessage}
            size="sm"
            variant="secondary"
          >
            <ArrowDownIcon />
            {newMessageLabel}
          </Button>
        </div>
      )}
      </div>

      {(visibleFailedAgentIds.length > 0 || timedOutAgentIds.length > 0) && (
        <div className="space-y-2 px-4 pt-2">
          {visibleFailedAgentIds.length > 0 && (
            <Alert className="py-2.5" variant="error">
              <AlertCircleIcon />
              <AlertTitle>{t('message.responseFailedTitle')}</AlertTitle>
              <AlertDescription>{t('message.responseFailedDescription')}</AlertDescription>
              <AlertAction>
                <Button
                  onClick={() => {
                    setFailedAgentIds([]);
                    setChannelReloadToken((token) => token + 1);
                  }}
                  size="xs"
                  variant="ghost"
                >
                  {t('runtime.retry')}
                </Button>
                <Button
                  aria-label={t('message.dismiss')}
                  onClick={() => setFailedAgentIds([])}
                  size="icon-xs"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              </AlertAction>
            </Alert>
          )}
          {timedOutAgentIds.length > 0 && (
            <Alert className="py-2.5" variant="warning">
              <AlertCircleIcon />
              <AlertTitle>{t('message.responseDelayedTitle')}</AlertTitle>
              <AlertDescription>{t('message.responseDelayedDescription')}</AlertDescription>
              <AlertAction>
                <Button onClick={retryTimedOutResponses} size="xs" variant="ghost">
                  {t('runtime.retry')}
                </Button>
                <Button
                  aria-label={t('message.dismiss')}
                  onClick={() => {
                    setTimedOutAgentIds([]);
                    typingStartRef.current = null;
                  }}
                  size="icon-xs"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              </AlertAction>
            </Alert>
          )}
        </div>
      )}

      {/* Input */}
      <div className="relative px-4 pb-4 pt-2">
        {identityError && (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-lg bg-destructive/5 px-3 py-2" role="alert">
            <span className="min-w-0 truncate text-xs text-destructive" title={identityError}>
              {t('conversation.loadFailed')}
            </span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setIdentityReloadToken((token) => token + 1)}
            >
              {t('runtime.retry')}
            </Button>
          </div>
        )}
        {identityLoading && !identityError && (
          <p className="mb-2 text-xs text-muted-foreground" role="status">
            {t('message.agentLoading')}
          </p>
        )}
        {/* @mention autocomplete dropdown */}
        {mentionQuery !== null &&
          channel.type !== 'dm' &&
          (() => {
            if (!mentionOpen) return null;
            return (
              <div
                aria-label={t('message.mentionSuggestions')}
                id={mentionListboxId}
                className="absolute bottom-full left-4 right-4 mb-1 py-1 max-h-48 overflow-y-auto z-50 rounded-lg border bg-popover shadow-lg"
                role="listbox"
              >
                {mentionAgents.map((agent, i) => (
                  <button
                    aria-selected={i === mentionIndex}
                    id={`mention-option-${agent.id}`}
                    key={agent.id}
                    role="option"
                    type="button"
                    data-agent-handle={agent.name}
                    onMouseDown={handleMentionMouseDown}
                    className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] transition-colors ${
                      i === mentionIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/50'
                    }`}>
                    <GeneratedAvatar
                      id={agent.id}
                      name={agent.display_name}
                      size="xs"
                      avatarUrl={agent.avatar_url}
                    />
                    <div className="flex-1 min-w-0 text-left">
                      <div>{agent.display_name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">@{agent.name}</div>
                      {agent.description && (
                        <div className="text-[10px] text-muted-foreground truncate">{agent.description}</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            );
          })()}
        <div className="rounded-lg border bg-card shadow-xs/5 overflow-hidden focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24 transition-shadow">
          <div className="px-4 pt-3 pb-1 text-[15px] leading-[1.54]">
            <TiptapMessageInput
              key={channel.id}
              ref={inputRef}
              placeholder={composerPlaceholder}
              ariaLabel={composerPlaceholder}
              ariaControls={mentionOpen ? mentionListboxId : undefined}
              ariaExpanded={mentionOpen}
              ariaActiveDescendant={activeMentionId ? `mention-option-${activeMentionId}` : undefined}
              disabled={
                identityLoading ||
                Boolean(identityError) ||
                (channel.type === 'dm' && (
                  agentMembersLoading ||
                  Boolean(agentDirectoryError) ||
                  !agentInfo
                ))
              }
              initialContent={initialDraft}
              onSend={doSend}
              onTextUpdate={(textBeforeCursor, fullText) => {
                updateMentionFromCursor(textBeforeCursor);
                setHasContent(fullText.trim().length > 0);
                scheduleDraftSave(fullText);
              }}
              onSelectionUpdate={updateMentionFromCursor}
              onKeyDown={(event) => {
                if (mentionQuery !== null && channel.type !== 'dm') {
                  if (mentionAgents.length > 0) {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      const agent = mentionAgents[mentionIndex];
                      commitMention(agent.name);
                      return true;
                    }
                    if (event.key === 'ArrowDown') {
                      setMentionIndex((prev) => (prev + 1) % mentionAgents.length);
                      return true;
                    }
                    if (event.key === 'ArrowUp') {
                      setMentionIndex((prev) => (prev - 1 + mentionAgents.length) % mentionAgents.length);
                      return true;
                    }
                    if (event.key === 'Tab') {
                      const agent = mentionAgents[mentionIndex];
                      commitMention(agent.name);
                      return true;
                    }
                    if (event.key === 'Escape') {
                      setMentionQuery(null);
                      return true;
                    }
                  }
                }
                return false;
              }}
            />
          </div>
          {sendError && (
            <p role="alert" className="px-4 pb-2 text-xs text-destructive">
              {sendError}
            </p>
          )}
          {sendWarning && (
            <p role="status" className="px-4 pb-2 text-xs text-warning-foreground">
              {sendWarning}
            </p>
          )}
          <div className="flex items-center justify-end px-2.5 pb-2.5">
            <Button
              type="button"
              onClick={() => {
                const md = inputRef.current?.getMarkdown() ?? '';
                if (md.trim() && doSend(md)) inputRef.current?.clear();
              }}
              disabled={
                identityLoading ||
                Boolean(identityError) ||
                !hasContent ||
                (channel.type === 'dm' && (
                  agentMembersLoading ||
                  Boolean(agentDirectoryError) ||
                  !agentInfo
                ))
              }
              size="sm">
              {t('message.send')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
