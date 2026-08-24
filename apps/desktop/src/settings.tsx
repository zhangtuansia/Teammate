import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  Check,
  Cpu,
  Server,
  Upload,
} from "@/components/ui/settings-icons";
import {
  AppSettingsContext,
  defaultAppSettings,
  translate,
  useAppSettings,
  type AgentModel,
  type AgentRuntime,
  CODE_FONTS,
  INTERFACE_FONTS,
  READING_FONTS,
  fontStack,
  type AppPalette,
  type AppLanguage,
  type AppSettings,
  type AppTheme,
  type ThinkingLevel,
} from "@/hooks/use-app-settings";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Card, CardPanel } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { GeneratedAvatar } from "@/components/generated-avatar";
import {
  CODEX_MODEL_ITEMS,
  resolveAgentRuntimeSelection,
  runtimeSelectionIssueMessage,
} from "@/lib/agent-runtime";
import { installedAgentRuntimeIds } from "@/lib/agent-runtime-status";
import {
  loadModelConnections,
  type ModelConnection,
} from "@/lib/model-connections";
import { ConnectionsSection } from "./model-connections";
import { useSearchParams } from "next/navigation";
import { apiUrl } from "@/lib/api-url";
import { afterPaint } from "@/lib/after-paint";
import { useUnsavedChangesGuard } from "@/hooks/use-navigation-guard";
import { WorkspaceMembersSection } from "@/components/workspace-members-section";
import { useWorkspaceServer } from "@/components/workspace-server-context";

const SETTINGS_URL = apiUrl("/api/settings");
const RUNTIMES_URL = apiUrl("/api/runtimes");
const PROFILE_URL = apiUrl("/api/profile");
const SETTINGS_CACHE_KEY = "teammate:desktop-settings";
const REQUEST_TIMED_OUT = "__teammate_request_timed_out__";

const INITIAL_DESKTOP_SETTINGS: AppSettings = {
  ...defaultAppSettings,
  language: "zh-CN",
};

function readCachedSettings(): AppSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(SETTINGS_CACHE_KEY) || "null") as
      | Partial<AppSettings>
      | null;
    if (
      !value ||
      (value.language !== "zh-CN" && value.language !== "en-US") ||
      !["system", "light", "dark"].includes(value.theme || "") ||
      !["claude-code", "codex", "pi"].includes(value.defaultRuntime || "") ||
      typeof value.defaultModel !== "string" ||
      (value.defaultConnectionId !== null && typeof value.defaultConnectionId !== "string") ||
      (value.defaultThinkingLevel !== undefined &&
        !["low", "medium", "high"].includes(value.defaultThinkingLevel)) ||
      typeof value.showActivityDetails !== "boolean" ||
      typeof value.messageSounds !== "boolean"
    ) {
      return null;
    }
    const next = { ...defaultAppSettings, ...value } as AppSettings;
    return next;
  } catch {
    return null;
  }
}

function cacheSettings(settings: AppSettings) {
  try {
    window.localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings));
  } catch {
    // A cache failure must not block the authoritative settings save.
  }
}

interface RuntimeStatus {
  id: AgentRuntime;
  name: string;
  defaultModel: string;
  executable: string | null;
  installed: boolean;
}

type SettingsSection = "profile" | "workspace" | "general" | "models" | "chat" | "advanced";

/**
 * The swatch shown for each theme is its light-mode rail, because that is the
 * surface the theme actually colours. Kept beside the palette blocks in
 * globals.css — if one moves, the other has to.
 */
const PALETTE_SWATCHES: Array<{
  value: AppPalette;
  label: Parameters<typeof translate>[1];
  swatch: string;
}> = [
  { value: "sand", label: "settings.paletteSand", swatch: "#ebe5db" },
  { value: "aubergine", label: "settings.paletteAubergine", swatch: "#3f0e40" },
  { value: "forest", label: "settings.paletteForest", swatch: "#1b3a2b" },
  { value: "ocean", label: "settings.paletteOcean", swatch: "#10314f" },
  { value: "ink", label: "settings.paletteInk", swatch: "#2b2b2e" },
];

interface LocalProfile {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
}

interface SettingsSelectItem<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

