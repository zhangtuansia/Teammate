"use client";

import { useParams } from "next/navigation";
import { MessageArea } from "@/components/message-area";
import { useChannel } from "@/hooks/use-channel";
import { useAppSettings } from "@/hooks/use-app-settings";
import { useWorkspaceServer } from "@/components/workspace-server-context";
import { Button } from "@/components/ui/button";

export default function ChannelPage() {
  const params = useParams();
  const channelId = params.channelId as string;
  const server = useWorkspaceServer();
  const { channel, error, loading, notFound, retry } = useChannel(channelId, server.id);
  const { t } = useAppSettings();

  if (error || notFound) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-destructive" role="alert" title={error || undefined}>
          {notFound ? t("conversation.notFound") : t("conversation.loadFailed")}
        </p>
        {!notFound && (
          <Button onClick={retry} size="sm" variant="outline">
            {t("runtime.retry")}
          </Button>
        )}
      </div>
    );
  }
  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t("conversation.loading")}</div>;
  }

  return <MessageArea channel={channel} />;
}
