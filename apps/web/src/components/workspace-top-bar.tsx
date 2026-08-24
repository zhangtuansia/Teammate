"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  FileTextIcon,
  HashIcon,
  MessageSquareIcon,
  SearchIcon,
} from "lucide-react";
import { apiUrl } from "@/lib/api-url";
import { useAppSettings } from "@/hooks/use-app-settings";
import { useWorkspaceNavigation } from "@/hooks/use-navigation-guard";
import { GeneratedAvatar } from "./generated-avatar";

/**
 * The strip across the very top of the window: window controls, history, and
 * search.
 *
 * It spans the full width above both the rail and the panels, which is what
 * makes it the right home for search. Search is the one thing that has to reach
 * across the areas the rail keeps apart — you remember that something was said,
 * not whether it was said in a channel, a DM, or written down — so it cannot
 * live inside any one of them.
 *
 * Measured off Slack's own top nav: 40px tall, 26px history buttons, and a
 * centred 28px-tall field. The window controls sit in the leading gap, so the
 * panels below no longer reserve room for them.
 *
 * If the height here changes, `trafficLightPosition.y` in tauri.conf.json has
 * to change with it, to half of it. That reads like the top of the lights but
 * is not: tao resizes the whole title-bar container to `buttonHeight + y` and
 * never touches the buttons' own vertical offset inside it, which leaves `y`
 * behaving as the centre. Half the bar height centres them; anything derived
 * from the 12px circle puts them too high. It is applied when the window is
 * created, so a running app has to be restarted, not reloaded.
 */

const SEARCH_DEBOUNCE_MS = 180;

interface SearchHit {
  id: string;
  kind: "channel" | "agent" | "document" | "message";
  title: string;
  detail: string;
  href: string;
}

interface SearchResponse {
  agents?: Array<{ id: string; display_name: string; name: string; departed_at: string | null }>;
  channels?: Array<{ id: string; name: string; type: string; description: string | null }>;
  documents?: Array<{ id: string; title: string; folder_path: string; snippet: string }>;
  messages?: Array<{
    id: string;
    channel_id: string;
    channel_name: string;
    channel_type: string;
    sender_name: string | null;
    snippet: string;
  }>;
}

const KIND_ICON = {
  agent: BotIcon,
  channel: HashIcon,
  document: FileTextIcon,
  message: MessageSquareIcon,
};

function toHits(data: SearchResponse, serverSlug: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const channel of data.channels || []) {
    hits.push({
      detail: channel.description || "",
      href: `/s/${serverSlug}/channel/${channel.id}`,
      id: `channel:${channel.id}`,
      kind: "channel",
      title: channel.name,
    });
  }
  for (const agent of data.agents || []) {
    hits.push({
      detail: agent.departed_at ? "已离职" : "",
      href: `/s/${serverSlug}?agent=${agent.id}`,
      id: `agent:${agent.id}`,
      kind: "agent",
      title: agent.display_name || agent.name,
    });
  }
  for (const document of data.documents || []) {
    hits.push({
      detail: document.folder_path || document.snippet,
      href: `/s/${serverSlug}/documents?document=${document.id}`,
      id: `document:${document.id}`,
      kind: "document",
      title: document.title,
    });
  }
  for (const message of data.messages || []) {
    const where = message.channel_type === "dm" ? "" : `#${message.channel_name} · `;
    hits.push({
      detail: message.snippet,
      href: `/s/${serverSlug}/${message.channel_type === "dm" ? "dm" : "channel"}/${message.channel_id}?message=${message.id}`,
      id: `message:${message.id}`,
      kind: "message",
      title: `${where}${message.sender_name || ""}`.replace(/ · $/, ""),
    });
  }
  return hits;
}

