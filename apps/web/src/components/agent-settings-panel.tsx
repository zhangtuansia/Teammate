'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  X,
  Save as FloppyDisk,
  RotateCcw as ArrowCounterClockwise,
  Trash2 as Trash,
  Zap as Lightning,
  Settings as GearSix,
  FolderOpen,
  File,
  Folder,
  Copy,
  RefreshCw as ArrowClockwise,
  Eye,
  Upload as UploadSimple,
  CircleAlert,
} from 'lucide-react';
import { SafeMarkdown } from '@/components/ui/safe-markdown';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTab, TabsPanel } from '@/components/ui/tabs';
import { Field, FieldLabel } from '@/components/ui/field';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { apiUrl } from '@/lib/api-url';
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from '@/components/ui/select';
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel } from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Sheet, SheetPopup, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  CODEX_MODEL_ITEMS,
  normalizeAgentRuntime,
  resolveAgentRuntimeSelection,
  runtimeSelectionIssueMessage,
  type AgentRuntimeId,
} from '@/lib/agent-runtime';
import {
  installedAgentRuntimeIds,
  loadAgentRuntimes,
  type AgentRuntimeStatus,
} from '@/lib/agent-runtime-status';
import {
  loadModelConnections,
  type ModelConnection,
} from '@/lib/model-connections';
import { agentProviderItems } from '@/lib/model-provider-registry';
import { AGENT_AVATAR_PRESETS } from '@/lib/agent-avatar';
import { useAppSettings, type ThinkingLevel } from '@/hooks/use-app-settings';
import {
  useUnsavedChangesGuard,
  useWorkspaceNavigation,
} from '@/hooks/use-navigation-guard';
import { useWorkspaceServer } from '@/components/workspace-server-context';
import { useMediaQuery } from '@/hooks/use-media-query';
import { GeneratedAvatar } from './generated-avatar';

interface AgentInfo {
  id: string;
  display_name: string;
  status: string;
  description: string | null;
  avatar_url: string | null;
  owner_id: string;
}

interface AgentFull {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  system_prompt: string | null;
  runtime: AgentRuntimeId;
  model: string;
  connection_id: string | null;
  thinking_level?: ThinkingLevel | null;
  status: string;
  avatar_url: string | null;
  owner_id: string;
}

interface AgentSettingsBaseline {
  agentId: string;
  displayName: string;
  description: string;
  runtime: AgentRuntimeId;
  model: string;
  connectionId: string | null;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  avatarUrl: string | null;
}

function settingsBaselineFromAgent(agent: AgentFull): AgentSettingsBaseline {
  const runtime = normalizeAgentRuntime(agent.runtime);
  return {
    agentId: agent.id,
    displayName: agent.display_name,
    description: agent.description || '',
    runtime,
    model: typeof agent.model === 'string' ? agent.model.trim() : '',
    connectionId: agent.connection_id || null,
    thinkingLevel: agent.thinking_level === 'low' || agent.thinking_level === 'high'
      ? agent.thinking_level
      : 'medium',
    systemPrompt: agent.system_prompt || '',
    avatarUrl: agent.avatar_url || null,
  };
}

interface Skill {
  name: string;
  description: string;
}

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
}

const MODEL_ITEMS = [
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

const SKILLS_SOURCE_BY_RUNTIME: Record<AgentRuntimeId, string> = {
  'claude-code': '~/.claude/skills/',
  codex: '~/.codex/skills/',
  pi: '~/.pi/agent/skills/',
};

function isSkillList(value: unknown): value is Skill[] {
  return Array.isArray(value) && value.every((entry) => (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as Record<string, unknown>).name === 'string' &&
    typeof (entry as Record<string, unknown>).description === 'string'
  ));
}

