"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClockIcon, Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { createClient } from "@/lib/supabase/client";
import { useAppSettings } from "@/hooks/use-app-settings";
import { describeSchedule, nextRunAfter, validateSchedule } from "@teammate/shared/cron";

interface AgentOption {
  id: string;
  display_name: string;
}

interface AutomationRow {
  id: string;
  agent_id: string;
  channel_id: string | null;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean | number;
  last_run_at: string | null;
  next_run_at: string | null;
}

function isEnabled(value: boolean | number | undefined) {
  return Boolean(value);
}

export function AutomationsSection({ serverId }: { serverId: string }) {
  const { t } = useAppSettings();
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [automations, setAutomations] = useState<AutomationRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!serverId) return;
    const client = createClient();
    const [agentRows, automationRows] = await Promise.all([
      client
        .from("agents")
        .select("id, display_name")
        .eq("server_id", serverId)
        .order("created_at"),
      client
        .from("agent_automations")
        .select("id, agent_id, channel_id, name, schedule, prompt, enabled, last_run_at, next_run_at")
        .eq("server_id", serverId)
        .order("created_at"),
    ]);
    if (automationRows.error) {
      setError(automationRows.error.message);
      setLoaded(true);
      return;
    }
    setAgents((agentRows.data ?? []) as AgentOption[]);
    setAutomations((automationRows.data ?? []) as unknown as AutomationRow[]);
    setError("");
    setLoaded(true);
  }, [serverId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const setEnabled = async (automation: AutomationRow, enabled: boolean) => {
    setAutomations((rows) =>
      rows.map((row) => (row.id === automation.id ? { ...row, enabled } : row)),
    );
    const { error: updateError } = await createClient()
      .from("agent_automations")
      .update({ enabled })
      .eq("id", automation.id);
    if (updateError) void load();
  };

  const remove = async (automation: AutomationRow) => {
    const { error: deleteError } = await createClient()
      .from("agent_automations")
      .delete()
      .eq("id", automation.id);
    if (!deleteError) {
      setAutomations((rows) => rows.filter((row) => row.id !== automation.id));
    }
  };

  const agentName = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.display_name])),
    [agents],
  );

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        {t("automations.loading")}
      </div>
    );
  }

  return (
    <section aria-labelledby="apps-automations-heading" className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="apps-automations-heading" className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <CalendarClockIcon className="size-4" />
          {t("automations.title")}
          <Badge variant="secondary">{automations.length}</Badge>
        </h2>
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <PlusIcon className="size-3.5" />
          {t("automations.add")}
        </Button>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{t("automations.hint")}</p>
      {error ? (
        <Card className="p-4 text-sm text-destructive">{error}</Card>
      ) : automations.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          {t("automations.empty")}
        </Card>
      ) : (
        <div className="grid gap-3">
          {automations.map((automation) => (
            <Card key={automation.id} className="flex items-start gap-3 p-4">
              <CalendarClockIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">{automation.name}</div>
                <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                  {describeSchedule(automation.schedule)}
                </p>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  → {agentName.get(automation.agent_id) ?? automation.agent_id.slice(0, 8)}
                  {automation.next_run_at
                    ? ` · ${t("automations.nextRun")}: ${new Date(automation.next_run_at).toLocaleString()}`
                    : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => void remove(automation)}
                  title={t("common.delete")}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
                <Switch
                  checked={isEnabled(automation.enabled)}
                  onCheckedChange={(checked) => void setEnabled(automation, checked)}
                  aria-label={`${t("apps.enable")} ${automation.name}`}
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      {creating && (
        <AutomationDialog
          serverId={serverId}
          agents={agents}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
    </section>
  );
}

function AutomationDialog({
  serverId,
  agents,
  onClose,
  onSaved,
}: {
  serverId: string;
  agents: AgentOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useAppSettings();
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const scheduleValid = validateSchedule(schedule);

  const save = async () => {
    if (!name.trim() || !agentId || !prompt.trim() || !scheduleValid) {
      setSaveError(t("automations.required"));
      return;
    }
    setSaving(true);
    const nextRunAt = nextRunAfter(schedule.trim(), Date.now());
    if (nextRunAt === null) {
      setSaving(false);
      setSaveError(t("automations.scheduleInvalid"));
      return;
    }
    const { error: insertError } = await createClient()
      .from("agent_automations")
      .insert({
        server_id: serverId,
        name: name.trim(),
        agent_id: agentId,
        schedule: schedule.trim(),
        prompt: prompt.trim(),
        enabled: true,
        next_run_at: new Date(nextRunAt).toISOString(),
      });
    setSaving(false);
    if (insertError) {
      setSaveError(insertError.message);
      return;
    }
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("automations.add")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <Field>
            <FieldLabel>{t("automations.name")}</FieldLabel>
            <Input value={name} onChange={(event) => setName((event.target as HTMLInputElement).value)} placeholder={t("automations.namePlaceholder")} />
          </Field>
          <Field>
            <FieldLabel>{t("automations.agent")}</FieldLabel>
            <Select
              value={agentId}
              items={agents.map((agent) => ({ label: agent.display_name, value: agent.id }))}
              onValueChange={(next) => setAgentId(String(next))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectPopup>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>{agent.display_name}</SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field>
            <FieldLabel>{t("automations.schedule")}</FieldLabel>
            <Input
              value={schedule}
              onChange={(event) => setSchedule((event.target as HTMLInputElement).value)}
              className={`font-mono ${scheduleValid ? "" : "border-destructive"}`}
            />
            <p className="text-xs text-muted-foreground">
              {scheduleValid ? describeSchedule(schedule.trim()) : t("automations.scheduleInvalid")}
            </p>
          </Field>
          <Field>
            <FieldLabel>{t("automations.prompt")}</FieldLabel>
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              placeholder={t("automations.promptPlaceholder")}
            />
          </Field>
          {saveError && <p className="text-xs text-destructive">{saveError}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
