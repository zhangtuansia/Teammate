"use client";

import { memo, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api-url";

interface Preview {
  url: string;
  title: string | null;
  description: string | null;
  site_name?: string | null;
  siteName?: string | null;
}

/** Links already fetched this session, so a re-render is not a new request. */
const cache = new Map<string, Preview | null>();
const inFlight = new Map<string, Promise<Preview | null>>();

function loadPreview(url: string): Promise<Preview | null> {
  const pending = inFlight.get(url);
  if (pending) return pending;
  const request = fetch(apiUrl("/api/link-preview"), {
    body: JSON.stringify({ url }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
    .then((response) => (response.ok ? response.json() : { preview: null }))
    .then((body: { preview: Preview | null }) => body.preview ?? null)
    .catch(() => null)
    .then((preview) => {
      cache.set(url, preview);
      inFlight.delete(url);
      return preview;
    });
  inFlight.set(url, request);
  return request;
}

/**
 * Slack's unfurl: a card under the message showing what is on the other end of
 * a link. The remote image is deliberately not rendered — loading it would have
 * this machine reach out to whoever the link belongs to just because a message
 * scrolled past, and that is a decision for the person, not for a transcript.
 */
export const LinkPreviewCard = memo(function LinkPreviewCard({ url }: { url: string }) {
  const [preview, setPreview] = useState<Preview | null | undefined>(() =>
    cache.has(url) ? cache.get(url) : undefined,
  );

  useEffect(() => {
    if (cache.has(url)) {
      setPreview(cache.get(url) ?? null);
      return;
    }
    let active = true;
    void loadPreview(url).then((next) => {
      if (active) setPreview(next);
    });
    return () => {
      active = false;
    };
  }, [url]);

  if (!preview || (!preview.title && !preview.description)) return null;
  const site = preview.site_name ?? preview.siteName ?? null;

  return (
    <a
      className="mt-1.5 flex max-w-[520px] flex-col gap-0.5 rounded-r-[4px] border-l-4 border-border bg-accent/40 py-1.5 pl-3 pr-3 no-underline hover:bg-accent"
      href={preview.url}
      rel="noreferrer noopener"
      target="_blank"
    >
      {site && <span className="text-xs text-muted-foreground">{site}</span>}
      {preview.title && (
        <span className="text-[15px] font-bold leading-[22px] text-primary">
          {preview.title}
        </span>
      )}
      {preview.description && (
        <span className="line-clamp-3 text-[13px] leading-[18px] text-muted-foreground">
          {preview.description}
        </span>
      )}
    </a>
  );
});

/** The links a message body points at, in order, without duplicates. */
export function extractLinks(markdown: string, limit = 2) {
  const found: string[] = [];
  const pattern = /https?:\/\/[^\s<>()[\]"']+/g;
  for (const match of markdown.matchAll(pattern)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    // Attachment references point back at this service; they render as cards
    // of their own and have nothing to unfurl.
    if (url.includes("/api/attachments/")) continue;
    if (!found.includes(url)) found.push(url);
    if (found.length >= limit) break;
  }
  return found;
}
