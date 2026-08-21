"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export interface ChannelView {
  id: string;
  server_id: string;
  name: string;
  type: string;
  description: string | null;
}

export function useChannel(channelId: string, serverId: string) {
  const [result, setResult] = useState<{
    channelId: string;
    serverId: string;
    channel: ChannelView | null;
    error: string;
    notFound: boolean;
  }>({ channelId: "", serverId: "", channel: null, error: "", notFound: false });
  const [retryToken, setRetryToken] = useState(0);
  const retry = useCallback(() => setRetryToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    const client = createClient();
    async function loadChannel() {
      try {
        const result = await client
          .from("channels")
          .select("id, server_id, name, type, description")
          .eq("id", channelId)
          .eq("server_id", serverId)
          .maybeSingle();
        if (cancelled) return;
        if (result.error) {
          setResult({
            channelId,
            serverId,
            channel: null,
            error: result.error.message,
            notFound: false,
          });
          return;
        }
        if (!result.data) {
          setResult({
            channelId,
            serverId,
            channel: null,
            error: "",
            notFound: true,
          });
          return;
        }
        setResult({
          channelId,
          serverId,
          channel: result.data as ChannelView,
          error: "",
          notFound: false,
        });
      } catch (loadError) {
        if (cancelled) return;
        setResult({
          channelId,
          serverId,
          channel: null,
          error: loadError instanceof Error ? loadError.message : "Could not load conversation",
          notFound: false,
        });
      }
    }
    void loadChannel();

    const subscription = client
      .channel(`channel-view:${serverId}:${channelId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "channels", filter: `id=eq.${channelId}` },
        (payload: { new: ChannelView }) => {
          if (!cancelled && payload.new.server_id === serverId) {
            setResult({
              channelId,
              serverId,
              channel: payload.new,
              error: "",
              notFound: false,
            });
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "channels", filter: `id=eq.${channelId}` },
        (payload: { old: Partial<ChannelView> }) => {
          if (!cancelled && (!payload.old.server_id || payload.old.server_id === serverId)) {
            setResult({
              channelId,
              serverId,
              channel: null,
              error: "",
              notFound: true,
            });
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      client.removeChannel(subscription);
    };
  }, [channelId, retryToken, serverId]);

  const current = result.channelId === channelId && result.serverId === serverId;
  return {
    channel: current ? result.channel : null,
    error: current ? result.error : "",
    notFound: current ? result.notFound : false,
    loading: !current,
    retry,
  };
}
