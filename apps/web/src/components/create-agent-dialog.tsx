"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { Field, FieldLabel } from "@/components/ui/field";
import { apiUrl } from "@/lib/api-url";
import { useAppSettings } from "@/hooks/use-app-settings";
import {
  CODEX_MODEL_ITEMS,
  defaultModelForRuntime,
  type AgentRuntimeId,
} from "@/lib/agent-runtime";
import {
  loadModelConnections,
  type ModelConnection,
} from "@/lib/model-connections";

interface CreateAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  serverId: string;
}

export function CreateAgentDialog({
  open,
  onClose,
  onCreated,
  serverId,
}: CreateAgentDialogProps) {
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [runtime, setRuntime] = useState<AgentRuntimeId>("claude-code");
  const [model, setModel] = useState("opus");
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { settings, t } = useAppSettings();
  const localMode = process.env.NEXT_PUBLIC_ZANO_LOCAL_MODE === "true";
  const modelItems = [
    { value: "opus", label: t("settings.modelOpus") },
    { value: "sonnet", label: t("settings.modelSonnet") },
    { value: "haiku", label: t("settings.modelHaiku") },
  ];

  useEffect(() => {
    if (open) {
      setDisplayName("");
      setDescription("");
      setRuntime(settings.defaultRuntime);
      setModel(settings.defaultModel);
      setConnectionId(settings.defaultConnectionId);
      setSystemPrompt("");
      setError("");
      if (localMode) {
        void loadModelConnections().then(setConnections).catch(() => setConnections([]));
      }
    }
  }, [open, settings.defaultModel, settings.defaultRuntime]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!displayName.trim()) return;

    setSaving(true);
    setError("");

    try {
      const supabase = createClient();
      await supabase.auth.getSession();

      const res = await fetch(apiUrl("/api/agents"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: document.cookie,
        },
        body: JSON.stringify({
          display_name: displayName,
          description,
          runtime,
          model,
          connection_id: runtime === "pi" ? connectionId : null,
          system_prompt: systemPrompt,
          server_id: serverId,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create agent");
      }

      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setSaving(false);
    }
  }

  const selectedModel = modelItems.find((item) => item.value === model) ?? modelItems[0];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("createAgent.title")}</DialogTitle>
          <DialogDescription>{t("createAgent.description")}</DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogPanel>
            <div className="space-y-4">
              <Field>
                <FieldLabel>{t("createAgent.name")}</FieldLabel>
                <Input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName((e.target as HTMLInputElement).value)}
                  placeholder={t("createAgent.namePlaceholder")}
                  required
                  autoFocus
                />
              </Field>

              <Field>
                <FieldLabel>
                  {t("createAgent.descriptionField")} <span className="text-muted-foreground font-normal">({t("createAgent.optional")})</span>
                </FieldLabel>
                <Input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription((e.target as HTMLInputElement).value)}
                  placeholder={t("createAgent.descriptionPlaceholder")}
                />
              </Field>

              <Field>
                <FieldLabel>{t("createAgent.runtime")}</FieldLabel>
                <select
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
                  value={runtime}
                  onChange={(event) => {
                    const nextRuntime = event.target.value as AgentRuntimeId;
                    setRuntime(nextRuntime);
                    setModel(defaultModelForRuntime(nextRuntime));
                    if (nextRuntime === "pi") {
                      const connection = connections.find((entry) => entry.hasCredential);
                      setConnectionId(connection?.id || null);
                      if (connection) setModel(connection.default_model);
                    } else {
                      setConnectionId(null);
                    }
                  }}
                >
                  <option value="claude-code">{t("settings.runtimeClaude")}</option>
                  <option value="codex">{t("settings.runtimeCodex")}</option>
                  {localMode && <option value="pi">{t("settings.runtimePi")}</option>}
                </select>
              </Field>

              <Field>
                <FieldLabel>{t("createAgent.model")}</FieldLabel>
                {runtime === "claude-code" ? (
                  <Select
                    value={selectedModel}
                    onValueChange={(val) => {
                      if (val) setModel((val as typeof selectedModel).value);
                    }}
                    items={modelItems}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectPopup>
                      {modelItems.map((item) => (
                        <SelectItem key={item.value} value={item}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : runtime === "codex" ? (
                  <select
                    className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    {!CODEX_MODEL_ITEMS.some((item) => item.value === model) && (
                      <option value={model}>{model}</option>
                    )}
                    {CODEX_MODEL_ITEMS.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                ) : (
                  <Input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder={t("settings.codexModelPlaceholder")}
                  />
                )}
              </Field>

              {runtime === "pi" && (
                <Field>
                  <FieldLabel>{t("settings.chooseConnection")}</FieldLabel>
                  <select
                    className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
                    value={connectionId || ""}
                    onChange={(event) => {
                      const connection = connections.find((entry) => entry.id === event.target.value);
                      setConnectionId(connection?.id || null);
                      if (connection) setModel(connection.default_model);
                    }}
                  >
                    <option value="">—</option>
                    {connections.filter((connection) => connection.hasCredential).map((connection) => (
                      <option key={connection.id} value={connection.id}>{connection.name}</option>
                    ))}
                  </select>
                </Field>
              )}

              <Field>
                <FieldLabel>
                  {t("createAgent.instructions")} <span className="text-muted-foreground font-normal">({t("createAgent.optional")})</span>
                </FieldLabel>
                <Textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt((e.target as HTMLTextAreaElement).value)}
                  placeholder={t("createAgent.instructionsPlaceholder")}
                />
              </Field>

              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>
              {t("createAgent.cancel")}
            </DialogClose>
            <Button
              type="submit"
              loading={saving}
              disabled={!displayName.trim() || (runtime === "pi" && !connectionId)}
            >
              {t("createAgent.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
