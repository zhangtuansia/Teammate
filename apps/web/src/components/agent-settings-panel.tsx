'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  X,
  FloppyDisk,
  ArrowCounterClockwise,
  Trash,
  Lightning,
  GearSix,
  FolderOpen,
  File,
  Folder,
  Copy,
  ArrowClockwise,
  Eye,
} from '@phosphor-icons/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTab, TabsPanel } from '@/components/ui/tabs';
import { Field, FieldLabel } from '@/components/ui/field';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { apiUrl } from '@/lib/api-url';
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from '@/components/ui/select';
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel } from '@/components/ui/dialog';

interface AgentInfo {
  id: string;
  display_name: string;
  status: string;
  description: string | null;
}

interface AgentFull {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  system_prompt: string | null;
  model: string;
  status: string;
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

type BridgeRpcFn = (action: string, extra?: Record<string, unknown>) => Promise<Record<string, unknown>>;

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
  // Shared RPC channel for bridge communication (workspace + skills)
  const rpcChannelRef = useRef<RealtimeChannel | null>(null);
  const rpcCallbacksRef = useRef(new Map<string, (payload: Record<string, unknown>) => void>());

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('bridge-rpc')
      .on('broadcast', { event: 'rpc:response' }, ({ payload }: { payload: Record<string, unknown> }) => {
        const cb = rpcCallbacksRef.current.get(payload.requestId as string);
        if (cb) {
          rpcCallbacksRef.current.delete(payload.requestId as string);
          cb(payload as Record<string, unknown>);
        }
      })
      .subscribe();

    rpcChannelRef.current = channel;

