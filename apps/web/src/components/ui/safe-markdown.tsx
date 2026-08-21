"use client";

import { useEffect, useState, type ComponentProps } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiUrl } from "@/lib/api-url";
import { isLocalAttachmentPath } from "@/lib/local-auth";

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Attachments are served by the local service behind the controller
 * credential, which an `<img src>` or a plain link cannot carry. Fetch the
 * bytes once and hand the element an object URL instead.
 */
function useLocalAttachment(path: string) {
  // Both results are keyed by the path they describe, so a changed path reads
  // as "not loaded yet" without an effect having to reset anything first.
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null);
  const [failedPath, setFailedPath] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let created: string | null = null;
    void fetch(apiUrl(path), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        created = URL.createObjectURL(blob);
        setLoaded({ path, url: created });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailedPath(path);
        console.error(
          "Could not load the attachment:",
          error instanceof Error ? error.message : error,
        );
      });
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [path]);

  return {
    failed: failedPath === path,
    objectUrl: loaded?.path === path ? loaded.url : null,
  };
}

function AttachmentImage({ alt, path }: { alt: string; path: string }) {
  const { failed, objectUrl } = useLocalAttachment(path);
  if (failed) return <span className="text-muted-foreground">[{alt}]</span>;
  if (!objectUrl) {
    return (
      <span
        aria-label={alt}
        className="my-1 block h-32 w-48 animate-pulse rounded-lg bg-muted"
        role="img"
      />
    );
  }
  return (
    <a href={objectUrl} rel="noreferrer noopener" target="_blank">
      {/* eslint-disable-next-line @next/next/no-img-element -- object URL for a
          locally stored blob; the Next image loader cannot fetch it. */}
      <img
        alt={alt}
        className="my-1 max-h-80 max-w-full rounded-lg border"
        src={objectUrl}
      />
    </a>
  );
}

function AttachmentLink({
  children,
  path,
}: {
  children: React.ReactNode;
  path: string;
}) {
  const { failed, objectUrl } = useLocalAttachment(path);
  const label = typeof children === "string" ? children : "Attachment";
  if (failed) return <span className="text-muted-foreground">{children}</span>;
  return (
    <a
      aria-busy={objectUrl ? undefined : true}
      className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2 py-1 align-middle text-sm no-underline"
      download={label}
      href={objectUrl || undefined}
      rel="noreferrer noopener"
      target="_blank"
    >
      <svg
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        viewBox="0 0 24 24"
      >
        <path
          d="M14.5 3.5V8a1 1 0 0 0 1 1h4.5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="truncate">{children}</span>
    </a>
  );
}

function safeExternalLink(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

function SafeMarkdownLink({
  href,
  children,
  node: _node,
  ...props
}: ComponentProps<"a"> & ExtraProps) {
  void _node;
  if (href && isLocalAttachmentPath(href)) {
    return <AttachmentLink path={href}>{children}</AttachmentLink>;
  }
  const safeHref = safeExternalLink(href);
  if (!safeHref) return <span>{children}</span>;
  return (
    <a
      {...props}
      data-teammate-external-link=""
      href={safeHref}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
    </a>
  );
}

function SafeMarkdownImage({
  alt,
  src,
  node: _node,
}: ComponentProps<"img"> & ExtraProps) {
  void _node;
  const label = alt?.trim() || "Image";
  if (typeof src === "string" && isLocalAttachmentPath(src)) {
    return <AttachmentImage alt={label} path={src} />;
  }
  const safeSrc = typeof src === "string" ? safeExternalLink(src) : null;
  const content = <span>[{label}]</span>;

  if (!safeSrc || new URL(safeSrc).protocol === "mailto:") return content;

  return (
    <a
      data-teammate-external-link=""
      href={safeSrc}
      rel="noreferrer noopener"
      target="_blank"
    >
      {content}
    </a>
  );
}

export function SafeMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      components={{ a: SafeMarkdownLink, img: SafeMarkdownImage }}
      remarkPlugins={[remarkGfm]}
      skipHtml
    >
      {children}
    </ReactMarkdown>
  );
}
