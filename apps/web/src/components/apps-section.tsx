"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircleIcon, CableIcon, Loader2Icon, PlusIcon, PuzzleIcon, Trash2Icon, UnplugIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { createClient } from "@/lib/supabase/client";
import { afterPaint } from "@/lib/after-paint";
import { useAppSettings, type TranslationKey } from "@/hooks/use-app-settings";
import { CONNECTOR_ICON_PATHS } from "@/lib/connector-icons";
import { AutomationsSection } from "@/components/automations-section";
import {
  catalogFor,
  type CatalogEntry,
  type ConnectorCategory,
} from "@/lib/connector-catalog";

interface SkillRow {
  id: string;
  slug: string;
  source: string;
  display_name: string | null;
  description: string | null;
  version: string | null;
  path: string | null;
  enabled: boolean | number;
}

interface ConnectorRow {
  id: string;
  name: string;
  command: string;
  args: string | null;
  env: string | null;
  description: string | null;
  enabled: boolean | number;
}

const isEnabled = (value: boolean | number | undefined) => Boolean(value);

const SOURCE_LABELS: Record<string, TranslationKey> = {
  "claude-code": "apps.sourceClaude",
  codex: "apps.sourceCodex",
  pi: "apps.sourcePi",
};

function AppsHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="relative flex h-16 shrink-0 items-center border-b px-6">
      <div
        aria-hidden="true"
        className="desktop-native-drag absolute inset-0"
        data-tauri-drag-region
      />
      <div className="pointer-events-none relative min-w-0">
        <h1 className="truncate text-[15px] font-semibold text-foreground">{title}</h1>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </header>
  );
}

