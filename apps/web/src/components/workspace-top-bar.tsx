"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  FileTextIcon,
  HashIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  SearchIcon,
  XIcon,
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
const WORKSPACE_SECTION_SELECTOR = "[data-workspace-keyboard-section]";

function visibleWorkspaceSections() {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(WORKSPACE_SECTION_SELECTOR),
  ).filter((element) => element.getClientRects().length > 0 && !element.closest("[inert]"));

  // A generic content region is useful for documents and settings, but a
  // conversation exposes more precise transcript/thread regions inside it.
  // Keep the smallest labelled region so F6 never makes people stop twice in
  // what is visually one pane.
  return candidates.filter(
    (element) => !candidates.some((candidate) => candidate !== element && element.contains(candidate)),
  );
}

interface SearchHit {
  avatarId?: string;
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
    thread_parent_id: string | null;
  }>;
}

const KIND_ICON = {
  agent: BotIcon,
  channel: HashIcon,
  document: FileTextIcon,
  message: MessageSquareIcon,
};

function toHits(data: SearchResponse, serverSlug: string, departedLabel: string): SearchHit[] {
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
      avatarId: agent.id,
      detail: agent.departed_at ? departedLabel : "",
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
    const mainMessageId = message.thread_parent_id || message.id;
    const target = new URLSearchParams({ message: mainMessageId });
    if (message.thread_parent_id) {
      target.set("thread", message.thread_parent_id);
      target.set("reply", message.id);
    }
    hits.push({
      detail: message.snippet,
      href: `/s/${serverSlug}/${message.channel_type === "dm" ? "dm" : "channel"}/${message.channel_id}?${target.toString()}`,
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
  const { run: runGuardedAction } = useWorkspaceNavigation();
  const { t } = useAppSettings();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [resolvedPhrase, setResolvedPhrase] = useState("");
  const [searchRevision, setSearchRevision] = useState(0);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const fieldRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const phrase = query.trim();
  // Kept out of state so a query shrinking below the threshold does not need an
  // effect to clear the list; the last results simply stop being shown, which
  // also keeps them from flickering away between keystrokes.
  const results = phrase.length >= 2 && resolvedPhrase === phrase ? hits : [];
  const activeResultId = open && searchState === "ready"
    ? results[highlighted]?.id
    : undefined;

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
        if (!response.ok) throw new Error(`Search failed with HTTP ${response.status}`);
        const data = (await response.json()) as SearchResponse;
        setHits(toHits(data, serverSlug, t("agent.departed")));
        setResolvedPhrase(phrase);
        setSearchState("ready");
        setHighlighted(0);
      } catch {
        if (!controller.signal.aborted) {
          setHits([]);
          setResolvedPhrase(phrase);
          setSearchState("error");
        }
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, searchRevision, serverId, serverSlug, t]);

  // Keep the workspace-level navigation shortcuts available regardless of
  // which pane currently owns focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        fieldRef.current?.focus();
        fieldRef.current?.select();
        setOpen(true);
        return;
      }
      const goBack = event.metaKey && event.key === "[";
      const goForward = event.metaKey && event.key === "]";
      if (goBack || goForward) {
        event.preventDefault();
        runGuardedAction(() => {
          if (goBack) router.back();
          else router.forward();
        });
        return;
      }
      if (event.key !== "F6" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const sections = visibleWorkspaceSections();
      if (sections.length === 0) return;
      const active = document.activeElement;
      const currentIndex = sections.findIndex(
        (section) => section === active || (active instanceof Node && section.contains(active)),
      );
      const offset = event.shiftKey ? -1 : 1;
      const nextIndex = currentIndex === -1
        ? (event.shiftKey ? sections.length - 1 : 0)
        : (currentIndex + offset + sections.length) % sections.length;
      event.preventDefault();
      sections[nextIndex]?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, runGuardedAction]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    if (!activeResultId) return;
    document.getElementById(`workspace-search-${activeResultId}`)?.scrollIntoView({ block: "nearest" });
  }, [activeResultId]);

  const go = useCallback(
    (hit: SearchHit) => {
      // Do not throw away the query before the unsaved-work guard resolves.
      // Cancelling that dialog should return people to exactly what they found.
      runGuardedAction(() => {
        setOpen(false);
        setQuery("");
        fieldRef.current?.blur();
        router.push(hit.href);
      });
    },
    [router, runGuardedAction],
  );

  const clearSearch = useCallback(() => {
    setQuery("");
    setHits([]);
    setResolvedPhrase("");
    setSearchState("idle");
    setHighlighted(0);
    fieldRef.current?.focus();
  }, []);

  const onFieldKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (query) {
        clearSearch();
        return;
      }
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

  const kindLabel = (kind: SearchHit["kind"]) => t(`search.kind.${kind}`);

  return (
    <header
      className="desktop-top-bar desktop-native-drag relative z-20 flex h-10 flex-none items-center gap-1 bg-rail pr-3"
      data-tauri-drag-region
    >
      <div className="desktop-top-bar-lead flex-none" aria-hidden="true" />

      <button
        type="button"
        onClick={() => runGuardedAction(() => router.back())}
        title={t("nav.back")}
        aria-label={t("nav.back")}
        className="desktop-no-drag flex size-[26px] flex-none items-center justify-center rounded-md text-rail-foreground/70 outline-none transition-colors hover:bg-rail-foreground/6 hover:text-rail-foreground active:bg-rail-foreground/13 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeftIcon className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => runGuardedAction(() => router.forward())}
        title={t("nav.forward")}
        aria-label={t("nav.forward")}
        className="desktop-no-drag flex size-[26px] flex-none items-center justify-center rounded-md text-rail-foreground/70 outline-none transition-colors hover:bg-rail-foreground/6 hover:text-rail-foreground active:bg-rail-foreground/13 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowRightIcon className="size-4" />
      </button>

      <div ref={boxRef} className="desktop-no-drag relative mx-auto w-full max-w-[679px]">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-rail-foreground/45" />
        <input
          aria-activedescendant={
            activeResultId
              ? `workspace-search-${activeResultId}`
              : undefined
          }
          aria-autocomplete="list"
          aria-controls="workspace-search-results"
          aria-expanded={open && phrase.length >= 2}
          ref={fieldRef}
          value={query}
          onChange={(event) => {
            const nextQuery = event.target.value;
            setQuery(nextQuery);
            setOpen(true);
            setHighlighted(0);
            setResolvedPhrase("");
            if (nextQuery.trim().length >= 2) {
              setSearchState("loading");
            } else {
              setHits([]);
              setSearchState("idle");
            }
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onFieldKeyDown}
          placeholder={`${t("search.placeholder")} ${serverName}`}
          aria-label={t("search.placeholder")}
          data-workspace-keyboard-section
          role="combobox"
          className="h-7 w-full rounded-[4px] bg-rail-foreground/12 pr-14 pl-8 text-[13px] text-rail-foreground placeholder:text-rail-foreground/60 focus:ring-2 focus:ring-ring/40 focus:outline-none"
        />

        {query ? (
          <button
            aria-label={t("search.clear")}
            className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded text-rail-foreground/60 transition-colors hover:bg-rail-foreground/10 hover:text-rail-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={clearSearch}
            title={t("search.clear")}
            type="button"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : (
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-rail-foreground/20 px-1 py-px text-[10px] font-medium leading-none text-rail-foreground/50">
            ⌘K
          </span>
        )}

        {open && phrase.length >= 2 && (
          <div
            className="workspace-popover absolute top-9 right-0 left-0 max-h-[60vh] overflow-y-auto rounded-lg bg-popover p-1"
            id="workspace-search-results"
            role="listbox"
          >
            {searchState === "loading" ? (
              <p className="flex items-center justify-center gap-2 px-3 py-6 text-[13px] text-muted-foreground" role="status">
                <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" />
                {t("search.loading")}
              </p>
            ) : searchState === "error" ? (
              <div className="flex items-center justify-between gap-3 px-3 py-4 text-[13px] text-muted-foreground" role="alert">
                <span>{t("search.failed")}</span>
                <button
                  className="rounded-md px-2 py-1 font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => {
                    setResolvedPhrase("");
                    setSearchState("loading");
                    setSearchRevision((revision) => revision + 1);
                  }}
                  type="button"
                >
                  {t("runtime.retry")}
                </button>
              </div>
            ) : results.length === 0 ? (
              <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">
                {t("search.empty")}
              </p>
            ) : (
              results.map((hit, index) => {
                const Icon = KIND_ICON[hit.kind];
                const startsGroup = index === 0 || results[index - 1]?.kind !== hit.kind;
                return (
                  <div key={hit.id} role="presentation">
                    {startsGroup && (
                      <p className="px-2.5 pt-2 pb-1 text-[11px] font-bold text-muted-foreground">
                        {kindLabel(hit.kind)}
                      </p>
                    )}
                    <button
                      aria-selected={index === highlighted}
                      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left ${
                        index === highlighted ? "bg-accent" : ""
                      }`}
                      id={`workspace-search-${hit.id}`}
                      onClick={() => go(hit)}
                      onFocus={() => setHighlighted(index)}
                      onPointerEnter={() => setHighlighted(index)}
                      role="option"
                      type="button"
                    >
                      {hit.kind === "agent" ? (
                        <GeneratedAvatar id={hit.avatarId || hit.id} name={hit.title} size="xs" />
                      ) : (
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
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
                  </div>
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