function SettingsSelect<T extends string>({
  items,
  value,
  onValueChange,
}: {
  items: Array<SettingsSelectItem<T>>;
  value: T;
  onValueChange: (value: T) => void;
}) {
  const selected = items.find((item) => item.value === value) || items[0];
  return (
    <Select
      items={items}
      value={selected}
      onValueChange={(next) => {
        if (next) onValueChange((next as SettingsSelectItem<T>).value);
      }}
    >
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem disabled={item.disabled} key={item.value} value={item}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function DesktopSettingsProvider({ children }: { children: ReactNode }) {
  const [bootstrap] = useState(() => {
    const cached = readCachedSettings();
    return {
      settings: cached || INITIAL_DESKTOP_SETTINGS,
      hasLastGoodSettings: Boolean(cached),
    };
  });
  const [settings, setSettings] = useState<AppSettings>(bootstrap.settings);
  const [hasLastGoodSettings, setHasLastGoodSettings] = useState(
    bootstrap.hasLastGoodSettings,
  );
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const [settingsReloadToken, setSettingsReloadToken] = useState(0);

  const reloadSettings = useCallback(() => {
    setSettingsLoaded(false);
    setSettingsLoadError(null);
    setSettingsReloadToken((token) => token + 1);
  }, []);

  const updateSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    setHasLastGoodSettings(true);
    cacheSettings(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let activeController: AbortController | null = null;

    async function loadSettings() {
      let lastError = "";
      const deadline = Date.now() + 12_000;
      for (
        let attempt = 0;
        attempt < 80 && !cancelled && Date.now() < deadline;
        attempt += 1
      ) {
        const controller = new AbortController();
        activeController = controller;
        const timeout = window.setTimeout(() => controller.abort(), 1000);
        try {
          const response = await fetch(SETTINGS_URL, { signal: controller.signal });
          if (response.ok) {
            const result = (await response.json()) as { settings: Partial<AppSettings> };
            if (!cancelled) {
              const next = { ...defaultAppSettings, ...result.settings };
              updateSettings(next);
              setSettingsLoaded(true);
              setSettingsLoadError(null);
            }
            return;
          }
          lastError = `HTTP ${response.status}`;
        } catch (loadError) {
          if (loadError instanceof DOMException && loadError.name === "AbortError") {
            lastError = "Request timed out";
          } else {
            lastError = loadError instanceof Error ? loadError.message : "Failed to load settings";
          }
          // The packaged local runtime may still be starting.
        } finally {
          window.clearTimeout(timeout);
          if (activeController === controller) activeController = null;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!cancelled) {
        setSettingsLoadError(lastError || "Failed to load settings");
      }
    }

    void loadSettings();
    return () => {
      cancelled = true;
      activeController?.abort();
    };
  }, [settingsReloadToken, updateSettings]);

  useLayoutEffect(() => {
    if (!settingsLoaded && !hasLastGoodSettings) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const dark = settings.theme === "dark" || (settings.theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      document.documentElement.lang = settings.language;
      // The default palette carries no attribute, so nothing in the theme
      // blocks can apply until one is actually chosen.
      if (settings.palette && settings.palette !== "sand") {
        document.documentElement.dataset.palette = settings.palette;
      } else {
        delete document.documentElement.dataset.palette;
      }
      // "System" is the absence of an override rather than a value, so the
      // stack in globals.css stays the single definition of the default.
      const style = document.documentElement.style;
      for (const [property, stack] of [
        ["--font-pref-interface", fontStack(INTERFACE_FONTS, settings.interfaceFont)],
        ["--font-pref-reading", fontStack(READING_FONTS, settings.readingFont)],
        ["--font-pref-code", fontStack(CODE_FONTS, settings.codeFont)],
      ] as const) {
        if (stack) style.setProperty(property, stack);
        else style.removeProperty(property);
      }
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [
    hasLastGoodSettings,
    settings.language,
    settings.codeFont,
    settings.interfaceFont,
    settings.palette,
    settings.readingFont,
    settings.theme,
    settingsLoaded,
  ]);

  const value = useMemo(
    () => ({
      settings,
      t: (key: Parameters<typeof translate>[1], values?: Record<string, string>) =>
        translate(settings.language, key, values),
      updateSettings,
      settingsLoaded,
      settingsLoadError,
      reloadSettings,
    }),
    [reloadSettings, settings, settingsLoadError, settingsLoaded, updateSettings],
  );

  const loadingLabel = translate(settings.language, "settings.loading");
  const loadFailedLabel = translate(settings.language, "settings.loadFailed");

  let content = children;
  if (!hasLastGoodSettings && !settingsLoaded) {
    content = settingsLoadError ? (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Alert className="max-w-md" variant="error">
          <AlertCircle />
          <AlertTitle>{loadFailedLabel}</AlertTitle>
          <AlertDescription>
            <span>{settingsLoadError}</span>
            <Button className="w-fit" onClick={reloadSettings} size="sm" variant="outline">
              {translate(settings.language, "runtime.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    ) : (
      <div
        aria-live="polite"
        className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground"
        role="status"
      >
        {loadingLabel}
      </div>
    );
  }

  return (
    <AppSettingsContext.Provider value={value}>
      {content}
    </AppSettingsContext.Provider>
  );
}

export function DesktopSettingsPage() {
  const {
    settings,
    updateSettings,
    settingsLoaded = true,
    settingsLoadError = null,
    reloadSettings,
  } = useAppSettings();
  const workspaceServer = useWorkspaceServer();
  const searchParams = useSearchParams();
  const requestedSection = searchParams.get("section");
  const activeSection: SettingsSection = requestedSection && ["profile", "workspace", "general", "models", "chat", "advanced"].includes(requestedSection)
    ? requestedSection as SettingsSection
    : "profile";
  const [language, setLanguage] = useState<AppLanguage>(settings.language);
  const [theme, setTheme] = useState<AppTheme>(settings.theme);
  const [palette, setPalette] = useState<AppPalette>(settings.palette || "sand");
  const [interfaceFont, setInterfaceFont] = useState(settings.interfaceFont || "system");
  const [readingFont, setReadingFont] = useState(settings.readingFont || "system");
  const [codeFont, setCodeFont] = useState(settings.codeFont || "system");
  const [defaultRuntime, setDefaultRuntime] = useState<AgentRuntime>(settings.defaultRuntime);
  const [defaultModel, setDefaultModel] = useState<AgentModel>(settings.defaultModel);
  const [defaultConnectionId, setDefaultConnectionId] = useState<string | null>(
    settings.defaultConnectionId,
  );
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState<ThinkingLevel>(
    settings.defaultThinkingLevel,
  );
  const [showActivityDetails, setShowActivityDetails] = useState(settings.showActivityDetails);
  const [messageSounds, setMessageSounds] = useState(settings.messageSounds);
  const [profile, setProfile] = useState<LocalProfile | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileAvatarUrl, setProfileAvatarUrl] = useState<string | null>(null);
  const [profileAvatarData, setProfileAvatarData] = useState<string | null>(null);
  const [profileAvatarFileName, setProfileAvatarFileName] = useState("");
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [supportLoading, setSupportLoading] = useState(false);
  const [supportLoadError, setSupportLoadError] = useState("");
  const [supportReloadToken, setSupportReloadToken] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [formHydratedFor, setFormHydratedFor] = useState<AppSettings | null>(null);
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null);
  const [profileReloadToken, setProfileReloadToken] = useState(0);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const profileAvatarReadGenerationRef = useRef(0);
  const saveControllerRef = useRef<AbortController | null>(null);
  const saveGenerationRef = useRef(0);
  const savingRef = useRef(false);
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
  const languageItems: Array<SettingsSelectItem<AppLanguage>> = [
    { value: "zh-CN", label: t("settings.languageZh") },
    { value: "en-US", label: t("settings.languageEn") },
  ];
  const themeItems: Array<SettingsSelectItem<AppTheme>> = [
    { value: "system", label: t("settings.themeSystem") },
    { value: "light", label: t("settings.themeLight") },
    { value: "dark", label: t("settings.themeDark") },
  ];
  const installedRuntimeIds = installedAgentRuntimeIds(runtimes);
  const runtimeItems: Array<SettingsSelectItem<AgentRuntime>> = ([
    { value: "claude-code", label: t("settings.runtimeClaude") },
    { value: "codex", label: t("settings.runtimeCodex") },
    { value: "pi", label: t("settings.runtimePi") },
  ] as const).map((item) => {
    const installed = installedRuntimeIds.includes(item.value);
    return {
      ...item,
      disabled: !installed,
      label: installed
        ? item.label
        : `${item.label} · ${t("settings.runtimeMissing")}`,
    };
  });
  const resolvedDefaultSelection = resolveAgentRuntimeSelection({
    runtime: defaultRuntime,
    model: defaultModel,
    connectionId: defaultConnectionId,
  }, connections, installedRuntimeIds);
  const defaultSelectionError = runtimeSelectionIssueMessage(
    resolvedDefaultSelection.issue,
    language,
  );
  const activeDefaultConnection = connections.find((connection) =>
    connection.id === defaultConnectionId,
  );
  const defaultModelItems: Array<SettingsSelectItem<string>> = defaultRuntime === "claude-code"
    ? [
        { value: "opus", label: t("settings.modelOpus") },
        { value: "sonnet", label: t("settings.modelSonnet") },
        { value: "haiku", label: t("settings.modelHaiku") },
      ]
    : defaultRuntime === "codex"
      ? CODEX_MODEL_ITEMS.map((item) => ({
          value: item.value,
          label: item.value === "default" && language === "zh-CN" ? "自动（推荐）" : item.label,
        }))
      : (activeDefaultConnection?.models || []).map((modelDefinition) => ({
          value: modelDefinition.id,
          label: modelDefinition.name,
        }));
  const defaultModelSupportsThinking = defaultRuntime === "codex" || (
    defaultRuntime === "pi" &&
    activeDefaultConnection?.models.find((modelDefinition) => modelDefinition.id === defaultModel)
      ?.reasoning === true
  );
  const thinkingLevelItems: Array<SettingsSelectItem<ThinkingLevel>> = [
    { value: "low", label: t("settings.thinkingLow") },
    { value: "medium", label: t("settings.thinkingMedium") },
    { value: "high", label: t("settings.thinkingHigh") },
  ];
  const applyDefaultSelection = (
    next: ReturnType<typeof resolveAgentRuntimeSelection>,
  ) => {
    setDefaultRuntime(next.selection.runtime);
    setDefaultModel(next.selection.model);
    setDefaultConnectionId(next.selection.connectionId);
    setError("");
  };
  const settingsChanged =
    language !== settings.language ||
    theme !== settings.theme ||
    palette !== (settings.palette || "sand") ||
    interfaceFont !== (settings.interfaceFont || "system") ||
    readingFont !== (settings.readingFont || "system") ||
    codeFont !== (settings.codeFont || "system") ||
    defaultRuntime !== settings.defaultRuntime ||
    defaultModel !== settings.defaultModel ||
    defaultConnectionId !== settings.defaultConnectionId ||
    defaultThinkingLevel !== settings.defaultThinkingLevel ||
    showActivityDetails !== settings.showActivityDetails ||
    messageSounds !== settings.messageSounds;
  const aiSettingsChanged =
    defaultRuntime !== settings.defaultRuntime ||
    defaultModel !== settings.defaultModel ||
    defaultConnectionId !== settings.defaultConnectionId ||
    defaultThinkingLevel !== settings.defaultThinkingLevel;
  const profileChanged = Boolean(profile) && (
    profileName.trim() !== profile?.display_name ||
    profileAvatarData !== null ||
    profileAvatarUrl !== profile?.avatar_url
  );
  const formHydrated = settingsLoaded && formHydratedFor === settings;
  const hasUnsavedChanges = formHydrated && (settingsChanged || profileChanged);
  useUnsavedChangesGuard(hasUnsavedChanges || saving, () => {
    setLanguage(settings.language);
    setTheme(settings.theme);
    setDefaultRuntime(settings.defaultRuntime);
    setDefaultModel(settings.defaultModel);
    setDefaultConnectionId(settings.defaultConnectionId);
    setDefaultThinkingLevel(settings.defaultThinkingLevel);
    setShowActivityDetails(settings.showActivityDetails);
    setMessageSounds(settings.messageSounds);
    if (profile) {
      profileAvatarReadGenerationRef.current += 1;
      setProfileName(profile.display_name);
      setProfileAvatarUrl(profile.avatar_url);
      setProfileAvatarData(null);
      setProfileAvatarFileName("");
    }
    setError("");
  }, !saving);

  useEffect(() => () => {
    profileAvatarReadGenerationRef.current += 1;
    saveGenerationRef.current += 1;
    saveControllerRef.current?.abort();
    saveControllerRef.current = null;
    savingRef.current = false;
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    return afterPaint(() => {
      setLanguage(settings.language);
      setTheme(settings.theme);
      setPalette(settings.palette || "sand");
      setInterfaceFont(settings.interfaceFont || "system");
      setReadingFont(settings.readingFont || "system");
      setCodeFont(settings.codeFont || "system");
      setDefaultRuntime(settings.defaultRuntime);
      setDefaultModel(settings.defaultModel);
      setDefaultConnectionId(settings.defaultConnectionId);
      setDefaultThinkingLevel(settings.defaultThinkingLevel);
      setShowActivityDetails(settings.showActivityDetails);
      setMessageSounds(settings.messageSounds);
      setFormHydratedFor(settings);
    });
  }, [settings, settingsLoaded]);

  useEffect(() => {
    if (!settingsLoaded) return;
    let cancelled = false;
    const controller = new AbortController();
    let timeout: number | null = null;

    async function loadSupportData() {
      const [runtimeResult, connectionResult] = await Promise.all([
        fetch(RUNTIMES_URL, { signal: controller.signal })
          .then(async (response) => {
            if (!response.ok) throw new Error(`Runtime status: HTTP ${response.status}`);
            const result = (await response.json()) as { runtimes?: RuntimeStatus[] };
            return { value: result.runtimes || [], error: "" };
          })
          .catch((loadError) => ({
            value: null,
            error: loadError instanceof Error ? loadError.message : "Could not load runtimes",
          })),
        loadModelConnections(controller.signal)
          .then((value) => ({ value, error: "" }))
          .catch((loadError) => ({
            value: null,
            error: loadError instanceof Error ? loadError.message : "Could not load connections",
          })),
      ]);
      if (cancelled) return;
      if (timeout !== null) window.clearTimeout(timeout);
      if (runtimeResult.value) setRuntimes(runtimeResult.value);
      if (connectionResult.value) setConnections(connectionResult.value);
      setSupportLoadError(
        [runtimeResult.error, connectionResult.error].filter(Boolean).join(" · "),
      );
      setSupportLoading(false);
    }

    const cancel = afterPaint(() => {
      timeout = window.setTimeout(() => controller.abort(), 10_000);
      setSupportLoading(true);
      setSupportLoadError("");
      void loadSupportData();
    });
    return () => {
      cancelled = true;
      cancel();
      if (timeout !== null) window.clearTimeout(timeout);
      controller.abort();
    };
  }, [settingsLoaded, supportReloadToken]);

  useEffect(() => {
    let cancelled = false;
    let timedOut = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10_000);
    void fetch(PROFILE_URL, { signal: controller.signal })
      .then(async (response) => {
        const result = (await response.json()) as { profile?: LocalProfile; error?: string };
        if (!response.ok || !result.profile) throw new Error(result.error || `HTTP ${response.status}`);
        if (cancelled) return;
        profileAvatarReadGenerationRef.current += 1;
        setProfile(result.profile);
        setProfileName(result.profile.display_name);
        setProfileAvatarUrl(result.profile.avatar_url);
        setProfileAvatarData(null);
        setProfileAvatarFileName("");
        setProfileLoadError(null);
      })
      .catch((profileError) => {
        if (!cancelled) {
          setProfileLoadError(
            timedOut
              ? REQUEST_TIMED_OUT
              : profileError instanceof Error
                ? profileError.message
                : "Failed to load profile",
          );
        }
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [profileReloadToken]);

  function handleAvatarFile(file: File | undefined) {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError(t("agentSettings.error.avatarType"));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError(t("agentSettings.error.avatarSize"));
      return;
    }
    const generation = ++profileAvatarReadGenerationRef.current;
    const reader = new FileReader();
    reader.onload = () => {
      if (
        typeof reader.result !== "string" ||
        generation !== profileAvatarReadGenerationRef.current
      ) return;
      setProfileAvatarData(reader.result);
      setProfileAvatarFileName(file.name);
      setError("");
    };
    reader.onerror = () => {
      if (generation === profileAvatarReadGenerationRef.current) {
        setError(t("agentSettings.error.avatarRead"));
      }
    };
    reader.readAsDataURL(file);
  }

  async function save() {
    if (!hasUnsavedChanges || savingRef.current) return;
    if (profileChanged && !profileName.trim()) {
      setError(t("settings.profileNameRequired"));
      return;
    }
    const resolvedDefault = resolveAgentRuntimeSelection({
      runtime: defaultRuntime,
      model: defaultModel,
      connectionId: defaultConnectionId,
    }, connections, installedRuntimeIds);
    if (aiSettingsChanged && resolvedDefault.issue) {
      setError(runtimeSelectionIssueMessage(resolvedDefault.issue, language));
      return;
    }
    const generation = saveGenerationRef.current + 1;
    saveGenerationRef.current = generation;
    const controller = new AbortController();
    saveControllerRef.current = controller;
    savingRef.current = true;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    const isCurrentSave = () => saveGenerationRef.current === generation;
    setSaving(true);
    setError("");
    let settingsSaved = false;
    try {
      if (settingsChanged) {
        const response = await fetch(SETTINGS_URL, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            language,
            theme,
            palette,
            interfaceFont,
            readingFont,
            codeFont,
            ...(aiSettingsChanged ? {
              defaultRuntime: resolvedDefault.selection.runtime,
              defaultModel: resolvedDefault.selection.model,
              defaultConnectionId: resolvedDefault.selection.connectionId,
              defaultThinkingLevel,
            } : {}),
            showActivityDetails,
            messageSounds,
          }),
          signal: controller.signal,
        });
        const result = (await response.json()) as { settings?: AppSettings; error?: string };
        if (!isCurrentSave()) return;
        if (!response.ok || !result.settings) {
          throw new Error(result.error || `HTTP ${response.status}`);
        }
        // Keep the visible app state aligned even if a later profile request fails.
        updateSettings?.(result.settings);
        setLanguage(result.settings.language);
        setTheme(result.settings.theme);
        setDefaultRuntime(result.settings.defaultRuntime);
        setDefaultModel(result.settings.defaultModel);
        setDefaultConnectionId(result.settings.defaultConnectionId);
        setDefaultThinkingLevel(result.settings.defaultThinkingLevel);
        setShowActivityDetails(result.settings.showActivityDetails);
        setMessageSounds(result.settings.messageSounds);
        setFormHydratedFor(result.settings);
        settingsSaved = true;
      }
      if (profile && profileChanged) {
        const profileResponse = await fetch(PROFILE_URL, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            display_name: profileName.trim(),
            ...(profileAvatarData
              ? { avatar_data: profileAvatarData }
              : { avatar_url: profileAvatarUrl }),
          }),
          signal: controller.signal,
        });
        const profileResult = (await profileResponse.json()) as { profile?: LocalProfile; error?: string };
        if (!isCurrentSave()) return;
        if (!profileResponse.ok || !profileResult.profile) {
          throw new Error(profileResult.error || `HTTP ${profileResponse.status}`);
        }
        setProfile(profileResult.profile);
        profileAvatarReadGenerationRef.current += 1;
        setProfileName(profileResult.profile.display_name);
        setProfileAvatarUrl(profileResult.profile.avatar_url);
        setProfileAvatarData(null);
        setProfileAvatarFileName("");
      }
    } catch (saveError) {
      if (!isCurrentSave()) return;
      const reason = saveError instanceof Error ? saveError.message : "Failed to save settings";
      const visibleReason = timedOut ? t("settings.requestTimedOut") : reason;
      setError(
        settingsSaved
          ? `${t("settings.profileSaveAfterSettingsError")} ${visibleReason}`
          : visibleReason,
      );
    } finally {
      window.clearTimeout(timeout);
      if (isCurrentSave()) {
        saveControllerRef.current = null;
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-card">
      <header className="relative flex h-16 shrink-0 items-center border-b px-6">
        <div
          className="desktop-native-drag absolute inset-0"
          data-tauri-drag-region
          aria-hidden="true"
        />
        <div className="pointer-events-none relative min-w-0">
          <h1 className="truncate text-[15px] font-semibold">{t("settings.title")}</h1>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{t("settings.description")}</p>
        </div>
      </header>
      {!formHydrated ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          {settingsLoadError ? (
            <Alert className="max-w-lg" variant="error">
              <AlertCircle />
              <AlertTitle>{t("settings.loadFailed")}</AlertTitle>
              <AlertDescription>
                <span>{settingsLoadError}</span>
                <Button
                  className="w-fit"
                  onClick={() => reloadSettings?.()}
                  size="sm"
                  variant="outline"
                >
                  {t("runtime.retry")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <p aria-live="polite" className="text-sm text-muted-foreground" role="status">
              {t("settings.loading")}
            </p>
          )}
        </div>
      ) : (
        <>
      <fieldset aria-busy={saving} className="contents" disabled={saving}>
      <ScrollArea className="min-w-0 flex-1">
            <div className="mx-auto w-full max-w-3xl space-y-6 p-5 sm:p-7">
              {(["models", "advanced"] as SettingsSection[]).includes(activeSection) && supportLoading && (
                <p aria-live="polite" className="text-sm text-muted-foreground" role="status">
                  {t("settings.loading")}
                </p>
              )}
              {(["models", "advanced"] as SettingsSection[]).includes(activeSection) && supportLoadError && (
                <Alert variant="error">
                  <AlertCircle />
                  <AlertTitle>{t("settings.loadFailed")}</AlertTitle>
                  <AlertDescription>
                    <span>{supportLoadError}</span>
                    <Button
                      className="w-fit"
                      onClick={() => setSupportReloadToken((token) => token + 1)}
                      size="sm"
                      variant="outline"
                    >
                      {t("runtime.retry")}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              {activeSection === "profile" && (
                <section className="space-y-6">
                  <div>
                    <h3 className="text-lg font-semibold">{t("settings.navProfile")}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("settings.profileDescription")}
                    </p>
                  </div>
                  {profileLoadError ? (
                    <Alert className="max-w-xl" variant="error">
                      <AlertCircle />
                      <AlertTitle>{t("settings.profileLoadFailed")}</AlertTitle>
                      <AlertDescription>
                        <span>
                          {profileLoadError === REQUEST_TIMED_OUT
                            ? t("settings.requestTimedOut")
                            : profileLoadError}
                        </span>
                        <Button
                          className="w-fit"
                          onClick={() => {
                            setProfile(null);
                            setProfileLoadError(null);
                            setProfileReloadToken((token) => token + 1);
                          }}
                          size="sm"
                          variant="outline"
                        >
                          {t("runtime.retry")}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  ) : !profile ? (
                    <p aria-live="polite" className="text-sm text-muted-foreground" role="status">
                      {t("settings.profileLoading")}
                    </p>
                  ) : (
                  <Card className="max-w-xl">
                    <CardPanel className="space-y-5">
                      <Field>
                        <FieldLabel>{t("settings.profileAvatar")}</FieldLabel>
                        <div className="flex items-center gap-4 rounded-lg border p-4">
                          <GeneratedAvatar
                            id={profile?.id || "local-user"}
                            name={profileName || profile?.display_name}
                            size="lg"
                            avatarUrl={profileAvatarData || profileAvatarUrl}
                            initials={!profileAvatarData && !profileAvatarUrl}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {profileAvatarFileName || profileName || profile?.email || "—"}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {t("settings.profileAvatarHint")}
                            </p>
                          </div>
                          <Button type="button" variant="outline" size="sm" onClick={() => avatarInputRef.current?.click()}>
                            <Upload />
                            {t("settings.profileUpload")}
                          </Button>
                          <input
                            ref={avatarInputRef}
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            className="hidden"
                            onChange={(event) => {
                              handleAvatarFile(event.target.files?.[0]);
                              event.target.value = "";
                            }}
                          />
                        </div>
                      </Field>
                      <Field>
                        <FieldLabel>{t("settings.profileName")}</FieldLabel>
                        <Input
                          value={profileName}
                          maxLength={80}
                          onChange={(event) => setProfileName(event.target.value)}
                        />
                      </Field>
                    </CardPanel>
                  </Card>
                  )}
                </section>
              )}

              {activeSection === "workspace" && <WorkspaceMembersSection />}

              {activeSection === "general" && (
                <section className="space-y-6">
                  <div>
                    <h3 className="text-lg font-semibold">{t("settings.navGeneral")}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("settings.generalDescription")}
                    </p>
                  </div>
                  <Card className="max-w-xl">
                    <CardPanel className="space-y-5">
                      <Field>
                        <FieldLabel>{t("settings.language")}</FieldLabel>
                        <SettingsSelect items={languageItems} value={language} onValueChange={setLanguage} />
                      </Field>
                      <Field>
                        <FieldLabel>{t("settings.appearance")}</FieldLabel>
                        <SettingsSelect items={themeItems} value={theme} onValueChange={setTheme} />
                      </Field>
                      <Field>
                        <FieldLabel>{t("settings.palette")}</FieldLabel>
                        {/* Swatches rather than a dropdown: the thing being
                            chosen is a colour, and a list of names makes you
                            pick one to find out what it looks like. */}
                        <div className="flex flex-wrap gap-2">
                          {PALETTE_SWATCHES.map((option) => {
                            const active = palette === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => setPalette(option.value)}
                                aria-pressed={active}
                                title={t(option.label)}
                                className={`flex items-center gap-2 rounded-lg border py-1.5 pr-3 pl-1.5 text-[13px] transition-colors ${
                                  active
                                    ? "border-foreground/25 bg-accent text-foreground"
                                    : "border-transparent text-muted-foreground hover:bg-accent/60"
                                }`}
                              >
                                <span
                                  aria-hidden="true"
                                  className="size-6 rounded-md"
                                  style={{ backgroundColor: option.swatch }}
                                />
                                {t(option.label)}
                              </button>
                            );
                          })}
                        </div>
                        <FieldDescription>{t("settings.paletteHint")}</FieldDescription>
                      </Field>
                      <Field>
                        <FieldLabel>{t("settings.fontInterface")}</FieldLabel>
                        <SettingsSelect
                          items={INTERFACE_FONTS.map((f) => ({ value: f.id, label: f.label }))}
                          value={interfaceFont}
                          onValueChange={setInterfaceFont}
                        />
                      </Field>
                      <Field>
                        <FieldLabel>{t("settings.fontReading")}</FieldLabel>
                        <SettingsSelect
                          items={READING_FONTS.map((f) => ({ value: f.id, label: f.label }))}
                          value={readingFont}
                          onValueChange={setReadingFont}
                        />
                        <FieldDescription>{t("settings.fontReadingHint")}</FieldDescription>
                      </Field>
                      <Field>
                        <FieldLabel>{t("settings.fontCode")}</FieldLabel>
                        <SettingsSelect
                          items={CODE_FONTS.map((f) => ({ value: f.id, label: f.label }))}
                          value={codeFont}
                          onValueChange={setCodeFont}
                        />
                      </Field>
                    </CardPanel>
                  </Card>
                </section>
              )}

              {activeSection === "models" && (
                <section className="space-y-6">
                  <div>
                    <h3 className="text-lg font-semibold">{t("settings.navModels")}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("settings.modelsDescription")}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("settings.engineHeading")}
                    </h4>
                    <Card>
                      <CardPanel className="p-0">
                        <div className="flex items-center justify-between gap-5 px-4 py-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{t("settings.runtime")}</p>
                            <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.runtimeHint")}</p>
                          </div>
                          <SettingsSelect
                            items={runtimeItems}
                            value={defaultRuntime}
                            onValueChange={(runtime) => {
                              if (runtime === "pi") {
                                const first = connections.find((connection) => connection.hasCredential);
                                applyDefaultSelection(resolveAgentRuntimeSelection({
                                  runtime,
                                  connectionId: first?.id,
                                }, connections, installedRuntimeIds));
                              } else {
                                applyDefaultSelection(resolveAgentRuntimeSelection(
                                  { runtime },
                                  connections,
                                  installedRuntimeIds,
                                ));
                              }
                            }}
                          />
                        </div>
                        {/* Two of these are CLIs on this machine and one is built
                            in, so "installed" only means something for the first
                            two. The built-in one reports what it is waiting on
                            instead: a connection to talk to. */}
                        <div className="divide-y border-t">
                          {runtimes.map((runtime) => {
                            const embedded = runtime.id === "pi";
                            const backing = embedded
                              ? connections.find((connection) => connection.id === defaultConnectionId)
                                ?? connections.find((connection) => connection.hasCredential)
                              : null;
                            return (
                              <div
                                className="flex items-center justify-between gap-4 px-4 py-2.5"
                                key={runtime.id}
                              >
                                <div className="min-w-0">
                                  <p className="text-[13px] font-medium">
                                    {runtime.name}
                                    {runtime.id === defaultRuntime && (
                                      <span className="ml-2 text-[11px] font-normal text-primary">
                                        {t("settings.engineInUse")}
                                      </span>
                                    )}
                                  </p>
                                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                    {embedded
                                      ? backing
                                        ? `${t("settings.engineVia")} ${backing.name}`
                                        : t("settings.engineNeedsConnection")
                                      : runtime.executable || t("settings.runtimeMissing")}
                                  </p>
                                </div>
                                {embedded ? (
                                  <Badge variant={backing ? "success" : "secondary"}>
                                    {backing ? <Check /> : <AlertCircle />}
                                    {backing ? t("settings.engineReady") : t("settings.engineUnconfigured")}
                                  </Badge>
                                ) : (
                                  <Badge variant={runtime.installed ? "success" : "error"}>
                                    {runtime.installed ? <Check /> : <AlertCircle />}
                                    {runtime.installed
                                      ? t("settings.runtimeInstalled")
                                      : t("settings.runtimeMissing")}
                                  </Badge>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </CardPanel>
                    </Card>
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("settings.defaultSettings")}
                    </h4>
                    <Card>
                      <CardPanel className="divide-y p-0">
                        <div className="flex items-center justify-between gap-5 px-4 py-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{t("settings.defaultModel")}</p>
                            <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.modelHint")}</p>
                          </div>
                          <SettingsSelect
                            items={defaultModelItems}
                            value={defaultModelItems.some((item) => item.value === defaultModel)
                              ? defaultModel
                              : defaultModelItems[0]?.value || ""}
                            onValueChange={setDefaultModel}
                          />
                        </div>
                        <div className="flex items-center justify-between gap-5 px-4 py-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{t("settings.thinkingLevel")}</p>
                            <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.thinkingHint")}</p>
                          </div>
                          {defaultModelSupportsThinking ? (
                            <SettingsSelect
                              items={thinkingLevelItems}
                              value={defaultThinkingLevel}
                              onValueChange={setDefaultThinkingLevel}
                            />
                          ) : (
                            <Badge variant="secondary">
                              {language === "zh-CN" ? "当前模型不支持" : "Not supported"}
                            </Badge>
                          )}
                        </div>
                      </CardPanel>
                    </Card>
                  </div>
                      {defaultSelectionError && (
                        <Alert variant="warning">
                          <AlertCircle />
                          <AlertTitle>{language === "zh-CN" ? "需要修复模型配置" : "Model configuration needs attention"}</AlertTitle>
                          <AlertDescription>
                            <span>{defaultSelectionError}</span>
                            {resolvedDefaultSelection.models.length > 0 && (
                              <Button
                                className="mt-2 w-fit"
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => applyDefaultSelection(resolveAgentRuntimeSelection({
                                  runtime: defaultRuntime,
                                  connectionId: defaultConnectionId,
                                }, connections, installedRuntimeIds))}
                              >
                                {language === "zh-CN" ? "使用推荐模型" : "Use recommended model"}
                              </Button>
                            )}
                          </AlertDescription>
                        </Alert>
                      )}
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("settings.workspaceOverride")}
                    </h4>
                    <Card>
                      <CardPanel className="flex items-center justify-between gap-4 px-4 py-3">
                        <div>
                          <p className="text-sm font-medium">{workspaceServer.name}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {t("settings.workspaceInherited")}
                          </p>
                        </div>
                        <Badge variant="secondary">
                          {language === "zh-CN" ? "继承默认" : "Inherited"}
                        </Badge>
                      </CardPanel>
                    </Card>
                  </div>
                  <ConnectionsSection
                    t={t}
                    connections={connections}
                    runtimes={runtimes}
                    defaultRuntime={defaultRuntime}
                    defaultConnectionId={defaultConnectionId}
                    onSetRuntimeDefault={(runtime) => applyDefaultSelection(
                      resolveAgentRuntimeSelection({ runtime }, connections, installedRuntimeIds),
                    )}
                    onSetDefault={(connection) => applyDefaultSelection(
                      resolveAgentRuntimeSelection({
                        runtime: "pi",
                        connectionId: connection.id,
                      }, connections, installedRuntimeIds),
                    )}
                    onDefaultSelectionSynced={(selection) => {
                      setDefaultRuntime(selection.runtime);
                      setDefaultModel(selection.model);
                      setDefaultConnectionId(selection.connectionId);
                      updateSettings?.({
                        ...settings,
                        defaultRuntime: selection.runtime,
                        defaultModel: selection.model,
                        defaultConnectionId: selection.connectionId,
                      });
                    }}
                    onConnectionsChanged={(next) => {
                      setConnections(next);
                      if (defaultConnectionId && !next.some((entry) => entry.id === defaultConnectionId)) {
                        setDefaultConnectionId(null);
                      }
                    }}
                  />
                </section>
              )}

              {activeSection === "chat" && (
                <section className="space-y-6">
                  <div>
                    <h3 className="text-lg font-semibold">{t("settings.chat")}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("settings.chatDescription")}
                    </p>
                  </div>
                  <Card>
                    <CardPanel className="flex items-center justify-between gap-5">
                      <div>
                        <p className="text-sm font-semibold">{t("settings.showActivityDetails")}</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {t("settings.showActivityDetailsHint")}
                        </p>
                      </div>
                      <Switch
                        checked={showActivityDetails}
                        onCheckedChange={setShowActivityDetails}
                        aria-label={t("settings.showActivityDetails")}
                      />
                    </CardPanel>
                  </Card>
                  <Card>
                    <CardPanel className="flex items-center justify-between gap-5">
                      <div>
                        <p className="text-sm font-semibold">{t("settings.messageSounds")}</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {t("settings.messageSoundsHint")}
                        </p>
                      </div>
                      <Switch
                        checked={messageSounds}
                        onCheckedChange={setMessageSounds}
                        aria-label={t("settings.messageSounds")}
                      />
                    </CardPanel>
                  </Card>
                  <Alert variant="success">
                    <Check />
                    <AlertTitle>{t("settings.runtimeErrors")}</AlertTitle>
                    <AlertDescription>{t("settings.runtimeErrorsHint")}</AlertDescription>
                  </Alert>
                </section>
              )}

              {activeSection === "advanced" && (
                <section className="space-y-6">
                  <div>
                    <h3 className="text-lg font-semibold">{t("settings.advanced")}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("settings.advancedDescription")}
                    </p>
                  </div>
                  <div className="space-y-3">
                    <Card>
                      <CardPanel className="flex items-center gap-3 p-4">
                        <Server className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{t("settings.localService")}</p>
                          <code className="mt-1 block truncate text-xs text-muted-foreground">
                            http://127.0.0.1:8787
                          </code>
                        </div>
                        <Badge variant="success"><Check /> Local</Badge>
                      </CardPanel>
                    </Card>
                    {runtimes.map((runtime) => (
                      <Card key={runtime.id}>
                        <CardPanel className="p-4">
                          <div className="flex items-center gap-3">
                          <Cpu className="size-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">{runtime.name}</p>
                            <p className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                              {runtime.executable === "embedded"
                                ? t("settings.embeddedRuntime")
                                : t("settings.executablePath")}
                            </p>
                            <code className="mt-1 block truncate text-xs text-muted-foreground">
                              {runtime.executable || "—"}
                            </code>
                          </div>
                        </div>
                        </CardPanel>
                      </Card>
                    ))}
                  </div>
                </section>
              )}
            </div>
      </ScrollArea>
      </fieldset>
      {activeSection !== "workspace" && <footer className="flex shrink-0 items-center gap-3 border-t px-6 py-3">
        {error && (
          <Alert className="min-w-0 max-w-xl flex-1 py-2" variant="error">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button
          className="ml-auto"
          type="button"
          onClick={save}
          loading={saving}
          disabled={!hasUnsavedChanges}
        >
          {saving ? t("settings.saving") : t("settings.save")}
        </Button>
      </footer>}
        </>
      )}
    </div>
  );
}