export function AppsSection({ serverId }: { serverId: string }) {
  const { t } = useAppSettings();
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [connectors, setConnectors] = useState<ConnectorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ConnectorRow | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ConnectorRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState("");

  const load = useCallback(async () => {
    if (!serverId) return;
    const client = createClient();
    const [skillsResult, connectorsResult] = await Promise.all([
      client
        .from("app_skills")
        .select("id, slug, source, display_name, description, version, path, enabled")
        .eq("server_id", serverId)
        .order("source")
        .order("slug"),
      client
        .from("app_connectors")
        .select("id, name, command, args, env, description, enabled")
        .eq("server_id", serverId)
        .order("name"),
    ]);
    if (skillsResult.error || connectorsResult.error) {
      setError(skillsResult.error?.message || connectorsResult.error?.message || "");
      setLoading(false);
      return;
    }
    setSkills((skillsResult.data ?? []) as SkillRow[]);
    setConnectors((connectorsResult.data ?? []) as unknown as ConnectorRow[]);
    setError("");
    setLoading(false);
  }, [serverId]);

  // Deferred off the first render, but not on rAF alone: a hidden window gets
  // no animation frames, and this panel would sit on its loading line forever.
  useEffect(() => afterPaint(() => void load()), [load]);

  const setSkillEnabled = async (skill: SkillRow, enabled: boolean) => {
    setActionError("");
    setSkills((rows) =>
      rows.map((row) => (row.id === skill.id ? { ...row, enabled } : row)),
    );
    const { error: updateError } = await createClient()
      .from("app_skills")
      .update({ enabled })
      .eq("id", skill.id);
    if (updateError) {
      setActionError(t("apps.updateFailed"));
      void load();
    }
  };

  const setConnectorEnabled = async (connector: ConnectorRow, enabled: boolean) => {
    setActionError("");
    setConnectors((rows) =>
      rows.map((row) => (row.id === connector.id ? { ...row, enabled } : row)),
    );
    const { error: updateError } = await createClient()
      .from("app_connectors")
      .update({ enabled })
      .eq("id", connector.id);
    if (updateError) {
      setActionError(t("apps.updateFailed"));
      void load();
    }
  };

  const deleteConnector = async (connector: ConnectorRow) => {
    if (deleting) return;
    setDeleting(true);
    setActionError("");
    const { error: deleteError } = await createClient()
      .from("app_connectors")
      .delete()
      .eq("id", connector.id);
    setDeleting(false);
    if (deleteError) {
      setActionError(t("apps.deleteConnectorFailed"));
      return;
    }
    setConnectors((rows) => rows.filter((row) => row.id !== connector.id));
    setPendingDelete(null);
  };

  const sortedSkills = useMemo(
    () =>
      [...skills].sort((a, b) =>
        a.source === b.source
          ? a.slug.localeCompare(b.slug)
          : a.source.localeCompare(b.source),
      ),
    [skills],
  );

  if (loading) {
    return (
      <div className="flex h-full flex-col bg-card">
        <AppsHeader title={t("apps.title")} subtitle={t("apps.subtitle")} />
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          <span aria-live="polite" role="status">{t("apps.loading")}</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col bg-card">
        <AppsHeader title={t("apps.title")} subtitle={t("apps.subtitle")} />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
          <p className="max-w-lg" role="alert">{t("apps.loadFailed")} · {error}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            {t("runtime.retry")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-card">
      <AppsHeader title={t("apps.title")} subtitle={t("apps.subtitle")} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-6 py-6">
        {actionError && (
          <div
            className="mb-5 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            <AlertCircleIcon className="size-4 shrink-0" />
            <span>{actionError}</span>
          </div>
        )}

        <ConnectorCatalog
          installed={connectors}
          onInstalled={() => void load()}
          serverId={serverId}
        />

        <AutomationsSection serverId={serverId} />

        <section aria-labelledby="apps-skills-heading" className="mt-8">
          <h2 id="apps-skills-heading" className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <PuzzleIcon className="size-4" />
            {t("apps.skills")}
            <Badge variant="secondary">{sortedSkills.length}</Badge>
          </h2>
          {sortedSkills.length === 0 ? (
            <Card className="p-6 text-center text-sm text-muted-foreground">
              {t("apps.skillsEmpty")}
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {sortedSkills.map((skill) => (
                <Card key={skill.id} className="flex items-start gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {skill.display_name || skill.slug}
                      </span>
                      <Badge variant="outline">
                        {t(SOURCE_LABELS[skill.source] ?? "apps.sourceUnknown")}
                      </Badge>
                      {skill.version && (
                        <span className="text-xs text-muted-foreground">v{skill.version}</span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {skill.description}
                    </p>
                  </div>
                  <Switch
                    checked={isEnabled(skill.enabled)}
                    onCheckedChange={(checked) => void setSkillEnabled(skill, checked)}
                    aria-label={`${t("apps.enable")} ${skill.display_name || skill.slug}`}
                  />
                </Card>
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="apps-connectors-heading" className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="apps-connectors-heading" className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <CableIcon className="size-4" />
              {t("apps.connectors")}
              <Badge variant="secondary">{connectors.length}</Badge>
            </h2>
            <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
              <PlusIcon className="size-3.5" />
              {t("apps.addConnector")}
            </Button>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{t("apps.connectorsHint")}</p>
          {connectors.length === 0 ? (
            <Card className="p-6 text-center text-sm text-muted-foreground">
              {t("apps.connectorsEmpty")}
            </Card>
          ) : (
            <div className="grid gap-3">
              {connectors.map((connector) => (
                <ConnectorCard
                  key={connector.id}
                  connector={connector}
                  onEdit={() => setEditing(connector)}
                  onDelete={() => {
                    setActionError("");
                    setPendingDelete(connector);
                  }}
                  onToggle={(enabled) => void setConnectorEnabled(connector, enabled)}
                />
              ))}
            </div>
          )}
        </section>
        </div>
      </div>

      {(showCreate || editing) && (
        <ConnectorDialog
          serverId={serverId}
          initial={editing}
          onClose={() => {
            setShowCreate(false);
            setEditing(null);
          }}
          onSaved={() => {
            setShowCreate(false);
            setEditing(null);
            void load();
          }}
        />
      )}
      <AlertDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("apps.deleteConnectorTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("apps.deleteConnectorDescription", { name: pendingDelete?.name || "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {actionError && (
            <p className="px-1 text-sm text-destructive" role="alert">
              {actionError}
            </p>
          )}
          <AlertDialogFooter>
            <Button variant="ghost" disabled={deleting} onClick={() => setPendingDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={deleting}
              onClick={() => {
                if (pendingDelete) void deleteConnector(pendingDelete);
              }}
            >
              {t("common.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function ConnectorCard({
  connector,
  onEdit,
  onDelete,
  onToggle,
}: {
  connector: ConnectorRow;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useAppSettings();
  return (
    <Card className="flex items-start gap-3 p-4">
      <UnplugIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{connector.name}</div>
        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {connector.command}
        </p>
        {connector.description && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{connector.description}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          aria-label={t("common.edit")}
          size="icon-sm"
          variant="ghost"
          onClick={onEdit}
          title={t("common.edit")}
        >
          <PuzzleIcon className="size-3.5" />
        </Button>
        <Button
          aria-label={t("common.delete")}
          size="icon-sm"
          variant="ghost"
          onClick={onDelete}
          title={t("common.delete")}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
        <Switch
          checked={isEnabled(connector.enabled)}
          onCheckedChange={onToggle}
          aria-label={`${t("apps.enable")} ${connector.name}`}
        />
      </div>
    </Card>
  );
}

function ConnectorDialog({
  serverId,
  initial,
  onClose,
  onSaved,
}: {
  serverId: string;
  initial: ConnectorRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useAppSettings();
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [argsText, setArgsText] = useState(() => {
    if (!initial?.args) return "";
    try {
      const parsed = JSON.parse(initial.args);
      return Array.isArray(parsed) ? parsed.join("\n") : initial.args;
    } catch {
      return initial.args;
    }
  });
  const [description, setDescription] = useState(initial?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const args = useMemo(
    () =>
      argsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    [argsText],
  );

  const save = async () => {
    if (!name.trim() || !command.trim()) {
      setSaveError(t("apps.connectorRequired"));
      return;
    }
    setSaving(true);
    setSaveError("");
    const client = createClient();
    const payload = {
      server_id: serverId,
      name: name.trim(),
      command: command.trim(),
      args: JSON.stringify(args),
      env: "{}",
      description: description.trim() || null,
    };
    const { error: saveErrorFromDb } = initial
      ? await client.from("app_connectors").update(payload).eq("id", initial.id)
      : await client.from("app_connectors").insert(payload);
    setSaving(false);
    if (saveErrorFromDb) {
      setSaveError(saveErrorFromDb.message);
      return;
    }
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{initial ? t("apps.editConnector") : t("apps.addConnector")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <Field>
            <FieldLabel>{t("apps.connectorName")}</FieldLabel>
            <Input value={name} onChange={(event) => setName((event.target as HTMLInputElement).value)} placeholder="github" />
          </Field>
          <Field>
            <FieldLabel>{t("apps.connectorCommand")}</FieldLabel>
            <Input
              value={command}
              onChange={(event) => setCommand((event.target as HTMLInputElement).value)}
              placeholder="npx"
              className="font-mono"
            />
          </Field>
          <Field>
            <FieldLabel>{t("apps.connectorArgs")}</FieldLabel>
            <Textarea
              value={argsText}
              onChange={(event) => setArgsText(event.target.value)}
              rows={3}
              className="font-mono"
              placeholder={"-y\n@modelcontextprotocol/server-github"}
            />
            <p className="text-xs text-muted-foreground">{t("apps.connectorArgsHint")}</p>
          </Field>
          <Field>
            <FieldLabel>{t("apps.connectorDescription")}</FieldLabel>
            <Input value={description} onChange={(event) => setDescription((event.target as HTMLInputElement).value)} />
          </Field>
          {saveError && <p className="text-xs text-destructive">{saveError}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * The browsable half of the panel.
 *
 * Doubao leads its 技能·连接器 page with this rather than with what you already
 * have, and the ordering is the point: a list of your existing connectors only
 * helps once you know what exists. Categories across the top, a search beside
 * them, and a grid of cards where the whole interaction is one `+`.
 *
 * An entry that is already installed says so instead of offering to add it
 * twice — matching is by name, which is what app_connectors is unique on.
 */
function ConnectorCatalog({
  installed,
  onInstalled,
  serverId,
}: {
  installed: ConnectorRow[];
  onInstalled: () => void;
  serverId: string;
}) {
  const { t } = useAppSettings();
  const searchParams = useSearchParams();
  const category = (searchParams.get("category") || "featured") as ConnectorCategory;
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [installFailure, setInstallFailure] = useState<{
    message: string;
    scope: string;
  } | null>(null);
  const installScope = `${category}\u0000${query}`;
  const installError = installFailure?.scope === installScope ? installFailure.message : "";

  const installedNames = useMemo(
    () => new Set(installed.map((row) => row.name)),
    [installed],
  );
  const entries = useMemo(() => catalogFor(category, query), [category, query]);

  const install = async (entry: CatalogEntry) => {
    setPending(entry.id);
    setInstallFailure(null);
    // The placeholder rides along in the arguments and in the environment so
    // the connector is visible and editable rather than silently broken; the
    // add is the fast path, filling in the specifics stays a deliberate edit.
    const args = entry.argument
      ? [...entry.args, entry.argument.placeholder]
      : entry.args;
    const env = Object.fromEntries(
      (entry.requires || []).map((required) => [required.key, ""]),
    );
    const { error } = await createClient()
      .from("app_connectors")
      .insert({
        args: JSON.stringify(args),
        command: entry.command,
        description: entry.description,
        env: JSON.stringify(env),
        name: entry.name,
        server_id: serverId,
      });
    setPending(null);
    if (error) {
      setInstallFailure({
        message: t("apps.installConnectorFailed", { name: entry.name }),
        scope: installScope,
      });
      return;
    }
    onInstalled();
  };

  return (
    <section aria-labelledby="apps-catalog-heading">
      <div className="mb-3 flex items-center gap-2">
        <h2
          id="apps-catalog-heading"
          className="flex items-center gap-2 text-sm font-semibold text-foreground"
        >
          <CableIcon className="size-4" />
          {t("apps.catalog")}
        </h2>
        <div className="relative ml-auto w-56">
          <Input
            aria-label={t("apps.catalogSearch")}
            className="h-8 text-[13px]"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("apps.catalogSearch")}
            value={query}
          />
        </div>
      </div>

      {installError && (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {installError}
        </p>
      )}

      {entries.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          {t("apps.catalogEmpty")}
        </Card>
      ) : (
        // Two across, and no card around any of them. Doubao runs three, but its
        // window is half again as wide — at our width three would be 347px a row
        // and the descriptions would all clip. Two lands on 560px, which is the
        // width their cards actually are. Their grid carries
        // no borders or fills at rest — what separates one entry from the next
        // is the space between them, which is why a page of twenty reads as
        // calm where twenty bordered boxes would read as a form.
        <div className="grid gap-x-8 gap-y-1 md:grid-cols-2">
          {entries.map((entry) => {
            const already = installedNames.has(entry.name);
            const icon = CONNECTOR_ICON_PATHS[entry.id];
            return (
              <div
                key={entry.id}
                className="group flex items-center gap-3 rounded-xl px-2.5 py-3 transition-colors hover:bg-foreground/4"
              >
                {/* A pale disc with the mark in its own colour, rather than a
                    solid block of brand: at 44px a dozen saturated tiles fight
                    each other, and the logo is the thing worth seeing. */}
                <span
                  aria-hidden="true"
                  className="flex size-11 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ring-1 ring-foreground/8"
                  style={{
                    backgroundColor: icon ? `${entry.tint}14` : entry.tint,
                    color: icon ? entry.tint : "#fff",
                  }}
                >
                  {icon ? (
                    <svg className="size-[22px]" fill="currentColor" viewBox="0 0 24 24">
                      <path d={icon} />
                    </svg>
                  ) : (
                    entry.initials
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[14px] font-medium text-foreground">
                      {entry.name}
                    </span>
                    <Badge variant="secondary">{t("apps.connectorBadge")}</Badge>
                  </div>
                  {/* One line, clipped. The credentials a connector wants move
                      to the tooltip so every row is the same height — a grid
                      where some cells are taller is what made this look busy. */}
                  <p
                    className="truncate text-[12px] text-muted-foreground"
                    title={
                      entry.requires?.length
                        ? `${entry.description}\n${t("apps.catalogNeeds")}${entry.requires
                            .map((required) => required.label)
                            .join(" · ")}`
                        : entry.description
                    }
                  >
                    {entry.description}
                  </p>
                </div>

                <Button
                  aria-label={entry.name}
                  className="size-8 shrink-0 rounded-full bg-foreground/6 text-foreground/70 transition-colors hover:bg-foreground/12 hover:text-foreground"
                  disabled={already || pending === entry.id}
                  onClick={() => void install(entry)}
                  size="icon-sm"
                  variant="ghost"
                >
                  {pending === entry.id ? (
                    <Loader2Icon className="animate-spin" />
                  ) : already ? (
                    <UnplugIcon />
                  ) : (
                    <PlusIcon />
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
