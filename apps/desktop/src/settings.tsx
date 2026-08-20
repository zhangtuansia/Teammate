import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AppSettingsContext,
  defaultAppSettings,
  translate,
  type AgentModel,
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

const SETTINGS_URL = "http://127.0.0.1:8787/api/settings";

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
            const result = (await response.json()) as { settings: AppSettings };
            if (!cancelled) setSettings(result.settings);
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
  const [defaultModel, setDefaultModel] = useState<AgentModel>(settings.defaultModel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);

  useEffect(() => {
    if (!open) return;
    setLanguage(settings.language);
    setTheme(settings.theme);
    setDefaultModel(settings.defaultModel);
    setError("");
  }, [open, settings]);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(SETTINGS_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, theme, defaultModel }),
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
      <DialogPopup className="sm:max-w-lg">
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
                <FieldLabel>{t("settings.provider")}</FieldLabel>
                <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                  {t("settings.providerClaude")}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {t("settings.providerHint")}
                </p>
              </Field>
              <Field>
                <FieldLabel>{t("settings.defaultModel")}</FieldLabel>
                <select
                  className={selectClassName}
                  value={defaultModel}
                  onChange={(event) => setDefaultModel(event.target.value as AgentModel)}
                >
                  <option value="opus">{t("settings.modelOpus")}</option>
                  <option value="sonnet">{t("settings.modelSonnet")}</option>
                  <option value="haiku">{t("settings.modelHaiku")}</option>
                </select>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {t("settings.modelHint")}
                </p>
              </Field>
            </section>
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