type BridgeRpcFn = (
  action: string,
  extra?: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

interface BridgeRpcConnection {
  requestChannel: RealtimeChannel;
  responseChannel: RealtimeChannel;
  ready: Promise<boolean>;
  state: () => 'connecting' | 'ready' | 'failed';
  close: () => void;
}

interface OwnerVerification {
  agentId: string;
  ownerId: string;
  allowed: boolean;
}

export function AgentSettingsPanel({
  agent,
  onClose,
  onDeleted,
  onUpdated,
}: {
  agent: AgentInfo;
  onClose: () => void;
  onDeleted: () => void;
  onUpdated: (updated: AgentInfo) => void;
}) {
  const { t } = useAppSettings();
  const { id: serverId } = useWorkspaceServer();
  const { run } = useWorkspaceNavigation();
  const isNarrowPanel = useMediaQuery('(max-width: 1100px)');
  const [activeTab, setActiveTab] = useState<'settings' | 'workspace'>('settings');
  const [ownerVerification, setOwnerVerification] = useState<OwnerVerification | null>(null);
  const [ownerVerificationAttempt, setOwnerVerificationAttempt] = useState(0);
  const rpcConnectionRef = useRef<BridgeRpcConnection | null>(null);
  const rpcCallbacksRef = useRef(new Map<string, (payload: Record<string, unknown>) => void>());
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const ownerAccessAllowed = ownerVerification?.agentId === agent.id &&
    ownerVerification.ownerId === agent.owner_id &&
    ownerVerification.allowed;

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    return () => {
      const returnTarget = returnFocusRef.current;
      window.requestAnimationFrame(() => {
        if (returnTarget?.isConnected) returnTarget.focus();
      });
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const timeout = setTimeout(() => {
      if (cancelled || settled) return;
      settled = true;
      setOwnerVerification({ agentId: agent.id, ownerId: agent.owner_id, allowed: false });
    }, 8000);

    void createClient().auth.getUser()
      .then((result: { data: { user: { id: string } | null }; error: unknown }) => {
        if (cancelled || settled) return;
        settled = true;
        clearTimeout(timeout);
        const { data, error } = result;
        setOwnerVerification({
          agentId: agent.id,
          ownerId: agent.owner_id,
          allowed: !error && data.user?.id === agent.owner_id,
        });
      })
      .catch(() => {
        if (!cancelled && !settled) {
          settled = true;
          clearTimeout(timeout);
          setOwnerVerification({ agentId: agent.id, ownerId: agent.owner_id, allowed: false });
        }
      });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [agent.id, agent.owner_id, ownerVerificationAttempt]);

  useEffect(() => {
    if (!ownerAccessAllowed) return;
    const callbacks = rpcCallbacksRef.current;
    return () => {
      const connection = rpcConnectionRef.current;
      rpcConnectionRef.current = null;
      connection?.close();
      for (const callback of callbacks.values()) {
        callback({ error: 'bridge_offline' });
      }
      callbacks.clear();
    };
  }, [agent.owner_id, ownerAccessAllowed, serverId]);

  const openRpcConnection = useCallback((): BridgeRpcConnection => {
    const supabase = createClient();
    const callbacks = rpcCallbacksRef.current;
    let connectionState: 'connecting' | 'ready' | 'failed' = 'connecting';
    let closed = false;
    let requestSubscribed = false;
    let responseSubscribed = false;
    let readySettled = false;
    let readyTimeout: ReturnType<typeof setTimeout> | null = null;
    let resolveReady: (ready: boolean) => void = () => undefined;
    const ready = new Promise<boolean>((resolve) => {
      resolveReady = (value) => {
        if (readySettled) return;
        readySettled = true;
        resolve(value);
      };
    });

    const rejectPendingRequests = () => {
      for (const callback of callbacks.values()) {
        callback({ error: 'bridge_offline' });
      }
      callbacks.clear();
    };

    const markFailed = () => {
      if (connectionState === 'failed') return;
      connectionState = 'failed';
      if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = null;
      }
      resolveReady(false);
      rejectPendingRequests();
    };

    const handleSubscriptionStatus = (
      direction: 'request' | 'response',
      status: string,
    ) => {
      if (closed || connectionState === 'failed') return;
      if (status === 'SUBSCRIBED') {
        if (direction === 'request') requestSubscribed = true;
        else responseSubscribed = true;
        if (requestSubscribed && responseSubscribed) {
          connectionState = 'ready';
          if (readyTimeout) {
            clearTimeout(readyTimeout);
            readyTimeout = null;
          }
          resolveReady(true);
        }
        return;
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        markFailed();
      }
    };

    const requestChannel = supabase
      .channel(`bridge-rpc-request:${serverId}:${agent.owner_id}`, {
        config: {
          private: true,
          broadcast: { ack: true, self: false },
        },
      })
      .subscribe((status: string) => handleSubscriptionStatus('request', status));

    const responseChannel = supabase
      .channel(`bridge-rpc-response:${serverId}:${agent.owner_id}`, {
        config: {
          private: true,
          broadcast: { ack: true, self: false },
        },
      })
      .on('broadcast', { event: 'rpc:response' }, ({ payload }: { payload: Record<string, unknown> }) => {
        if (
          connectionState !== 'ready' ||
          typeof payload.requestId !== 'string' ||
          payload.serverId !== serverId ||
          payload.ownerId !== agent.owner_id
        ) return;

        const cb = callbacks.get(payload.requestId);
        if (cb) {
          callbacks.delete(payload.requestId);
          cb(payload);
        }
      })
      .subscribe((status: string) => handleSubscriptionStatus('response', status));

    readyTimeout = setTimeout(markFailed, 6000);

    const connection: BridgeRpcConnection = {
      requestChannel,
      responseChannel,
      ready,
      state: () => connectionState,
      close: () => {
        if (closed) return;
        closed = true;
        connectionState = 'failed';
        if (readyTimeout) clearTimeout(readyTimeout);
        readyTimeout = null;
        resolveReady(false);
        void requestChannel.unsubscribe();
        void responseChannel.unsubscribe();
      },
    };
    return connection;
  }, [agent.owner_id, serverId]);

  const getReadyRpcConnection = useCallback(async () => {
    if (!ownerAccessAllowed) return null;
    let connection = rpcConnectionRef.current;

    if (connection?.state() === 'failed') {
      connection.close();
      if (rpcConnectionRef.current === connection) rpcConnectionRef.current = null;
      connection = null;
    }

    if (!connection) {
      connection = openRpcConnection();
      rpcConnectionRef.current = connection;
    }

    const ready = await connection.ready;
    if (
      !ready ||
      connection.state() !== 'ready' ||
      rpcConnectionRef.current !== connection
    ) {
      if (rpcConnectionRef.current === connection && connection.state() === 'failed') {
        connection.close();
        rpcConnectionRef.current = null;
      }
      return null;
    }
    return connection;
  }, [openRpcConnection, ownerAccessAllowed]);

  const bridgeRpc: BridgeRpcFn = useCallback(
    async (action, extra = {}, signal) => {
      if (signal?.aborted) throw new DOMException('RPC request aborted', 'AbortError');
      const connection = await getReadyRpcConnection();
      if (!connection) throw new Error('bridge_offline');
      if (signal?.aborted) throw new DOMException('RPC request aborted', 'AbortError');

      const requestId = crypto.randomUUID();
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        let settled = false;
        const finish = (
          outcome: { payload: Record<string, unknown> } | { error: Error },
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener('abort', handleAbort);
          if ('error' in outcome) reject(outcome.error);
          else if (outcome.payload.error) reject(new Error(String(outcome.payload.error)));
          else resolve(outcome.payload);
        };
        const timeout = setTimeout(() => {
          rpcCallbacksRef.current.delete(requestId);
          finish({ error: new Error('bridge_offline') });
        }, 8000);
        const handleAbort = () => {
          rpcCallbacksRef.current.delete(requestId);
          finish({ error: new DOMException('RPC request aborted', 'AbortError') });
        };

        rpcCallbacksRef.current.set(requestId, (payload) => {
          finish({ payload });
        });
        signal?.addEventListener('abort', handleAbort, { once: true });
        if (signal?.aborted) {
          handleAbort();
          return;
        }

        void connection.requestChannel
          .send({
            type: 'broadcast',
            event: 'rpc:request',
            payload: { ...extra, requestId, serverId, ownerId: agent.owner_id, action },
          })
          .then((status) => {
            if (status !== 'ok') {
              const callback = rpcCallbacksRef.current.get(requestId);
              if (callback) {
                rpcCallbacksRef.current.delete(requestId);
                callback({ error: 'bridge_offline' });
              }
            }
          })
          .catch(() => {
            const callback = rpcCallbacksRef.current.get(requestId);
            if (callback) {
              rpcCallbacksRef.current.delete(requestId);
              callback({ error: 'bridge_offline' });
            }
          });
      });
    },
    [agent.owner_id, getReadyRpcConnection, serverId]
  );

  const handleClose = useCallback(() => {
    run(onClose);
  }, [onClose, run]);

  const handleTabChange = useCallback((nextValue: unknown) => {
    if (nextValue !== 'settings' && nextValue !== 'workspace') return;
    if (activeTab === 'settings' && nextValue === 'workspace') {
      run(() => setActiveTab(nextValue));
      return;
    }
    setActiveTab(nextValue);
  }, [activeTab, run]);

  const handleSheetOpenChange = useCallback((open: boolean) => {
    if (!open) handleClose();
  }, [handleClose]);

  const ownerVerificationPending =
    ownerVerification === null ||
    ownerVerification.agentId !== agent.id ||
    ownerVerification.ownerId !== agent.owner_id;

  const panelContent = ownerAccessAllowed ? (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[55.5px] items-center justify-between gap-1 pl-5 pr-2">
        <TabsList variant="underline">
          <TabsTab value="settings">
            <GearSix size={14} />
            {t('agentSettings.settings')}
          </TabsTab>
          <TabsTab value="workspace">
            <FolderOpen size={14} />
            {t('agentSettings.workspace')}
          </TabsTab>
        </TabsList>
        <Button onClick={handleClose} variant="ghost" size="icon-xs" aria-label={t('agentSettings.close')}>
          <X size={18} />
        </Button>
      </div>

      <TabsPanel value="settings" className="min-h-0 flex-1 overflow-y-auto">
        <SettingsTab key={agent.id} agent={agent} onDeleted={onDeleted} onUpdated={onUpdated} bridgeRpc={bridgeRpc} />
      </TabsPanel>
      <TabsPanel value="workspace" className="min-h-0 flex-1 overflow-y-auto">
        <WorkspaceTab agentId={agent.id} bridgeRpc={bridgeRpc} />
      </TabsPanel>
    </Tabs>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[55.5px] items-center justify-between gap-3 pl-5 pr-2">
        <p className="truncate text-sm font-semibold">{t('message.agentSettings')}</p>
        <Button onClick={handleClose} variant="ghost" size="icon-xs" aria-label={t('agentSettings.close')}>
          <X size={18} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-5">
        {ownerVerificationPending ? (
          <p aria-live="polite" className="text-center text-sm text-muted-foreground" role="status">
            {t('agentSettings.verifyingAccess')}
          </p>
        ) : (
          <Alert className="max-w-sm" variant="error">
            <CircleAlert />
            <AlertTitle>{t('agentSettings.accessFailed')}</AlertTitle>
            <AlertDescription>
              <span>{t('agentSettings.accessFailedDescription')}</span>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setOwnerVerification(null);
                    setOwnerVerificationAttempt((attempt) => attempt + 1);
                  }}
                >
                  {t('agentSettings.retry')}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={handleClose}>
                  {t('agentSettings.close')}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );

  if (isNarrowPanel) {
    return (
      <Sheet open onOpenChange={handleSheetOpenChange}>
        <SheetPopup
          className="my-2 mr-2 h-[calc(100%_-_1rem)] w-[min(360px,calc(100vw_-_1rem))] max-w-none overflow-hidden rounded-xl border sm:my-0 sm:mr-0 sm:h-full"
          showCloseButton={false}
          side="right"
          variant="inset"
        >
          <SheetTitle className="sr-only">
            {t('message.agentSettings')}: {agent.display_name}
          </SheetTitle>
          {panelContent}
        </SheetPopup>
      </Sheet>
    );
  }

  return (
    <aside
      aria-label={`${t('message.agentSettings')}: ${agent.display_name}`}
      className="flex h-full w-[min(360px,calc(100vw_-_1rem))] flex-shrink-0 flex-col border-l bg-card animate-slide-in-right"
    >
      {panelContent}
    </aside>
  );
}

