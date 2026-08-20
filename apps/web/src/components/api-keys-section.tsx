"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyIcon, CopyIcon, CheckIcon, TrashIcon, PlusIcon } from "lucide-react";

interface ApiKey {
  id: string;
  key_prefix: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export function ApiKeysSection({ serverId }: { serverId: string }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showForm, setShowForm] = useState(false);

  async function loadKeys() {
    const res = await fetch(`/api/bridge/keys?server_id=${serverId}`);
    if (res.ok) {
      const data = await res.json();
      setKeys(data.keys);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadKeys();
  }, [serverId]);

  async function handleCreate() {
    setCreating(true);
    const res = await fetch("/api/bridge/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server_id: serverId,
        name: newKeyName.trim() || "Default",
      }),
    });

    if (res.ok) {
      const data = await res.json();
      setRevealedKey(data.apiKey);
      setNewKeyName("");
      setShowForm(false);
      loadKeys();
    }
    setCreating(false);
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/bridge/keys?id=${id}`, { method: "DELETE" });
    if (res.ok) {
      setKeys((prev) => prev.filter((k) => k.id !== id));
      if (revealedKey) setRevealedKey(null);
    }
  }

  function handleCopy(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) {
    return (
      <div className="text-sm text-muted-foreground">Loading keys...</div>
    );
  }

  return (
    <div className="w-full max-w-lg">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <KeyIcon className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-foreground">Bridge API Keys</h3>
        </div>
        {!showForm && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowForm(true)}
          >
            <PlusIcon className="size-3.5 mr-1.5" />
            New Key
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground mb-4">
        Generate an API key to connect your local bridge to this workspace.
      </p>

      {/* Revealed key (shown once after creation) */}
      {revealedKey && (
        <div className="mb-4 rounded-lg border border-primary/20 bg-primary/5 p-3">
          <p className="text-xs font-medium text-foreground mb-2">
            Copy this key now — it won't be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-background rounded px-2 py-1.5 border font-mono break-all select-all">
              {revealedKey}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleCopy(revealedKey)}
            >
              {copied ? (
                <CheckIcon className="size-3.5" />
              ) : (
                <CopyIcon className="size-3.5" />
              )}
            </Button>
          </div>
          <div className="mt-3 rounded-md bg-background border p-2">
            <p className="text-xs text-muted-foreground mb-1">Quick start:</p>
            <code className="text-xs font-mono break-all select-all text-foreground">
              npx @fehey/zano-bridge --api-key {revealedKey}
            </code>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 text-xs"
            onClick={() => setRevealedKey(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <div className="mb-4 flex items-center gap-2">
          <Input
            placeholder="Key name (optional)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            className="text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
          />
          <Button size="sm" onClick={handleCreate} disabled={creating}>
            {creating ? "Creating..." : "Create"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowForm(false);
              setNewKeyName("");
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      {/* Key list */}
      {keys.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No API keys yet. Create one to connect a bridge.
        </p>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <div
              key={k.id}
              className="flex items-center justify-between rounded-lg border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">
                  {k.name}
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  {k.key_prefix}...
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className="text-xs text-muted-foreground">
                  {k.last_used_at
                    ? `Used ${new Date(k.last_used_at).toLocaleDateString()}`
                    : "Never used"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(k.id)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <TrashIcon className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
