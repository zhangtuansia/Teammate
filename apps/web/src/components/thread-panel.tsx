'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { XIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAppSettings } from '@/hooks/use-app-settings';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SafeMarkdown } from '@/components/ui/safe-markdown';
import TiptapMessageInput, {
  type TiptapMessageInputHandle,
} from './tiptap-message-input';
import { GeneratedAvatar } from './generated-avatar';

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
  pending?: boolean;
}

interface ThreadPanelProps {
  channelId: string;
  channelLabel: string;
  parent: ThreadMessage;
  userId: string | null;
  /** Resolved from the channel roster the message list already loaded. */
  identityFor: (senderId: string, message?: ThreadMessage) => {
    name: string;
    url: string | null;
  };
  onClose: () => void;
  /** Lets the parent keep the channel's reply counts in step with the panel. */
  onRepliesChanged: (parentId: string, replies: ThreadMessage[]) => void;
}

function ThreadRow({
  identityFor,
  message,
  sameSender,
}: {
  identityFor: ThreadPanelProps['identityFor'];
  message: ThreadMessage;
  sameSender: boolean;
}) {
  const who = identityFor(message.sender_id, message);
  const time = new Date(message.created_at).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <div
      className={`group flex gap-2 rounded-lg px-2 py-0.5 transition-colors hover:bg-accent/40 ${
        sameSender ? '' : 'mt-3 first:mt-0'
      } ${message.pending ? 'opacity-60' : ''}`}
    >
      <div className="w-9 shrink-0 pt-0.5">
        {sameSender ? (
          <time
            className="hidden pt-px text-right text-[11px] leading-[22px] text-muted-foreground tabular-nums group-hover:block"
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
            <span className="text-[15px] font-bold leading-[22px]">{who.name}</span>
            <span className="text-xs text-muted-foreground">{time}</span>
          </div>
        )}
        <div
          className="prose-message wrap-break-word text-[15px] subpixel-antialiased"
          style={{ lineHeight: '22px' }}
        >
          <SafeMarkdown mentions>
            {message.content}
          </SafeMarkdown>
        </div>
      </div>
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
  parent,
  userId,
  identityFor,
  onClose,
  onRepliesChanged,
}: ThreadPanelProps) {
  const supabase = createClient();
  const { t } = useAppSettings();
  const [replies, setReplies] = useState<ThreadMessage[]>([]);
  const [loadError, setLoadError] = useState('');
  const [sendError, setSendError] = useState('');
  const [alsoSend, setAlsoSend] = useState(false);
  const composerRef = useRef<TiptapMessageInputHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const repliesRef = useRef<ThreadMessage[]>([]);
  const notifyRef = useRef(onRepliesChanged);
  useEffect(() => {
    notifyRef.current = onRepliesChanged;
  }, [onRepliesChanged]);

  const applyReplies = useCallback(
    (next: ThreadMessage[]) => {
      repliesRef.current = next;
      setReplies(next);
      notifyRef.current(parent.id, next.filter((reply) => !reply.pending));
    },
    [parent.id],
  );

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
        return;
      }
      setLoadError('');
      applyReplies((data ?? []) as ThreadMessage[]);
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
          if (current.some((reply) => reply.id === incoming.id)) return;
          // Drop the optimistic row this insert confirms.
          const settled = current.filter(
            (reply) =>
              !(reply.pending && reply.content === incoming.content && reply.sender_id === incoming.sender_id),
          );
          applyReplies([...settled, incoming]);
        },
      )
      .subscribe();

    return () => {
      active = false;
      void supabase.removeChannel(subscription);
    };
  }, [applyReplies, channelId, parent.id, supabase, t]);

  useEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [replies.length]);

  useEffect(() => {
    composerRef.current?.focus();
  }, [parent.id]);

  const send = useCallback(
    (markdown: string) => {
      const content = markdown.trim();
      if (!content || !userId) return false;
      const broadcast = alsoSend;
      const optimistic: ThreadMessage = {
        id: globalThis.crypto.randomUUID(),
        channel_id: channelId,
        content,
        created_at: new Date().toISOString(),
        pending: true,
        sender_id: userId,
        sender_type: 'human',
        thread_broadcast: broadcast,
        thread_parent_id: parent.id,
      };
      setSendError('');
      applyReplies([...repliesRef.current, optimistic]);
      void (async () => {
        const { data, error } = await supabase
          .from('messages')
          .insert({
            channel_id: channelId,
            content,
            id: optimistic.id,
            sender_id: userId,
            sender_type: 'human',
            thread_broadcast: broadcast,
            thread_parent_id: parent.id,
          })
          .select()
          .single();
        if (error) {
          setSendError(t('message.sendFailedInline'));
          applyReplies(repliesRef.current.filter((reply) => reply.id !== optimistic.id));
          return;
        }
        applyReplies(
          repliesRef.current.map((reply) =>
            reply.id === optimistic.id ? (data as ThreadMessage) : reply,
          ),
        );
      })();
      return true;
    },
    [alsoSend, applyReplies, channelId, parent.id, supabase, t, userId],
  );

  return (
    // flex-1 rather than w-full below lg: two width utilities on one element
    // race in the cascade, and flex-basis does not fight the fixed width above.
    <aside className="flex flex-1 flex-col border-l-[0.5px] bg-card lg:w-[400px] lg:flex-none">
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

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" ref={scrollRef}>
        <ThreadRow identityFor={identityFor} message={parent} sameSender={false} />
        <div className="my-3 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {replies.length === 0
              ? t('message.thread.empty')
              : replies.length === 1
                ? t('message.thread.oneReply')
                : t('message.thread.replyCount', { count: String(replies.length) })}
          </span>
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
        </div>
        {loadError && (
          <p className="px-2 text-xs text-destructive" role="alert">
            {loadError}
          </p>
        )}
        {replies.map((reply, index) => {
          const previous = replies[index - 1];
          const sameSender =
            Boolean(previous) &&
            previous.sender_id === reply.sender_id &&
            new Date(reply.created_at).getTime() - new Date(previous.created_at).getTime() <
              5 * 60 * 1000;
          return (
            <ThreadRow
              identityFor={identityFor}
              key={reply.id}
              message={reply}
              sameSender={sameSender}
            />
          );
        })}
      </div>

      <div className="border-t-[0.5px] p-3">
        <div className="rounded-xl border bg-background px-3 py-2 focus-within:border-ring">
          <TiptapMessageInput
            ariaLabel={t('message.thread.placeholder')}
            onSend={send}
            placeholder={t('message.thread.placeholder')}
            ref={composerRef}
          />
        </div>
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={alsoSend} onCheckedChange={(next) => setAlsoSend(next === true)} />
          {t('message.thread.alsoSend', { channel: channelLabel })}
        </label>
        {sendError && (
          <p className="mt-1.5 text-xs text-destructive" role="alert">
            {sendError}
          </p>
        )}
      </div>
    </aside>
  );
}
