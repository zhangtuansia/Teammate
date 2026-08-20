import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AppSettingsContext,
  defaultAppSettings,
  translate,
  type AgentModel,
  type AgentRuntime,
  type AppLanguage,
  type AppSettings,
  type AppTheme,
} from "@/hooks/use-app-settings";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { CODEX_MODEL_ITEMS } from "@/lib/agent-runtime";
import {
  loadModelConnections,
  type ModelConnection,
} from "@/lib/model-connections";
import { ConnectionsSection } from "./model-connections";

const SETTINGS_URL = "http://127.0.0.1:8787/api/settings";
const RUNTIMES_URL = "http://127.0.0.1:8787/api/runtimes";

interface RuntimeStatus {
  id: AgentRuntime;
  name: string;
  defaultModel: string;
  executable: string | null;
  installed: boolean;
}

const selectClassName =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-3 focus:ring-ring/20";

export function DesktopSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>({
    ...defaultAppSettings,
    language: "zh-CN",
  });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      for (let attempt = 0; attempt < 80 && !cancelled; attempt += 1) {
        try {
          const response = await fetch(SETTINGS_URL);
          if (response.ok) {
            const result = (await response.json()) as { settings: Partial<AppSettings> };
            if (!cancelled) {
              setSettings({ ...defaultAppSettings, ...result.settings });
            }
            return;
          }
        } catch {
          // The packaged local runtime may still be starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }

    void loadSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const dark = settings.theme === "dark" || (settings.theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      document.documentElement.lang = settings.language;
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [settings.language, settings.theme]);

  const value = useMemo(
    () => ({
      settings,
      t: (key: Parameters<typeof translate>[1], values?: Record<string, string>) =>
        translate(settings.language, key, values),
      openSettings: () => setOpen(true),
    }),
    [settings],
  );

  return (
    <AppSettingsContext.Provider value={value}>
      {children}
      <DesktopSettingsDialog
        open={open}
        settings={settings}
        onClose={() => setOpen(false)}
        onSaved={(next) => {
          setSettings(next);
          setOpen(false);
        }}
      />
    </AppSettingsContext.Provider>
  );
}

function DesktopSettingsDialog({
  open,
  settings,
  onClose,
  onSaved,
}: {
  open: boolean;
  settings: AppSettings;
  onClose: () => void;
  onSaved: (settings: AppSettings) => void;
}) {
  const [language, setLanguage] = useState<AppLanguage>(settings.language);
  const [theme, setTheme] = useState<AppTheme>(settings.theme);
  const [defaultRuntime, setDefaultRuntime] = useState<AgentRuntime>(settings.defaultRuntime);
  const [defaultModel, setDefaultModel] = useState<AgentModel>(settings.defaultModel);
  const [defaultConnectionId, setDefaultConnectionId] = useState<string | null>(
    settings.defaultConnectionId,
  );
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);

  useEffect(() => {
    if (!open) return;
    setLanguage(settings.language);
    setTheme(settings.theme);
    setDefaultRuntime(settings.defaultRuntime);
    setDefaultModel(settings.defaultModel);
    setDefaultConnectionId(settings.defaultConnectionId);
    setError("");
    void fetch(RUNTIMES_URL)
      .then((response) => response.json())
      .then((result: { runtimes?: RuntimeStatus[] }) => {
        setRuntimes(result.runtimes || []);
      })
      .catch(() => setRuntimes([]));
    void loadModelConnections()
      .then(setConnections)
      .catch(() => setConnections([]));
  }, [open, settings]);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(SETTINGS_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language,
          theme,
          defaultRuntime,
          defaultModel,
          defaultConnectionId,
        }),
      });
      const result = (await response.json()) as { settings?: AppSettings; error?: string };
      if (!response.ok || !result.settings) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }
      onSaved(result.settings);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPopup className="max-h-[84vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("settings.title")}</DialogTitle>
          <DialogDescription>{t("settings.description")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-6">
            <section className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("settings.interface")}
              </h3>
              <Field>
                <FieldLabel>{t("settings.language")}</FieldLabel>
                <select
                  className={selectClassName}
                  value={language}
                  onChange={(event) => setLanguage(event.target.value as AppLanguage)}
                >
                  <option value="zh-CN">{t("settings.languageZh")}</option>
                  <option value="en-US">{t("settings.languageEn")}</option>
                </select>
              </Field>
              <Field>
                <FieldLabel>{t("settings.appearance")}</FieldLabel>
                <select
                  className={selectClassName}
                  value={theme}
                  onChange={(event) => setTheme(event.target.value as AppTheme)}
                >
                  <option value="system">{t("settings.themeSystem")}</option>
                  <option value="light">{t("settings.themeLight")}</option>
                  <option value="dark">{t("settings.themeDark")}</option>
                </select>
              </Field>
            </section>

            <section className="space-y-4 border-t pt-5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("settings.agentRuntime")}
              </h3>
              <Field>
                <FieldLabel>{t("settings.runtime")}</FieldLabel>
                <select
                  className={selectClassName}
                  value={defaultRuntime}
                  onChange={(event) => {
                    const runtime = event.target.value as AgentRuntime;
                    setDefaultRuntime(runtime);
                    setDefaultModel(runtime === "claude-code" ? "sonnet" : "default");
                    if (runtime === "pi" && !defaultConnectionId) {
                      const first = connections.find((connection) => connection.hasCredential);
                      setDefaultConnectionId(first?.id || null);
                      if (first) setDefaultModel(first.default_model);
                    }
                  }}
                >
                  <option value="claude-code">{t("settings.runtimeClaude")}</option>
                  <option value="codex">{t("settings.runtimeCodex")}</option>
                  <option value="pi">{t("settings.runtimePi")}</option>
                </select>
                {runtimes.find((runtime) => runtime.id === defaultRuntime) && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {runtimes.find((runtime) => runtime.id === defaultRuntime)?.installed
                      ? t("settings.runtimeInstalled")
                      : t("settings.runtimeMissing")}
                  </p>
                )}
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {t("settings.runtimeHint")}
                </p>
              </Field>
              <Field>
                <FieldLabel>{t("settings.defaultModel")}</FieldLabel>
                {defaultRuntime === "claude-code" ? (
                  <select
                    className={selectClassName}
                    value={defaultModel}
                    onChange={(event) => setDefaultModel(event.target.value as AgentModel)}
                  >
                    <option value="opus">{t("settings.modelOpus")}</option>
                    <option value="sonnet">{t("settings.modelSonnet")}</option>
                    <option value="haiku">{t("settings.modelHaiku")}</option>
                  </select>
                ) : defaultRuntime === "codex" ? (
                  <select
                    className={selectClassName}
                    value={defaultModel}
                    onChange={(event) => setDefaultModel(event.target.value)}
                  >
                    {!CODEX_MODEL_ITEMS.some((item) => item.value === defaultModel) && (
                      <option value={defaultModel}>{defaultModel}</option>
                    )}
                    {CODEX_MODEL_ITEMS.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                ) : (
                  <Input value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} />
                )}
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {t("settings.modelHint")}
                </p>
              </Field>
              {defaultRuntime === "pi" && (
                <Field>
                  <FieldLabel>{t("settings.chooseConnection")}</FieldLabel>
                  <select
                    className={selectClassName}
                    value={defaultConnectionId || ""}
                    onChange={(event) => {
                      const connection = connections.find((entry) => entry.id === event.target.value);
                      setDefaultConnectionId(connection?.id || null);
                      if (connection) setDefaultModel(connection.default_model);
                    }}
                  >
                    <option value="">—</option>
                    {connections.filter((connection) => connection.hasCredential).map((connection) => (
                      <option key={connection.id} value={connection.id}>{connection.name}</option>
                    ))}
                  </select>
                </Field>
              )}
            </section>
            <ConnectionsSection
              t={t}
              connections={connections}
              onConnectionsChanged={(next) => {
                setConnections(next);
                if (defaultConnectionId && !next.some((entry) => entry.id === defaultConnectionId)) {
                  setDefaultConnectionId(null);
                }
              }}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onClose} disabled={saving}>
            {t("settings.cancel")}
          </Button>
          <Button type="button" onClick={save} disabled={saving}>
            {saving ? t("settings.saving") : t("settings.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
