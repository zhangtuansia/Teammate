import { useEffect, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiUrl } from "@/lib/api-url";
import {
  loadModelConnections,
  type ModelConnection,
} from "@/lib/model-connections";
import type { TranslationKey } from "@/hooks/use-app-settings";

interface ConnectionsSectionProps {
  t: (key: TranslationKey) => string;
  connections: ModelConnection[];
  onConnectionsChanged: (connections: ModelConnection[]) => void;
}

const selectClassName =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-3 focus:ring-ring/20";

export function ConnectionsSection({
  t,
  connections,
  onConnectionsChanged,
}: ConnectionsSectionProps) {
  const [oauthState, setOauthState] = useState<"idle" | "waiting" | "error">("idle");
  const [oauthError, setOauthError] = useState("");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"openai-compatible" | "anthropic-compatible">(
    "openai-compatible",
  );
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const chatGptConnected = connections.some(
    (connection) => connection.provider === "openai-codex" && connection.hasCredential,
  );
  const chatGptConnection = connections.find(
    (connection) => connection.provider === "openai-codex" && connection.hasCredential,
  );

  async function reload() {
    onConnectionsChanged(await loadModelConnections());
  }

  useEffect(() => {
    if (oauthState !== "waiting") return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(apiUrl("/api/oauth/chatgpt/status"));
        const result = (await response.json()) as {
          status?: string;
          error?: string;
        };
        if (result.status === "complete") {
          window.clearInterval(timer);
          setOauthState("idle");
          await reload();
        } else if (result.status === "error") {
          window.clearInterval(timer);
          setOauthState("error");
          setOauthError(result.error || "OAuth login failed");
        }
      } catch {
        // Keep polling while the local callback flow is active.
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [oauthState]);

  async function connectChatGpt() {
    setOauthState("waiting");
    setOauthError("");
    try {
      const response = await fetch(apiUrl("/api/oauth/chatgpt/start"), { method: "POST" });
      const result = (await response.json()) as { authUrl?: string; error?: string };
      if (!response.ok || !result.authUrl) {
        throw new Error(result.error || "Could not start OAuth login");
      }
      await openExternal(result.authUrl);
    } catch (connectError) {
      setOauthState("error");
      setOauthError(connectError instanceof Error ? connectError.message : "OAuth login failed");
    }
  }

  async function addConnection() {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(apiUrl("/api/connections"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, provider, baseUrl, apiKey, model }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not save connection");
      setName("");
      setBaseUrl("");
      setApiKey("");
      setModel("");
      await reload();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save connection");
    } finally {
      setSaving(false);
    }
  }

  async function removeConnection(connection: ModelConnection) {
    if (!window.confirm(`${t("settings.removeConnection")} ${connection.name}?`)) return;
    const response = await fetch(apiUrl(`/api/connections/${connection.id}`), {
      method: "DELETE",
    });
    if (response.ok) await reload();
  }

  return (
    <section className="space-y-4 border-t pt-5">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("settings.connections")}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t("settings.connectionsHint")}
        </p>
      </div>

      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{t("settings.chatGptOAuth")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("settings.chatGptOAuthHint")}
            </p>
          </div>
          {chatGptConnected && chatGptConnection ? (
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs font-medium text-emerald-600">
                {t("settings.connected")}
              </span>
              <Button type="button" size="sm" variant="ghost" onClick={() => removeConnection(chatGptConnection)}>
                {t("settings.removeConnection")}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={connectChatGpt}
              disabled={oauthState === "waiting"}
            >
              {oauthState === "waiting" ? t("settings.connecting") : t("settings.connect")}
            </Button>
          )}
        </div>
        {oauthError && <p className="mt-2 text-xs text-destructive">{oauthError}</p>}
      </div>

      {connections.filter((connection) => connection.provider !== "openai-codex").map((connection) => (
        <div key={connection.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{connection.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {connection.default_model} · {connection.base_url}
            </p>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={() => removeConnection(connection)}>
            {t("settings.removeConnection")}
          </Button>
        </div>
      ))}

      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">{t("settings.addApi")}</summary>
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void addConnection();
          }}
        >
          <Field>
            <FieldLabel>{t("settings.connectionName")}</FieldLabel>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="OpenRouter" />
          </Field>
          <Field>
            <FieldLabel>{t("settings.provider")}</FieldLabel>
            <select
              className={selectClassName}
              value={provider}
              onChange={(event) => setProvider(event.target.value as typeof provider)}
            >
              <option value="openai-compatible">OpenAI compatible</option>
              <option value="anthropic-compatible">Anthropic compatible</option>
            </select>
          </Field>
          <Field>
            <FieldLabel>{t("settings.baseUrl")}</FieldLabel>
            <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
          </Field>
          <Field>
            <FieldLabel>{t("settings.apiKey")}</FieldLabel>
            <Input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel>{t("settings.connectionModel")}</FieldLabel>
            <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="model-id" />
          </Field>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button
            type="submit"
            size="sm"
            disabled={saving || !name.trim() || !baseUrl.trim() || !apiKey.trim() || !model.trim()}
          >
            {t("settings.addConnection")}
          </Button>
        </form>
      </details>
    </section>
  );
}
