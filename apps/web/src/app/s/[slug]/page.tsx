"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ApiKeysSection } from "@/components/api-keys-section";
import { SetupWizard } from "@/components/setup-wizard";

interface ServerStats {
  id: string;
  name: string;
  description: string | null;
  agentCount: number;
  channelCount: number;
  memberCount: number;
}

export default function ServerHomePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const slug = params.slug as string;
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSetup, setShowSetup] = useState(false);

  // Show setup wizard when redirected from onboarding
  useEffect(() => {
    if (searchParams.get("setup") === "true") {
      setShowSetup(true);
      // Clean up URL without triggering navigation
      window.history.replaceState({}, "", `/s/${slug}`);
    }
  }, [searchParams, slug]);

  useEffect(() => {
    async function loadStats() {
      const supabase = createClient();

      const { data: server } = await supabase
        .from("servers")
        .select("id, name, description")
        .eq("slug", slug)
        .single();

      if (!server) {
        setLoading(false);
        return;
      }

      const [{ count: agentCount }, { count: channelCount }, { count: memberCount }] =
        await Promise.all([
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

      setStats({
        id: server.id,
        name: server.name,
        description: server.description,
        agentCount: agentCount ?? 0,
        channelCount: channelCount ?? 0,
        memberCount: memberCount ?? 0,
      });
      setLoading(false);
    }

    loadStats();
  }, [slug]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-sm text-muted-foreground">Workspace not found</div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8">
      <div className="max-w-md w-full text-center">
        <Avatar className="size-16 mx-auto mb-6">
          <AvatarFallback className="text-2xl font-bold">
            {stats.name.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <h1 className="text-xl font-semibold text-foreground mb-2">
          {stats.name}
        </h1>
        {stats.description && (
          <p className="text-sm text-muted-foreground mb-6">{stats.description}</p>
        )}

        {/* Stats */}
        <div className="flex justify-center gap-8 mb-8">
          <div className="text-center">
            <div className="text-2xl font-semibold text-foreground">
              {stats.agentCount}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Agents</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-semibold text-foreground">
              {stats.channelCount}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Channels</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-semibold text-foreground">
              {stats.memberCount}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Members</div>
          </div>
        </div>

        <p className="text-sm text-muted-foreground mb-8">
          Select an agent or channel from the sidebar to start a conversation.
        </p>

        {/* API Keys Section */}
        <div className="flex justify-center">
          <ApiKeysSection serverId={stats.id} />
        </div>
      </div>

      {/* Setup wizard (shown after workspace creation) */}
      {showSetup && stats && (
        <SetupWizard
          serverId={stats.id}
          serverSlug={slug}
          onComplete={() => setShowSetup(false)}
        />
      )}
    </div>
  );
}