    return () => {
      channel.unsubscribe();
      rpcChannelRef.current = null;
    };
  }, []);

  const bridgeRpc: BridgeRpcFn = useCallback(
    async (action, extra = {}) => {
      const channel = rpcChannelRef.current;
      if (!channel) throw new Error('bridge_offline');

      const requestId = crypto.randomUUID();
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          rpcCallbacksRef.current.delete(requestId);
          reject(new Error('bridge_offline'));
        }, 8000);

        rpcCallbacksRef.current.set(requestId, (payload) => {
          clearTimeout(timeout);
          if (payload.error) reject(new Error(payload.error as string));
          else resolve(payload);
        });

        channel.send({
          type: 'broadcast',
          event: 'rpc:request',
          payload: { requestId, action, ...extra },
        });
      });
    },
    []
  );

  return (
    <div className="flex h-full w-[360px] flex-shrink-0 flex-col border-l bg-card animate-slide-in-right">
      {/* Tab content */}
      <Tabs defaultValue="settings" className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center gap-1 pl-5 pr-2 justify-between h-[55.5px]">
          <TabsList variant="underline">
            <TabsTab value="settings">
              <GearSix size={14} />
              Settings
            </TabsTab>
            <TabsTab value="workspace">
              <FolderOpen size={14} />
              Workspace
            </TabsTab>
          </TabsList>
          <Button onClick={onClose} variant="ghost" size="icon-xs" aria-label="Close">
            <X size={18} />
          </Button>
        </div>

        <TabsPanel value="settings" className="flex-1 min-h-0 overflow-y-auto">
          <SettingsTab agent={agent} onDeleted={onDeleted} onUpdated={onUpdated} bridgeRpc={bridgeRpc} />
        </TabsPanel>
        <TabsPanel value="workspace" className="flex-1 min-h-0 overflow-y-auto">
          <WorkspaceTab agentId={agent.id} bridgeRpc={bridgeRpc} />
        </TabsPanel>
      </Tabs>
    </div>
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
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('opus');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const supabase = createClient();

  useEffect(() => {
    loadAgent();
    loadSkills();
  }, [agent.id]);

  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  async function loadAgent() {
    setLoading(true);
    setError('');
    const { data } = await supabase.from('agents').select('*').eq('id', agent.id).single();

    if (data) {
      const a = data as AgentFull;
      setDisplayName(a.display_name);
      setDescription(a.description || '');
      setModel(a.model || 'opus');
      setSystemPrompt(a.system_prompt || '');
    }
    setLoading(false);
  }

  async function loadSkills() {
    try {
      const res = await fetch(apiUrl('/api/skills'));
      if (res.ok) {
        const data = await res.json();
        if (data.skills && data.skills.length > 0) {
          setSkills(data.skills);
          return;
        }
        // API returned empty — might be remote, try bridge RPC
        if (data.remote) {
          const rpcData = await bridgeRpc('skills:list');
          setSkills((rpcData.skills as Skill[]) || []);
          return;
        }
      }
    } catch {
      // Skills loading is non-critical — try RPC as last resort
      try {
        const rpcData = await bridgeRpc('skills:list');
        setSkills((rpcData.skills as Skill[]) || []);
      } catch {
        // Bridge offline or no skills — leave empty
      }
    }
  }

  async function handleSave() {
    if (!displayName.trim()) return;
    setSaving(true);
    setError('');
    setSaved(false);

    try {
      const res = await fetch(apiUrl(`/api/agents/${agent.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: displayName.trim(),
          description: description.trim() || null,
          model,
          system_prompt: systemPrompt.trim() || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }

      const { agent: updated } = await res.json();
      onUpdated({
        id: updated.id,
        display_name: updated.display_name,
        status: updated.status,
        description: updated.description,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!confirm('This will delete all messages in the DM with this agent. Continue?')) return;

    setResetting(true);
    setError('');

    try {
      const res = await fetch(apiUrl(`/api/agents/${agent.id}/reset`), {
        method: 'POST',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to reset');
      }

      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset');
    } finally {
      setResetting(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }

    setDeleting(true);
    setError('');

    try {
      const res = await fetch(apiUrl(`/api/agents/${agent.id}`), {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete');
      }

      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  }

  const selectedModel = MODEL_ITEMS.find((m) => m.value === model) ?? MODEL_ITEMS[0];

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="px-5 py-4 space-y-6">
      {/* Basic Info */}
      <section className="space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Basic Info</h3>

        <Field>
          <FieldLabel>Display Name</FieldLabel>
          <Input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName((e.target as HTMLInputElement).value)}
          />
        </Field>

        <Field>
          <FieldLabel>Description</FieldLabel>
          <Input
            type="text"
            value={description}
            onChange={(e) => setDescription((e.target as HTMLInputElement).value)}
            placeholder="What does this agent do?"
          />
        </Field>
      </section>

      {/* Runtime & Model */}
      <section className="space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Runtime</h3>

        <div className="rounded-lg border p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Runtime</span>
            <span className="text-xs font-medium flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
              Claude Code
            </span>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Model</span>
            <Select
              value={selectedModel}
              onValueChange={(val) => {
                if (val) setModel((val as typeof selectedModel).value);
              }}
              items={MODEL_ITEMS}>
              <SelectTrigger size="sm" className="w-auto min-w-24">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectPopup>
                {MODEL_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
      </section>

      {/* Instructions */}
      <section className="space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Instructions</h3>
        <Field>
          <FieldLabel>System Prompt</FieldLabel>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt((e.target as HTMLTextAreaElement).value)}
            placeholder="Define the agent's behavior, personality, and responsibilities..."
            className="min-h-[120px]"
          />
        </Field>
      </section>

      {/* Save button */}
      <Button onClick={handleSave} loading={saving} disabled={!displayName.trim()} className="w-full">
        <FloppyDisk size={16} />
        {saved ? 'Saved!' : 'Save Changes'}
      </Button>

      {/* Skills */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Skills</h3>
          {skills.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {skills.length} installed
            </Badge>
          )}
        </div>
        {skills.length > 0 ? (
          <div className="space-y-1 rounded-lg border p-2">
            {skills.map((skill) => (
              <div key={skill.name} className="flex items-start gap-2.5 rounded-md px-2.5 py-2 text-sm">
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary mt-0.5">
                  <Lightning size={14} weight="fill" />
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
            <p className="text-xs text-muted-foreground">No skills installed</p>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          Skills are loaded from <code className="text-[10px] px-1 py-0.5 rounded bg-muted">~/.claude/skills/</code> and
          shared across all agents.
        </p>
      </section>

      {/* Danger Zone */}
      <section className="space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-destructive/70">Danger Zone</h3>
        <div className="space-y-2 rounded-lg border border-destructive/20 p-3">
          <Button
            onClick={handleReset}
            loading={resetting}
            variant="ghost"
            className="w-full justify-start text-muted-foreground hover:text-destructive hover:bg-destructive/10">
            <ArrowCounterClockwise size={16} />
            Reset Conversation
          </Button>
          <Separator />
          <Button
            onClick={handleDelete}
            loading={deleting}
            variant={confirmDelete ? 'destructive' : 'ghost'}
            className={
              confirmDelete
                ? 'w-full'
                : 'w-full justify-start text-muted-foreground hover:text-destructive hover:bg-destructive/10'
            }>
            <Trash size={16} />
            {confirmDelete ? 'Click again to confirm' : 'Delete Agent'}
          </Button>
          {confirmDelete && (
            <p className="text-[11px] text-destructive">
              This will permanently delete the agent and all conversation history.
            </p>
          )}
        </div>
      </section>

      {error && <p className="text-xs text-destructive text-center">{error}</p>}
    </div>
  );
}

// ─── Workspace Tab ──────────────────────────────────────────────────────────

function WorkspaceTab({ agentId, bridgeRpc }: { agentId: string; bridgeRpc: BridgeRpcFn }) {
  const [loading, setLoading] = useState(true);
  const [workspacePath, setWorkspacePath] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [notesFiles, setNotesFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [isRemote, setIsRemote] = useState(false);
  const [bridgeOnline, setBridgeOnline] = useState(true);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    loadWorkspace();
  }, [agentId]);

  async function loadWorkspace() {
    setLoading(true);
    setError('');
    setIsRemote(false);
    setBridgeOnline(true);
    try {
      const res = await fetch(apiUrl(`/api/agents/${agentId}/workspace`));
      const data = await res.json();

      if (res.ok) {
        // Local mode — API can read files directly
        setWorkspacePath(data.workspace_path || '');
        setFiles(data.files || []);
        setNotesFiles(data.notes_files || []);
        return;
      }

      if (data.error === 'remote_workspace') {
        // Remote mode — try RPC to bridge
        setIsRemote(true);
        setWorkspacePath(data.workspace_path || '');
        try {
          const rpcData = await bridgeRpc('list', { agentId });
          setWorkspacePath((rpcData.workspace_path as string) || data.workspace_path || '');
          setFiles((rpcData.files as FileEntry[]) || []);
          setNotesFiles((rpcData.notes_files as FileEntry[]) || []);
        } catch {
          setBridgeOnline(false);
        }
        return;
      }

      throw new Error(data.error || 'Failed to load workspace');
    } catch (err) {
      if (!isRemote) {
        setError(err instanceof Error ? err.message : 'Failed to load workspace');
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadFile(filePath: string) {
    setLoadingFile(true);
    setSelectedFile(filePath);
    setFileContent(null);
    try {
      if (isRemote) {
        const data = await bridgeRpc('read', { agentId, filePath });
        setFileContent(data.content as string);
      } else {
        const res = await fetch(apiUrl(`/api/agents/${agentId}/workspace?file=${encodeURIComponent(filePath)}`));
        if (!res.ok) throw new Error('Failed to read file');
        const data = await res.json();
        setFileContent(data.content);
      }
    } catch {
      setFileContent('[Failed to read file]');
    } finally {
      setLoadingFile(false);
    }
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
        <div className="text-sm text-muted-foreground">Loading workspace...</div>
      </div>
    );
  }

  if (isRemote && !bridgeOnline) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
        <FolderOpen size={32} className="text-muted-foreground/40" />
        <div className="text-center space-y-1.5">
          <p className="text-sm font-medium text-foreground">Bridge is offline</p>
          <p className="text-xs text-muted-foreground leading-relaxed max-w-[280px]">
            The workspace files are on the machine running the bridge. Start the bridge to browse them here.
          </p>
        </div>
        {workspacePath && (
          <code className="text-[11px] font-mono text-muted-foreground bg-muted rounded px-2 py-1 max-w-full truncate">
            {workspacePath}
          </code>
        )}
        <Button variant="link" size="sm" onClick={loadWorkspace}>
          <ArrowClockwise size={14} />
          Retry
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
          Retry
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
          <Button onClick={handleCopyPath} variant="ghost" size="icon-xs" aria-label="Copy path">
            <Copy size={14} />
          </Button>
          <Button onClick={loadWorkspace} variant="ghost" size="icon-xs" aria-label="Refresh">
            <ArrowClockwise size={14} />
          </Button>
        </div>
        {copied && (
          <Badge variant="success" className="text-[10px] ml-1">
            Copied!
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
              <Folder size={14} weight="fill" className="text-primary/60" />
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
              <div className="ml-6 py-1 text-[11px] text-muted-foreground italic">Empty</div>
            )}
          </div>
        )}

        {topLevelDirs.map((dir) => (
          <div key={dir.name} className="mt-1">
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
              <Folder size={14} weight="fill" className="opacity-60" />
              <span className="font-medium">{dir.name}/</span>
            </div>
          </div>
        ))}

        {topLevelFiles.length === 0 && !hasNotes && topLevelDirs.length === 0 && (
          <div className="px-3 py-8 text-center">
            <FolderOpen size={32} className="mx-auto text-muted-foreground/40 mb-2" />
            <p className="text-xs text-muted-foreground">Workspace is empty</p>
            <p className="text-[11px] text-muted-foreground mt-1">
              The agent will create files here as it learns from conversations.
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
                  aria-label="Preview Markdown">
                  <Eye size={14} />
                </Button>
              )}
              <Button
                onClick={() => {
                  setSelectedFile(null);
                  setFileContent(null);
                }}
                variant="ghost"
                size="icon-xs"
                aria-label="Close preview">
                <X size={14} />
              </Button>
            </div>
          </div>
          <div className="px-4 py-3 max-h-[400px] overflow-y-auto">
            {loadingFile ? (
              <p className="text-xs text-muted-foreground">Loading...</p>
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
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{fileContent || ''}</ReactMarkdown>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      {/* Info footer */}
      <div className="px-5 py-3 border-t">
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          This is the agent&apos;s persistent workspace. It stores{' '}
          <code className="text-[10px] px-1 py-0.5 rounded bg-muted">MEMORY.md</code> and notes that help the agent
          maintain context across conversations.
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
      <File size={14} weight={isMemory ? 'fill' : 'regular'} className={isMemory ? 'text-primary' : 'opacity-60'} />
      <span className={`flex-1 text-xs font-mono truncate ${isMemory ? 'font-medium' : ''}`}>
        {displayName || file.name}
      </span>
      <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatSize(file.size)}</span>
    </button>
  );
}
