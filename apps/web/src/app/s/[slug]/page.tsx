"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ApiKeysSection } from "@/components/api-keys-section";
import { SetupWizard } from "@/components/setup-wizard";
import { useAppSettings } from "@/hooks/use-app-settings";
import { createTrailingRefreshScheduler } from "@/lib/trailing-refresh";

interface ServerStats {
  slug: string;
  request: number;
  id: string;
  name: string;
  description: string | null;
  agentCount: number;
  channelCount: number;
  memberCount: number;
}

interface StatsLoadError {
  slug: string;
  request: number;
  message: string;
}

export default function ServerHomePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const slug = params.slug as string;
  const [request, setRequest] = useState(0);
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [loadError, setLoadError] = useState<StatsLoadError | null>(null);
  const [setupSlug, setSetupSlug] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const { t } = useAppSettings();
  const localMode = process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_MODE === "true";

  // Show setup wizard when redirected from onboarding
  useEffect(() => {
    if (searchParams.get("setup") === "true") {
      const frame = window.requestAnimationFrame(() => {
        setSetupSlug(slug);
        // Clean up URL without triggering navigation
        window.history.replaceState(window.history.state, "", `/s/${slug}`);
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [searchParams, slug]);

  const loadStats = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    const isCurrent = () => loadGenerationRef.current === generation;

    try {
      const supabase = createClient();
      const { data: server, error: serverError } = await supabase
        .from("servers")
        .select("id, name, description")
        .eq("slug", slug)
        .single();
      if (!isCurrent()) return;
      if (serverError || !server) {
        throw new Error(serverError?.message || t("workspace.notFound"));
      }

      const [agents, channels, members] = await Promise.all([
        supabase
          .from("agents")
          .select("*", { count: "exact", head: true })
          .eq("server_id", server.id),
        supabase
          .from("channels")
          .select("*", { count: "exact", head: true })
          .eq("server_id", server.id),
        supabase
          .from("server_members")
          .select("*", { count: "exact", head: true })
          .eq("server_id", server.id),
      ]);
      if (!isCurrent()) return;

      const countError = agents.error || channels.error || members.error;
      if (countError) throw new Error(countError.message);

      setStats({
        slug,
        request,
        id: server.id,
        name: server.name,
        description: server.description,
        agentCount: agents.count ?? 0,
        channelCount: channels.count ?? 0,
        memberCount: members.count ?? 0,
      });
      setLoadError(null);
    } catch (error) {
      if (!isCurrent()) return;
      setLoadError({
        slug,
        request,
        message: error instanceof Error ? error.message : t("workspace.notFound"),
      });
    }
  }, [request, slug, t]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadStats());
    return () => {
      window.cancelAnimationFrame(frame);
      loadGenerationRef.current += 1;
    };
  }, [loadStats]);

  const currentStats = stats?.slug === slug && stats.request === request ? stats : null;
  const currentError = loadError?.slug === slug && loadError.request === request
    ? loadError.message
    : "";
  const currentServerId = currentStats?.id || null;

  useEffect(() => {
    if (!currentServerId) return;
    const supabase = createClient();
    const refreshStats = createTrailingRefreshScheduler(loadStats, 120);
    const subscription = supabase
      .channel(`server-home:${currentServerId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agents", filter: `server_id=eq.${currentServerId}` },
        refreshStats.schedule,
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "agents", filter: `server_id=eq.${currentServerId}` },
        refreshStats.schedule,
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "channels", filter: `server_id=eq.${currentServerId}` },
        refreshStats.schedule,
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "channels", filter: `server_id=eq.${currentServerId}` },
        refreshStats.schedule,
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "server_members", filter: `server_id=eq.${currentServerId}` },
        refreshStats.schedule,
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "server_members", filter: `server_id=eq.${currentServerId}` },
        refreshStats.schedule,
      )
      .subscribe((status: string) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setLoadError({
            slug,
            request,
            message: "Workspace totals could not connect",
          });
        }
      });

    return () => {
      refreshStats.cancel();
      supabase.removeChannel(subscription);
    };
  }, [currentServerId, loadStats, request, slug]);

  if (!currentStats && !currentError) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-sm text-muted-foreground">{t("workspace.loading")}</div>
      </div>
    );
  }

  if (!currentStats) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <p role="alert" className="text-sm text-destructive">
            {currentError || t("workspace.notFound")}
          </p>
          <Button variant="outline" size="sm" onClick={() => setRequest((value) => value + 1)}>
            {t("runtime.retry")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8">
      <div className="max-w-md w-full text-center">
        <Avatar className="size-16 mx-auto mb-6">
          <AvatarFallback className="text-2xl font-bold">
            {currentStats.name.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <h1 className="text-xl font-semibold text-foreground mb-2">
          {currentStats.name}
        </h1>
        {(currentStats.description || localMode) && (
          <p className="text-sm text-muted-foreground mb-6">
            {localMode ? t("workspace.description") : currentStats.description}
          </p>
        )}

        {/* Stats */}
        <div className="flex justify-center gap-8 mb-8">
          <div className="text-center">
            <div className="text-2xl font-semibold text-foreground">
              {currentStats.agentCount}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">{t("workspace.agents")}</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-semibold text-foreground">
              {currentStats.channelCount}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">{t("workspace.channels")}</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-semibold text-foreground">
              {currentStats.memberCount}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">{t("workspace.members")}</div>
          </div>
        </div>

        <p className="text-sm text-muted-foreground mb-8">
          {t("workspace.prompt")}
        </p>

        {currentError && (
          <Button
            variant="ghost"
            size="sm"
            className="mb-6 text-destructive"
            onClick={() => void loadStats()}
          >
            {currentError} · {t("runtime.retry")}
          </Button>
        )}

        {/* API Keys Section */}
        {!localMode && (
          <div className="flex justify-center">
            <ApiKeysSection key={currentStats.id} serverId={currentStats.id} />
          </div>
        )}
      </div>

      {/* Setup wizard (shown after workspace creation) */}
      {setupSlug === slug && (
        <SetupWizard
          serverId={currentStats.id}
          serverSlug={slug}
          onComplete={() => setSetupSlug(null)}
        />
      )}
    </div>
  );
}