// ─── Settings Tab ───────────────────────────────────────────────────────────

function SettingsTab({
  agent,
  onDeleted,
  onUpdated,
  bridgeRpc,
}: {
  agent: AgentInfo;
  onDeleted: () => void;
  onUpdated: (updated: AgentInfo) => void;
  bridgeRpc: BridgeRpcFn;
}) {
  const { settings, t } = useAppSettings();
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [runtime, setRuntime] = useState<AgentRuntimeId>('codex');
  const [model, setModel] = useState('default');
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('medium');
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [runtimes, setRuntimes] = useState<AgentRuntimeStatus[] | null>(null);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [connectionsError, setConnectionsError] = useState('');
  const [connectionsReloadToken, setConnectionsReloadToken] = useState(0);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarData, setAvatarData] = useState<string | null>(null);
  const [avatarFileName, setAvatarFileName] = useState('');
  const [baseline, setBaseline] = useState<AgentSettingsBaseline | null>(null);
  const [agentReloadToken, setAgentReloadToken] = useState(0);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState('');
  const [skillsReloadToken, setSkillsReloadToken] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pendingDangerAction, setPendingDangerAction] = useState<'reset' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const agentLoadGenerationRef = useRef(0);
  const agentLoadControllerRef = useRef<AbortController | null>(null);
  const saveRequestGenerationRef = useRef(0);
  const saveRequestControllerRef = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const dangerRequestGenerationRef = useRef(0);
  const dangerRequestControllerRef = useRef<AbortController | null>(null);
  const dangerActionRef = useRef<'reset' | 'delete' | null>(null);
  const draftRevisionRef = useRef(0);
  const avatarReadGenerationRef = useRef(0);
  const savedFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skillsRequestGenerationRef = useRef(0);
  const translationRef = useRef(t);
  const localMode = process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_MODE === 'true';

  const applyBaseline = useCallback((next: AgentSettingsBaseline) => {
    draftRevisionRef.current += 1;
    avatarReadGenerationRef.current += 1;
    setDisplayName(next.displayName);
    setDescription(next.description);
    setRuntime(next.runtime);
    setModel(next.model);
    setConnectionId(next.connectionId);
    setThinkingLevel(next.thinkingLevel);
    setSystemPrompt(next.systemPrompt);
    setAvatarUrl(next.avatarUrl);
    setAvatarData(null);
    setAvatarFileName('');
  }, []);

  const markDraftChanged = useCallback(() => {
    draftRevisionRef.current += 1;
    setSaved(false);
    setSaveError('');
  }, []);

  const dirty = baseline !== null && baseline.agentId === agent.id && (
    displayName !== baseline.displayName ||
    description !== baseline.description ||
    runtime !== baseline.runtime ||
    model !== baseline.model ||
    connectionId !== baseline.connectionId ||
    thinkingLevel !== baseline.thinkingLevel ||
    systemPrompt !== baseline.systemPrompt ||
    avatarUrl !== baseline.avatarUrl ||
    avatarData !== null
  );

  const discardChanges = useCallback(() => {
    if (!baseline || baseline.agentId !== agent.id) return;
    applyBaseline(baseline);
    setSaved(false);
    setError('');
    setSaveError('');
  }, [agent.id, applyBaseline, baseline]);

  const requestBusy = saving || resetting || deleting;
  useUnsavedChangesGuard(dirty || requestBusy, discardChanges, !requestBusy);

  const loadAgent = useCallback(async (
    generation: number,
    requestedAgentId: string,
    signal: AbortSignal,
    didTimeOut: () => boolean,
  ) => {
    try {
      const response = await fetch(apiUrl(`/api/agents/${requestedAgentId}`), { signal });
      const result = (await response.json().catch(() => null)) as {
        agent?: AgentFull;
        error?: string;
      } | null;
      if (
        generation !== agentLoadGenerationRef.current
      ) return;
      if (!response.ok || !result?.agent) {
        throw new Error(
          result?.error ||
          (response.ok
            ? translationRef.current('agentSettings.error.agentMissing')
            : `HTTP ${response.status}`),
        );
      }

      const nextBaseline = settingsBaselineFromAgent(result.agent);
      setBaseline(nextBaseline);
      applyBaseline(nextBaseline);
      setError('');
      setSaveError('');
    } catch (err) {
      if (
        generation !== agentLoadGenerationRef.current ||
        (signal.aborted && !didTimeOut())
      ) return;
      const translate = translationRef.current;
      const message = didTimeOut()
        ? translate('settings.requestTimedOut')
        : err instanceof Error
          ? err.message
          : translate('agentSettings.error.unknown');
      setError(translate('agentSettings.error.loadAgent', { message }));
    } finally {
      if (
        generation === agentLoadGenerationRef.current
      ) {
        setLoading(false);
      }
    }
  }, [applyBaseline]);

  useEffect(() => {
    translationRef.current = t;
  }, [t]);

  const loadSkills = useCallback(async (
    requestedRuntime: AgentRuntimeId,
    generation: number,
    signal: AbortSignal
  ) => {
    const isCurrentRequest = () => generation === skillsRequestGenerationRef.current;

    if (isCurrentRequest()) {
      setSkills([]);
      setSkillsLoading(true);
      setSkillsError('');
    }

    let apiError: Error | null = null;

    try {
      if (localMode) {
        const requestController = new AbortController();
        let requestTimedOut = false;
        const abortRequest = () => requestController.abort();
        signal.addEventListener('abort', abortRequest, { once: true });
        const requestTimeout = setTimeout(() => {
          requestTimedOut = true;
          requestController.abort();
        }, 8000);
        try {
          const res = await fetch(
            apiUrl(`/api/skills?runtime=${encodeURIComponent(requestedRuntime)}`),
            { signal: requestController.signal },
          );
          const data = (await res.json().catch(() => null)) as {
            skills?: unknown;
            error?: string;
          } | null;

          if (!res.ok) {
            throw new Error(data?.error || t('agentSettings.error.requestStatus', { status: String(res.status) }));
          }
          if (!data) throw new Error(t('agentSettings.error.skillsInvalid'));
          if (!isSkillList(data.skills)) throw new Error(t('agentSettings.error.skillsInvalid'));

          if (isCurrentRequest()) {
            setSkills(data.skills);
          }
          return;
        } catch (err) {
          if (signal.aborted) return;
          apiError = requestTimedOut
            ? new Error(t('settings.requestTimedOut'))
            : err instanceof Error
              ? err
              : new Error(t('agentSettings.error.unknown'));
        } finally {
          clearTimeout(requestTimeout);
          signal.removeEventListener('abort', abortRequest);
        }
      }

      try {
        const rpcData = await bridgeRpc('skills:list', { runtime: requestedRuntime }, signal);
        if (!isSkillList(rpcData.skills)) {
          throw new Error(t('agentSettings.error.skillsInvalid'));
        }
        if (isCurrentRequest()) {
          setSkills(rpcData.skills);
        }
      } catch (err) {
        if (!isCurrentRequest()) return;
        setSkills([]);
        const rpcError = err instanceof Error ? err.message : '';
        if (rpcError && rpcError !== 'bridge_offline') {
          setSkillsError(t('agentSettings.error.loadSkills', { message: rpcError }));
        } else if (apiError?.message) {
          setSkillsError(t('agentSettings.error.loadSkills', { message: apiError.message }));
        } else {
          setSkillsError(t('agentSettings.error.skillsOffline'));
        }
      }
    } finally {
      if (isCurrentRequest()) setSkillsLoading(false);
    }
  }, [bridgeRpc, localMode, t]);

  useEffect(() => {
    const generation = ++agentLoadGenerationRef.current;
    const requestedAgentId = agent.id;
    const controller = new AbortController();
    agentLoadControllerRef.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10_000);
    const frame = window.requestAnimationFrame(() => {
      void loadAgent(generation, requestedAgentId, controller.signal, () => timedOut)
        .finally(() => {
          clearTimeout(timeout);
          if (agentLoadControllerRef.current === controller) {
            agentLoadControllerRef.current = null;
          }
        });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      clearTimeout(timeout);
      controller.abort();
      if (agentLoadControllerRef.current === controller) {
        agentLoadControllerRef.current = null;
      }
      if (savedFeedbackTimerRef.current) {
        clearTimeout(savedFeedbackTimerRef.current);
        savedFeedbackTimerRef.current = null;
      }
      saveRequestGenerationRef.current += 1;
      saveRequestControllerRef.current?.abort();
      saveRequestControllerRef.current = null;
      savingRef.current = false;
      dangerRequestGenerationRef.current += 1;
      dangerRequestControllerRef.current?.abort();
      dangerRequestControllerRef.current = null;
      dangerActionRef.current = null;
      avatarReadGenerationRef.current += 1;
      if (agentLoadGenerationRef.current === generation) {
        agentLoadGenerationRef.current += 1;
      }
    };
  }, [agent.id, agentReloadToken, loadAgent]);

  useEffect(() => {
    if (!localMode) return;
    let cancelled = false;
    const controller = new AbortController();
    const frame = window.requestAnimationFrame(() => {
      setConnectionsLoading(true);
      setConnectionsError('');
      setRuntimes(null);
      void Promise.all([
        loadModelConnections(controller.signal),
        loadAgentRuntimes(controller.signal),
      ])
        .then(([nextConnections, nextRuntimes]) => {
          if (!cancelled) {
            setConnections(nextConnections);
            setRuntimes(nextRuntimes);
          }
        })
        .catch((loadError: unknown) => {
          if (cancelled || (loadError instanceof Error && loadError.name === 'AbortError')) return;
          setConnections([]);
          setRuntimes(null);
          setConnectionsError(t('agentSettings.error.loadConnections'));
        })
        .finally(() => {
          if (!cancelled) setConnectionsLoading(false);
        });
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      controller.abort();
    };
  }, [connectionsReloadToken, localMode, t]);

  useEffect(() => {
    const generation = ++skillsRequestGenerationRef.current;
    const controller = new AbortController();
    const frame = window.requestAnimationFrame(() => void loadSkills(runtime, generation, controller.signal));

    return () => {
      window.cancelAnimationFrame(frame);
      controller.abort();
      if (skillsRequestGenerationRef.current === generation) {
        skillsRequestGenerationRef.current += 1;
      }
    };
  }, [loadSkills, runtime, skillsReloadToken]);

  function handleAvatarFile(file: File | undefined) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError(t('agentSettings.error.avatarType'));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError(t('agentSettings.error.avatarSize'));
      return;
    }

    const generation = ++avatarReadGenerationRef.current;
    const reader = new FileReader();
    reader.onload = () => {
      if (
        typeof reader.result !== 'string' ||
        generation !== avatarReadGenerationRef.current
      ) return;
      markDraftChanged();
      setAvatarData(reader.result);
      setAvatarFileName(file.name);
      setError('');
    };
    reader.onerror = () => {
      if (
        generation === avatarReadGenerationRef.current
      ) {
        setError(t('agentSettings.error.avatarRead'));
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleSave() {
    if (savingRef.current || !dirty || !displayName.trim()) return;
    const resolved = resolveAgentRuntimeSelection(
      { runtime, model, connectionId },
      connections,
      localMode ? installedAgentRuntimeIds(runtimes || []) : undefined,
    );
    if (resolved.issue) {
      setSaveError(runtimeSelectionIssueMessage(resolved.issue, settings.language));
      return;
    }
    const requestedAgentId = agent.id;
    const generation = ++saveRequestGenerationRef.current;
    const savedDraftRevision = draftRevisionRef.current;
    const controller = new AbortController();
    saveRequestControllerRef.current?.abort();
    saveRequestControllerRef.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    if (savedFeedbackTimerRef.current) {
      clearTimeout(savedFeedbackTimerRef.current);
      savedFeedbackTimerRef.current = null;
    }
    savingRef.current = true;
    setSaving(true);
    setError('');
    setSaveError('');
    setSaved(false);

    try {
      const res = await fetch(apiUrl(`/api/agents/${requestedAgentId}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: displayName.trim(),
          description: description.trim() || null,
          runtime: resolved.selection.runtime,
          model: resolved.selection.model,
          connection_id: resolved.selection.connectionId,
          ...(localMode ? { thinking_level: thinkingLevel } : {}),
          system_prompt: systemPrompt.trim() || null,
          ...(avatarData
            ? { avatar_data: avatarData }
            : { avatar_url: avatarUrl }),
        }),
        signal: controller.signal,
      });

      const data = (await res.json().catch(() => null)) as {
        agent?: AgentFull;
        error?: string;
      } | null;
      if (!res.ok || !data?.agent) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      if (
        generation !== saveRequestGenerationRef.current
      ) return;

      const updated = data.agent;

      const nextBaseline = settingsBaselineFromAgent(updated as AgentFull);
      setBaseline(nextBaseline);
      const draftUnchanged = savedDraftRevision === draftRevisionRef.current;
      if (draftUnchanged) applyBaseline(nextBaseline);
      onUpdated({
        id: updated.id,
        display_name: updated.display_name,
        status: updated.status,
        description: updated.description,
        avatar_url: updated.avatar_url,
        owner_id: updated.owner_id,
      });
      setSaved(draftUnchanged);
      if (draftUnchanged) {
        savedFeedbackTimerRef.current = setTimeout(() => {
          if (
            generation === saveRequestGenerationRef.current
          ) {
            setSaved(false);
          }
          savedFeedbackTimerRef.current = null;
        }, 2000);
      }
    } catch (err) {
      if (
        generation !== saveRequestGenerationRef.current ||
        (controller.signal.aborted && !timedOut)
      ) return;
      const message = timedOut
        ? t('settings.requestTimedOut')
        : err instanceof Error
          ? err.message
          : t('agentSettings.error.unknown');
      setSaveError(t('agentSettings.error.save', { message }));
    } finally {
      clearTimeout(timeout);
      if (
        generation === saveRequestGenerationRef.current
      ) {
        if (saveRequestControllerRef.current === controller) {
          saveRequestControllerRef.current = null;
        }
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  async function handleReset() {
    if (dangerActionRef.current || savingRef.current) return;
    const generation = ++dangerRequestGenerationRef.current;
    const controller = new AbortController();
    dangerRequestControllerRef.current = controller;
    dangerActionRef.current = 'reset';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    setResetting(true);
    setError('');
    setSaveError('');

    try {
      const res = await fetch(apiUrl(`/api/agents/${agent.id}/reset`), {
        method: 'POST',
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      if (generation !== dangerRequestGenerationRef.current) return;
      window.location.reload();
    } catch (err) {
      if (
        generation !== dangerRequestGenerationRef.current ||
        (controller.signal.aborted && !timedOut)
      ) return;
      const message = timedOut
        ? t('settings.requestTimedOut')
        : err instanceof Error
          ? err.message
          : t('agentSettings.error.unknown');
      setError(t('agentSettings.error.reset', { message }));
    } finally {
      clearTimeout(timeout);
      if (generation === dangerRequestGenerationRef.current) {
        if (dangerRequestControllerRef.current === controller) {
          dangerRequestControllerRef.current = null;
        }
        dangerActionRef.current = null;
        setResetting(false);
      }
    }
  }

  async function handleDelete() {
    if (dangerActionRef.current || savingRef.current) return;
    const generation = ++dangerRequestGenerationRef.current;
    const controller = new AbortController();
    dangerRequestControllerRef.current = controller;
    dangerActionRef.current = 'delete';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    setDeleting(true);
    setError('');
    setSaveError('');

    try {
      const res = await fetch(apiUrl(`/api/agents/${agent.id}`), {
        method: 'DELETE',
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      if (generation !== dangerRequestGenerationRef.current) return;
      onDeleted();
    } catch (err) {
      if (
        generation !== dangerRequestGenerationRef.current ||
        (controller.signal.aborted && !timedOut)
      ) return;
      const message = timedOut
        ? t('settings.requestTimedOut')
        : err instanceof Error
          ? err.message
          : t('agentSettings.error.unknown');
      setError(t('agentSettings.error.delete', { message }));
    } finally {
      clearTimeout(timeout);
      if (generation === dangerRequestGenerationRef.current) {
        if (dangerRequestControllerRef.current === controller) {
          dangerRequestControllerRef.current = null;
        }
        dangerActionRef.current = null;
        setDeleting(false);
      }
    }
  }

  const runtimeItems = [
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    ...(localMode ? [{ value: 'pi', label: 'Pi / Custom API' }] : []),
  ];
  const selectedRuntime = runtimeItems.find((item) => item.value === runtime) ?? runtimeItems[0];
  const selectedModel = MODEL_ITEMS.find((m) => m.value === model) ?? MODEL_ITEMS[0];
  const codexModelItems: Array<{ value: string; label: string }> = CODEX_MODEL_ITEMS.map((item) => ({
    ...item,
    label: item.value === 'default' && settings.language === 'zh-CN'
      ? '自动（推荐）'
      : item.label,
  }));
  const selectedCodexModel = codexModelItems.find((item) => item.value === model) ?? codexModelItems[0];
  const resolvedSelection = resolveAgentRuntimeSelection(
    { runtime, model, connectionId },
    connections,
    localMode ? installedAgentRuntimeIds(runtimes || []) : undefined,
  );
  const selectionError = runtimeSelectionIssueMessage(
    resolvedSelection.issue,
    settings.language,
  );
  const connectionItems = [
    { value: '', label: t('agentSettings.chooseConnection') },
    ...connections
      .filter((connection) => connection.hasCredential)
      .map((connection) => ({ value: connection.id, label: connection.name })),
  ];
  const selectedConnection = connectionItems.find((item) => item.value === connectionId) ?? connectionItems[0];
  const providerItems = localMode
    ? agentProviderItems(connections, runtimes, settings.language)
    : [];
  const selectedProviderValue = runtime === 'pi' && connectionId
    ? `connection:${connectionId}`
    : `runtime:${runtime}`;
  const selectedProvider = providerItems.find((item) => item.value === selectedProviderValue) ?? providerItems[0];
  const activeConnection = connections.find((connection) => connection.id === connectionId);
  const selectionSupportsThinking = runtime === 'codex' || (
    runtime === 'pi' &&
    activeConnection?.models.find((modelDefinition) => modelDefinition.id === model)?.reasoning === true
  );
  const connectionModelItems = resolvedSelection.models.map((value) => ({
    value,
    label: activeConnection?.models.find((modelDefinition) => modelDefinition.id === value)?.name || value,
  }));
  const selectedConnectionModel = connectionModelItems.find((item) => item.value === model) ?? connectionModelItems[0];

  const applyResolvedSelection = (next: ReturnType<typeof resolveAgentRuntimeSelection>) => {
    markDraftChanged();
    setRuntime(next.selection.runtime);
    setModel(next.selection.model);
    setConnectionId(next.selection.connectionId);
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-sm text-muted-foreground">{t('agentSettings.loading')}</div>
      </div>
    );
  }

  if (!baseline) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-xs text-destructive">{error || t('agentSettings.error.unknown')}</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setLoading(true);
            setError('');
            setAgentReloadToken((token) => token + 1);
          }}
        >
          {t('runtime.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="px-5 py-4 space-y-6">
      {/* Basic Info */}
      <section className="space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('agentSettings.basicInfo')}
        </h3>

        <Field>
          <FieldLabel>{t('agentSettings.avatar')}</FieldLabel>
          <div className="rounded-lg border p-3 space-y-3">
            <div className="flex items-center gap-3">
              <GeneratedAvatar
                id={agent.id}
                name={displayName || agent.display_name}
                size="lg"
                avatarUrl={avatarData || avatarUrl}
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium truncate">
                  {avatarFileName || (avatarData ? t('agentSettings.customImage') : t('agentSettings.chooseAvatar'))}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {localMode ? t('agentSettings.avatarUploadHint') : t('agentSettings.avatarGeneratedHint')}
                </div>
              </div>
              {localMode && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    <UploadSimple size={14} />
                    {t('agentSettings.upload')}
                  </Button>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(event) => {
                      handleAvatarFile(event.target.files?.[0]);
                      event.target.value = '';
                    }}
                  />
                </>
              )}
            </div>

            <div
              aria-label={t('agentSettings.avatar')}
              className="grid grid-cols-9 gap-1.5"
              role="group"
            >
              <button
                type="button"
                aria-pressed={!avatarData && !avatarUrl}
                className={`rounded-full p-0.5 ring-offset-background outline-none transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
                  !avatarData && !avatarUrl ? 'ring-2 ring-primary ring-offset-1' : 'hover:bg-muted'
                }`}
                title={t('agentSettings.defaultAvatar')}
                aria-label={t('agentSettings.useDefaultAvatar')}
                onClick={() => {
                  if (avatarData || avatarUrl !== null) markDraftChanged();
                  avatarReadGenerationRef.current += 1;
                  setAvatarUrl(null);
                  setAvatarData(null);
                  setAvatarFileName('');
                }}
              >
                <GeneratedAvatar id={agent.id} name={displayName} size="sm" />
              </button>
              {AGENT_AVATAR_PRESETS.map((seed, index) => {
                const value = `generated:${seed}`;
                const selected = !avatarData && avatarUrl === value;
                return (
                  <button
                    key={seed}
                    type="button"
                    aria-pressed={selected}
                    className={`rounded-full p-0.5 ring-offset-background outline-none transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
                      selected ? 'ring-2 ring-primary ring-offset-1' : 'hover:bg-muted'
                    }`}
                    title={t('agentSettings.generatedAvatar')}
                    aria-label={`${t('agentSettings.chooseGeneratedAvatar')} ${index + 1}`}
                    onClick={() => {
                      if (avatarData || avatarUrl !== value) markDraftChanged();
                      avatarReadGenerationRef.current += 1;
                      setAvatarUrl(value);
                      setAvatarData(null);
                      setAvatarFileName('');
                    }}
                  >
                    <GeneratedAvatar id={seed} name={displayName} size="sm" />
                  </button>
                );
              })}
            </div>
          </div>
        </Field>

        <Field>
          <FieldLabel>{t('agentSettings.displayName')}</FieldLabel>
          <Input
            type="text"
            value={displayName}
            onChange={(e) => {
              markDraftChanged();
              setDisplayName((e.target as HTMLInputElement).value);
            }}
          />
        </Field>

        <Field>
          <FieldLabel>{t('agentSettings.description')}</FieldLabel>
          <Input
            type="text"
            value={description}
            onChange={(e) => {
              markDraftChanged();
              setDescription((e.target as HTMLInputElement).value);
            }}
            placeholder={t('agentSettings.descriptionPlaceholder')}
          />
        </Field>
      </section>

      {/* Runtime & Model */}
      <section className="space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {localMode
            ? (settings.language === 'zh-CN' ? '模型与思考' : 'AI')
            : t('agentSettings.runtime')}
        </h3>

        <div className="rounded-lg border p-3 space-y-3">
          {localMode && (
            <>
              <Field className="flex-row items-center justify-between gap-3">
                <FieldLabel className="text-xs font-normal text-muted-foreground">
                  {settings.language === 'zh-CN' ? '模型连接' : 'Model connection'}
                </FieldLabel>
                <Select
                  value={selectedProvider}
                  items={providerItems}
                  onValueChange={(next) => {
                    if (!next) return;
                    const value = (next as typeof selectedProvider).value;
                    if (value.startsWith('connection:')) {
                      applyResolvedSelection(resolveAgentRuntimeSelection({
                        runtime: 'pi',
                        connectionId: value.slice('connection:'.length),
                      }, connections, installedAgentRuntimeIds(runtimes || [])));
                    } else {
                      applyResolvedSelection(resolveAgentRuntimeSelection({
                        runtime: value.slice('runtime:'.length),
                      }, connections, installedAgentRuntimeIds(runtimes || [])));
                    }
                  }}
                >
                  <SelectTrigger size="sm" className="w-auto max-w-52 min-w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {providerItems.map((item) => (
                      <SelectItem disabled={item.disabled} key={item.value} value={item}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Separator />
            </>
          )}
          {!localMode && (
          <Field className="flex-row items-center justify-between gap-3">
            <FieldLabel className="text-xs font-normal text-muted-foreground">
              {t('agentSettings.runtime')}
            </FieldLabel>
            <Select
              value={selectedRuntime}
              items={runtimeItems}
              onValueChange={(next) => {
                if (!next) return;
                const nextRuntime = (next as typeof selectedRuntime).value as AgentRuntimeId;
                if (nextRuntime !== runtime) {
                  applyResolvedSelection(resolveAgentRuntimeSelection({
                    runtime: nextRuntime,
                  }, connections));
                }
              }}
            >
              <SelectTrigger
                aria-label={t('agentSettings.runtime')}
                size="sm"
                className="w-auto min-w-32"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {runtimeItems.map((item) => (
                  <SelectItem key={item.value} value={item}>{item.label}</SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          )}
          {!localMode && <Separator />}
          <Field className="flex-row items-center justify-between gap-3">
            <FieldLabel className="text-xs font-normal text-muted-foreground">
              {t('agentSettings.model')}
            </FieldLabel>
            {runtime === 'claude-code' ? (
              <Select
                value={selectedModel}
                onValueChange={(val) => {
                  if (!val) return;
                  const nextModel = (val as typeof selectedModel).value;
                  if (nextModel !== model) markDraftChanged();
                  setModel(nextModel);
                }}
                items={MODEL_ITEMS}>
                <SelectTrigger
                  aria-label={t('agentSettings.model')}
                  size="sm"
                  className="w-auto min-w-24"
                >
                  <SelectValue placeholder={t('agentSettings.selectModel')} />
                </SelectTrigger>
                <SelectPopup>
                  {MODEL_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : runtime === 'codex' ? (
              <Select
                value={selectedCodexModel}
                items={codexModelItems}
                onValueChange={(next) => {
                  if (!next) return;
                  const nextModel = (next as typeof selectedCodexModel).value;
                  if (nextModel !== model) markDraftChanged();
                  setModel(nextModel);
                }}
              >
                <SelectTrigger
                  aria-label={t('agentSettings.model')}
                  size="sm"
                  className="w-auto min-w-32"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {codexModelItems.map((item) => (
                    <SelectItem key={item.value} value={item}>{item.label}</SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              <Select
                value={selectedConnectionModel}
                items={connectionModelItems}
                onValueChange={(next) => {
                  if (!next) return;
                  const nextModel = (next as typeof selectedConnectionModel).value;
                  if (nextModel !== model) markDraftChanged();
                  setModel(nextModel);
                }}
              >
                <SelectTrigger
                  aria-label={t('agentSettings.model')}
                  size="sm"
                  className="w-auto max-w-52 min-w-32"
                >
                  <SelectValue placeholder={settings.language === 'zh-CN' ? '选择可用模型' : 'Choose an available model'} />
                </SelectTrigger>
                <SelectPopup>
                  {connectionModelItems.map((item) => (
                    <SelectItem key={item.value} value={item}>{item.label}</SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </Field>
          {localMode && selectionSupportsThinking && (
            <>
              <Separator />
              <Field className="flex-row items-center justify-between gap-3">
                <FieldLabel className="text-xs font-normal text-muted-foreground">
                  {t('settings.thinkingLevel')}
                </FieldLabel>
                <Select
                  items={([
                    { value: 'low', label: t('settings.thinkingLow') },
                    { value: 'medium', label: t('settings.thinkingMedium') },
                    { value: 'high', label: t('settings.thinkingHigh') },
                  ] satisfies Array<{ value: ThinkingLevel; label: string }>)}
                  value={{
                    value: thinkingLevel,
                    label: t(thinkingLevel === 'low'
                      ? 'settings.thinkingLow'
                      : thinkingLevel === 'high'
                        ? 'settings.thinkingHigh'
                        : 'settings.thinkingMedium'),
                  }}
                  onValueChange={(next) => {
                    if (!next) return;
                    const level = (next as { value: ThinkingLevel }).value;
                    if (level !== thinkingLevel) markDraftChanged();
                    setThinkingLevel(level);
                  }}
                >
                  <SelectTrigger size="sm" className="w-auto min-w-28"><SelectValue /></SelectTrigger>
                  <SelectPopup>
                    {([
                      { value: 'low', label: t('settings.thinkingLow') },
                      { value: 'medium', label: t('settings.thinkingMedium') },
                      { value: 'high', label: t('settings.thinkingHigh') },
                    ] satisfies Array<{ value: ThinkingLevel; label: string }>).map((item) => (
                      <SelectItem key={item.value} value={item}>{item.label}</SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            </>
          )}
          {!localMode && runtime === 'pi' && (
            <>
              <Separator />
              <Field className="flex-row items-center justify-between gap-3">
                <FieldLabel className="text-xs font-normal text-muted-foreground">
                  {t('agentSettings.connection')}
                </FieldLabel>
                <Select
                  disabled={connectionsLoading || Boolean(connectionsError)}
                  value={selectedConnection}
                  items={connectionItems}
                  onValueChange={(next) => {
                    if (!next) return;
                    const connection = connections.find((entry) => entry.id === (next as typeof selectedConnection).value);
                    if ((connection?.id || null) !== connectionId) markDraftChanged();
                    setConnectionId(connection?.id || null);
                    if (connection) setModel(connection.default_model);
                  }}
                >
                  <SelectTrigger
                    aria-label={t('agentSettings.connection')}
                    size="sm"
                    className="w-auto max-w-52 min-w-32"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {connectionItems.map((item) => (
                      <SelectItem key={item.value} value={item}>{item.label}</SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              {connectionsLoading && (
                <p aria-live="polite" className="text-xs text-muted-foreground" role="status">
                  {t('agentSettings.loadingConnections')}
                </p>
              )}
              {connectionsError && (
                <Alert variant="error">
                  <CircleAlert />
                  <AlertDescription>
                    <span>{connectionsError}</span>
                    <Button
                      className="w-fit"
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setConnectionsReloadToken((token) => token + 1)}
                    >
                      {t('agentSettings.retry')}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
          {selectionError && (
            <Alert variant="warning">
              <CircleAlert />
              <AlertDescription>
                <span>{selectionError}</span>
                {resolvedSelection.models.length > 0 && (
                  <Button
                    className="w-fit"
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => applyResolvedSelection(resolveAgentRuntimeSelection({
                      runtime,
                      connectionId,
                    }, connections, localMode ? installedAgentRuntimeIds(runtimes || []) : undefined))}
                  >
                    {settings.language === 'zh-CN' ? '使用推荐模型' : 'Use recommended model'}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>
      </section>

      {/* Instructions */}
      <section className="space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('agentSettings.instructions')}
        </h3>
        <Field>
          <FieldLabel>{t('agentSettings.systemPrompt')}</FieldLabel>
          <Textarea
            value={systemPrompt}
            onChange={(e) => {
              markDraftChanged();
              setSystemPrompt((e.target as HTMLTextAreaElement).value);
            }}
            placeholder={t('agentSettings.systemPromptPlaceholder')}
            className="min-h-[120px]"
          />
        </Field>
      </section>

      {/* Save button */}
      <Button
        onClick={handleSave}
        loading={saving}
        disabled={
          !dirty ||
          !displayName.trim() ||
          Boolean(resolvedSelection.issue) ||
          (runtime === 'pi' && (connectionsLoading || Boolean(connectionsError))) ||
          resetting ||
          deleting
        }
        className="w-full"
      >
        <FloppyDisk size={16} />
        {saved ? t('agentSettings.saved') : t('agentSettings.saveChanges')}
      </Button>
      {saveError && (
        <Alert variant="error">
          <CircleAlert />
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      {/* Skills */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('agentSettings.skills')}
          </h3>
          {skills.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {t('agentSettings.installedSkills', { count: String(skills.length) })}
            </Badge>
          )}
        </div>
        {skillsLoading ? (
          <div className="rounded-lg border px-3 py-4 text-center" aria-live="polite">
            <p className="text-xs text-muted-foreground">{t('agentSettings.loadingSkills')}</p>
          </div>
        ) : skillsError ? (
          <div className="rounded-lg border border-destructive/20 px-3 py-4 text-center" role="alert">
            <p className="text-xs text-destructive">{skillsError}</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => setSkillsReloadToken((token) => token + 1)}
            >
              {t('runtime.retry')}
            </Button>
          </div>
        ) : skills.length > 0 ? (
          <div className="space-y-1 rounded-lg border p-2">
            {skills.map((skill) => (
              <div key={skill.name} className="flex items-start gap-2.5 rounded-md px-2.5 py-2 text-sm">
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary mt-0.5">
                  <Lightning size={14} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{skill.name}</div>
                  <div className="text-[11px] text-muted-foreground leading-relaxed mt-0.5 line-clamp-2">
                    {skill.description}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border px-3 py-4 text-center">
            <p className="text-xs text-muted-foreground">{t('agentSettings.noSkills')}</p>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          {t('agentSettings.skillsSourcePrefix')}{' '}
          <code className="text-[10px] px-1 py-0.5 rounded bg-muted">{SKILLS_SOURCE_BY_RUNTIME[runtime]}</code>{' '}
          {t('agentSettings.skillsSourceSuffix')}
        </p>
      </section>

      {/* Danger Zone */}
      <section className="space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-destructive/70">
          {t('agentSettings.dangerZone')}
        </h3>
        <div className="space-y-2 rounded-lg border border-destructive/20 p-3">
          <Button
            onClick={() => setPendingDangerAction('reset')}
            loading={resetting}
            disabled={saving || deleting}
            variant="ghost"
            className="w-full justify-start text-muted-foreground hover:text-destructive hover:bg-destructive/10">
            <ArrowCounterClockwise size={16} />
            {t('agentSettings.resetConversation')}
          </Button>
          <Separator />
          <Button
            onClick={() => setPendingDangerAction('delete')}
            loading={deleting}
            disabled={saving || resetting}
            variant="ghost"
            className="w-full justify-start text-muted-foreground hover:text-destructive hover:bg-destructive/10">
            <Trash size={16} />
            {t('agentSettings.deleteAgent')}
          </Button>
        </div>
      </section>

      {error && (
        <Alert variant="error">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <AlertDialog
        open={pendingDangerAction !== null}
        onOpenChange={(open) => {
          if (!open && !resetting && !deleting) setPendingDangerAction(null);
        }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDangerAction === 'reset' ? t('agentSettings.resetTitle') : t('agentSettings.deleteTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDangerAction === 'reset'
                ? t('agentSettings.resetDescription')
                : t('agentSettings.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              disabled={resetting || deleting}
              onClick={() => setPendingDangerAction(null)}
              variant="ghost">
              {t('agentSettings.cancel')}
            </Button>
            <Button
              loading={resetting || deleting}
              onClick={async () => {
                if (pendingDangerAction === 'reset') await handleReset();
                else if (pendingDangerAction === 'delete') await handleDelete();
                setPendingDangerAction(null);
              }}
              variant="destructive">
              {pendingDangerAction === 'reset'
                ? t('agentSettings.resetConversation')
                : t('agentSettings.deleteAgent')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

// ─── Workspace Tab ──────────────────────────────────────────────────────────

function WorkspaceTab({ agentId, bridgeRpc }: { agentId: string; bridgeRpc: BridgeRpcFn }) {
  const { t } = useAppSettings();
  const [loading, setLoading] = useState(true);
  const [workspacePath, setWorkspacePath] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [notesFiles, setNotesFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [isRemote, setIsRemote] = useState(false);
  const [bridgeOnline, setBridgeOnline] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const workspaceRequestGenerationRef = useRef(0);
  const workspaceAbortControllerRef = useRef<AbortController | null>(null);
  const fileRequestGenerationRef = useRef(0);
  const fileAbortControllerRef = useRef<AbortController | null>(null);

  const loadWorkspace = useCallback(async () => {
    const generation = ++workspaceRequestGenerationRef.current;
    workspaceAbortControllerRef.current?.abort();
    const controller = new AbortController();
    workspaceAbortControllerRef.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    const isCurrentRequest = () => generation === workspaceRequestGenerationRef.current;

    setLoading(true);
    setError('');
    setIsRemote(false);
    setBridgeOnline(true);
    try {
      const res = await fetch(apiUrl(`/api/agents/${agentId}/workspace`), {
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        workspace_path?: string;
        files?: FileEntry[];
        notes_files?: FileEntry[];
      } | null;
      if (!isCurrentRequest()) return;

      if (res.ok && data) {
        // Local mode — API can read files directly
        setWorkspacePath(data.workspace_path || '');
        setFiles(data.files || []);
        setNotesFiles(data.notes_files || []);
        return;
      }

      if (data?.error === 'remote_workspace') {
        // Remote mode — try RPC to bridge
        setIsRemote(true);
        setWorkspacePath(data.workspace_path || '');
        try {
          const rpcData = await bridgeRpc('list', { agentId }, controller.signal);
          if (!isCurrentRequest()) return;
          setWorkspacePath((rpcData.workspace_path as string) || data.workspace_path || '');
          setFiles((rpcData.files as FileEntry[]) || []);
          setNotesFiles((rpcData.notes_files as FileEntry[]) || []);
        } catch {
          if (isCurrentRequest() && (!controller.signal.aborted || timedOut)) {
            setBridgeOnline(false);
          }
        }
        return;
      }

      throw new Error(data?.error || t('agentSettings.error.unknown'));
    } catch (err) {
      if (!isCurrentRequest() || (controller.signal.aborted && !timedOut)) return;
      const message = timedOut
        ? t('settings.requestTimedOut')
        : err instanceof Error
          ? err.message
          : t('agentSettings.error.unknown');
      setError(t('agentSettings.error.loadWorkspace', { message }));
    } finally {
      clearTimeout(timeout);
      if (isCurrentRequest()) {
        setLoading(false);
        if (workspaceAbortControllerRef.current === controller) {
          workspaceAbortControllerRef.current = null;
        }
      }
    }
  }, [agentId, bridgeRpc, t]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadWorkspace());
    return () => {
      window.cancelAnimationFrame(frame);
      workspaceRequestGenerationRef.current += 1;
      workspaceAbortControllerRef.current?.abort();
      workspaceAbortControllerRef.current = null;
      fileRequestGenerationRef.current += 1;
      fileAbortControllerRef.current?.abort();
      fileAbortControllerRef.current = null;
    };
  }, [loadWorkspace]);

  async function loadFile(filePath: string) {
    const generation = ++fileRequestGenerationRef.current;
    fileAbortControllerRef.current?.abort();
    const controller = new AbortController();
    fileAbortControllerRef.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10_000);

    setLoadingFile(true);
    setSelectedFile(filePath);
    setFileContent(null);
    setFileError('');
    setShowPreview(false);

    const isCurrentRequest = () => generation === fileRequestGenerationRef.current;

    try {
      let content: unknown;
      if (isRemote) {
        const data = await bridgeRpc('read', { agentId, filePath }, controller.signal);
        content = data.content;
      } else {
        const res = await fetch(
          apiUrl(`/api/agents/${agentId}/workspace?file=${encodeURIComponent(filePath)}`),
          { signal: controller.signal }
        );
        const data = (await res.json().catch(() => ({}))) as { content?: unknown; error?: string };
        if (!res.ok) {
          throw new Error(data.error || t('agentSettings.error.requestStatus', { status: String(res.status) }));
        }
        content = data.content;
      }

      if (typeof content !== 'string') throw new Error(t('agentSettings.error.fileInvalid'));
      if (isCurrentRequest()) setFileContent(content);
    } catch (err) {
      if (!isCurrentRequest() || (controller.signal.aborted && !timedOut)) return;
      setFileContent(null);
      const message = timedOut
        ? t('settings.requestTimedOut')
        : err instanceof Error
          ? err.message
          : t('agentSettings.error.unknown');
      setFileError(
        message === 'bridge_offline'
          ? t('agentSettings.error.readFileOffline')
          : t('agentSettings.error.readFile', { message })
      );
    } finally {
      clearTimeout(timeout);
      if (isCurrentRequest()) {
        setLoadingFile(false);
        if (fileAbortControllerRef.current === controller) {
          fileAbortControllerRef.current = null;
        }
      }
    }
  }

  function closeFilePreview() {
    fileRequestGenerationRef.current += 1;
    fileAbortControllerRef.current?.abort();
    fileAbortControllerRef.current = null;
    setLoadingFile(false);
    setSelectedFile(null);
    setFileContent(null);
    setFileError('');
    setShowPreview(false);
  }

  function handleCopyPath() {
    navigator.clipboard.writeText(workspacePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-sm text-muted-foreground">{t('agentSettings.workspaceLoading')}</div>
      </div>
    );
  }

  if (isRemote && !bridgeOnline) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
        <FolderOpen size={32} className="text-muted-foreground/40" />
        <div className="text-center space-y-1.5">
          <p className="text-sm font-medium text-foreground">{t('agentSettings.runtimeOffline')}</p>
          <p className="text-xs text-muted-foreground leading-relaxed max-w-[280px]">
            {t('agentSettings.runtimeOfflineDescription')}
          </p>
        </div>
        {workspacePath && (
          <code className="text-[11px] font-mono text-muted-foreground bg-muted rounded px-2 py-1 max-w-full truncate">
            {workspacePath}
          </code>
        )}
        <Button variant="link" size="sm" onClick={loadWorkspace}>
          <ArrowClockwise size={14} />
          {t('agentSettings.retry')}
        </Button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-5">
        <p className="text-sm text-muted-foreground text-center">{error}</p>
        <Button variant="link" size="sm" onClick={loadWorkspace}>
          <ArrowClockwise size={14} />
          {t('agentSettings.retry')}
        </Button>
      </div>
    );
  }

  const topLevelFiles = files.filter((f) => f.type === 'file');
  const topLevelDirs = files.filter((f) => f.type === 'directory' && f.name !== 'notes');
  const hasNotes = notesFiles.length > 0 || files.some((f) => f.name === 'notes');

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Workspace path header */}
      <div className="flex items-center justify-between px-5 py-3 border-b">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] text-muted-foreground truncate font-mono">{workspacePath}</p>
        </div>
        <div className="flex items-center gap-1 ml-2">
          <Button onClick={handleCopyPath} variant="ghost" size="icon-xs" aria-label={t('agentSettings.copyPath')}>
            <Copy size={14} />
          </Button>
          <Button onClick={loadWorkspace} variant="ghost" size="icon-xs" aria-label={t('agentSettings.refresh')}>
            <ArrowClockwise size={14} />
          </Button>
        </div>
        {copied && (
          <Badge variant="success" className="text-[10px] ml-1">
            {t('agentSettings.copied')}
          </Badge>
        )}
      </div>

      {/* File tree */}
      <div className="px-3 py-2">
        {topLevelFiles.map((file) => (
          <FileRow
            key={file.name}
            file={file}
            isSelected={selectedFile === file.name}
            onClick={() => loadFile(file.name)}
            formatSize={formatSize}
          />
        ))}

        {hasNotes && (
          <div className="mt-1">
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
              <Folder size={14} className="text-primary/60" />
              <span className="font-medium">notes/</span>
            </div>
            {notesFiles.length > 0 ? (
              <div className="ml-4">
                {notesFiles.map((file) => (
                  <FileRow
                    key={file.name}
                    file={file}
                    displayName={file.name.replace('notes/', '')}
                    isSelected={selectedFile === file.name}
                    onClick={() => loadFile(file.name)}
                    formatSize={formatSize}
                  />
                ))}
              </div>
            ) : (
              <div className="ml-6 py-1 text-[11px] text-muted-foreground italic">
                {t('agentSettings.empty')}
              </div>
            )}
          </div>
        )}

        {topLevelDirs.map((dir) => (
          <div key={dir.name} className="mt-1">
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
              <Folder size={14} className="opacity-60" />
              <span className="font-medium">{dir.name}/</span>
            </div>
          </div>
        ))}

        {topLevelFiles.length === 0 && !hasNotes && topLevelDirs.length === 0 && (
          <div className="px-3 py-8 text-center">
            <FolderOpen size={32} className="mx-auto text-muted-foreground/40 mb-2" />
            <p className="text-xs text-muted-foreground">{t('agentSettings.workspaceEmpty')}</p>
            <p className="text-[11px] text-muted-foreground mt-1">
              {t('agentSettings.workspaceEmptyDescription')}
            </p>
          </div>
        )}
      </div>

      {/* File content preview */}
      {selectedFile && (
        <div className="border-t">
          <div className="flex items-center justify-between px-4 py-2 bg-muted/50">
            <span className="text-[11px] font-medium text-muted-foreground font-mono truncate">{selectedFile}</span>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              {selectedFile.endsWith('.md') && fileContent && !loadingFile && (
                <Button
                  onClick={() => setShowPreview(true)}
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('agentSettings.previewMarkdown')}>
                  <Eye size={14} />
                </Button>
              )}
              <Button
                onClick={closeFilePreview}
                variant="ghost"
                size="icon-xs"
                aria-label={t('agentSettings.closePreview')}>
                <X size={14} />
              </Button>
            </div>
          </div>
          <div className="px-4 py-3 max-h-[400px] overflow-y-auto">
            {loadingFile ? (
              <p className="text-xs text-muted-foreground">{t('agentSettings.loading')}</p>
            ) : fileError ? (
              <p className="text-xs text-destructive" role="alert">{fileError}</p>
            ) : (
              <pre className="text-xs text-muted-foreground font-mono whitespace-pre-wrap break-words leading-relaxed">
                {fileContent}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* Markdown preview dialog */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogPopup className="max-w-[1080px]">
          <DialogHeader>
            <DialogTitle className="text-base font-mono">{selectedFile}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="prose-message text-[15px]" style={{ lineHeight: '1.54' }}>
              <SafeMarkdown>{fileContent || ''}</SafeMarkdown>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      {/* Info footer */}
      <div className="px-5 py-3 border-t">
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {t('agentSettings.workspaceInfoPrefix')}{' '}
          <code className="text-[10px] px-1 py-0.5 rounded bg-muted">MEMORY.md</code>{' '}
          {t('agentSettings.workspaceInfoSuffix')}
        </p>
      </div>
    </div>
  );
}

// ─── File Row Component ─────────────────────────────────────────────────────

function FileRow({
  file,
  displayName,
  isSelected,
  onClick,
  formatSize,
}: {
  file: FileEntry;
  displayName?: string;
  isSelected: boolean;
  onClick: () => void;
  formatSize: (bytes: number) => string;
}) {
  const isMemory = file.name === 'MEMORY.md';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
        isSelected ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50'
      }`}>
      <File size={14} className={isMemory ? 'text-primary' : 'opacity-60'} />
      <span className={`flex-1 text-xs font-mono truncate ${isMemory ? 'font-medium' : ''}`}>
        {displayName || file.name}
      </span>
      <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatSize(file.size)}</span>
    </button>
  );
}