export function WorkspaceTopBar({
  serverId,
  serverName,
  serverSlug,
}: {
  serverId: string;
  serverName: string;
  serverSlug: string;
}) {
  const router = useRouter();
  const { navigate } = useWorkspaceNavigation();
  const { t } = useAppSettings();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const fieldRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const phrase = query.trim();
  // Kept out of state so a query shrinking below the threshold does not need an
  // effect to clear the list; the last results simply stop being shown, which
  // also keeps them from flickering away between keystrokes.
  const results = phrase.length >= 2 ? hits : [];

  useEffect(() => {
    const phrase = query.trim();
    if (phrase.length < 2) return;
    const controller = new AbortController();
    // Typing is faster than searching; only the pause is worth a round trip.
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          apiUrl(`/api/search?server_id=${encodeURIComponent(serverId)}&q=${encodeURIComponent(phrase)}`),
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const data = (await response.json()) as SearchResponse;
        setHits(toHits(data, serverSlug));
        setHighlighted(0);
      } catch {
        // An aborted or failed search leaves the last results alone rather than
        // blanking the list under someone still typing.
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, serverId, serverSlug]);

  // ⌘K from anywhere, the shortcut every app of this shape uses.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        fieldRef.current?.focus();
        fieldRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const go = useCallback(
    (hit: SearchHit) => {
      setOpen(false);
      setQuery("");
      fieldRef.current?.blur();
      navigate(hit.href);
    },
    [navigate],
  );

  const onFieldKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      fieldRef.current?.blur();
      return;
    }
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((index) => (index + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = results[highlighted];
      if (hit) go(hit);
    }
  };

  return (
    <header
      className="desktop-top-bar desktop-native-drag relative z-20 flex h-10 flex-none items-center gap-1 bg-rail pr-3"
      data-tauri-drag-region
    >
      <div className="desktop-top-bar-lead flex-none" aria-hidden="true" />

      <button
        type="button"
        onClick={() => router.back()}
        title={t("nav.back")}
        aria-label={t("nav.back")}
        className="desktop-no-drag flex size-[26px] flex-none items-center justify-center rounded-md text-rail-foreground/70 transition-colors hover:bg-rail-foreground/6 hover:text-rail-foreground active:bg-rail-foreground/13"
      >
        <ArrowLeftIcon className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => router.forward()}
        title={t("nav.forward")}
        aria-label={t("nav.forward")}
        className="desktop-no-drag flex size-[26px] flex-none items-center justify-center rounded-md text-rail-foreground/70 transition-colors hover:bg-rail-foreground/6 hover:text-rail-foreground active:bg-rail-foreground/13"
      >
        <ArrowRightIcon className="size-4" />
      </button>

      <div ref={boxRef} className="desktop-no-drag relative mx-auto w-full max-w-[679px]">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-rail-foreground/45" />
        <input
          ref={fieldRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onFieldKeyDown}
          placeholder={`${t("search.placeholder")} ${serverName}`}
          aria-label={t("search.placeholder")}
          className="h-7 w-full rounded-[4px] bg-rail-foreground/12 pl-8 text-[13px] text-rail-foreground placeholder:text-rail-foreground/60 focus:ring-2 focus:ring-ring/40 focus:outline-none"
        />

        {open && query.trim().length >= 2 && (
          <div className="workspace-popover absolute top-9 right-0 left-0 max-h-[60vh] overflow-y-auto rounded-lg bg-popover p-1">
            {results.length === 0 ? (
              <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">
                {t("search.empty")}
              </p>
            ) : (
              results.map((hit, index) => {
                const Icon = KIND_ICON[hit.kind];
                return (
                  <button
                    key={hit.id}
                    type="button"
                    onPointerEnter={() => setHighlighted(index)}
                    onClick={() => go(hit)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left ${
                      index === highlighted ? "bg-accent" : ""
                    }`}
                  >
                    {hit.kind === "agent" ? (
                      <GeneratedAvatar id={hit.id} name={hit.title} size="xs" />
                    ) : (                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">
                        {hit.title}
                      </span>
                      {hit.detail && (
                        <span className="block truncate text-[12px] text-muted-foreground">
                          {hit.detail}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Balances the history buttons so the field stays centred in the bar. */}
      <div className="w-[58px] flex-none" aria-hidden="true" />
    </header>
  );
}
