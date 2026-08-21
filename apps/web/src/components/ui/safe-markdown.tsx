"use client";

import {
  DownloadIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { Children, useEffect, useState, type ComponentProps } from "react";
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
interface AttachmentMeta {
  display_name: string;
  mime_type: string;
  byte_size: number;
}

function formatByteSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

function FileIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/")) return <FileImageIcon aria-hidden="true" />;
  if (mimeType.startsWith("audio/")) return <FileAudioIcon aria-hidden="true" />;
  if (mimeType.startsWith("video/")) return <FileVideoIcon aria-hidden="true" />;
  if (mimeType === "application/zip") return <FileArchiveIcon aria-hidden="true" />;
  if (mimeType === "text/csv") return <FileSpreadsheetIcon aria-hidden="true" />;
  if (mimeType === "application/json") return <FileCodeIcon aria-hidden="true" />;
  return <FileTextIcon aria-hidden="true" />;
}

/** Metadata is cheap and lets a chip draw itself without downloading the file;
 * the bytes are only fetched when someone actually opens it. */
function useAttachmentMeta(path: string) {
  const [loaded, setLoaded] = useState<{ meta: AttachmentMeta; path: string } | null>(null);
  const [failedPath, setFailedPath] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(apiUrl(`${path}/meta`), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ attachment: AttachmentMeta }>;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setLoaded({ meta: payload.attachment, path });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailedPath(path);
        console.error(
          "Could not read the attachment:",
          error instanceof Error ? error.message : error,
        );
      });
    return () => controller.abort();
  }, [path]);

  return {
    failed: failedPath === path,
    meta: loaded?.path === path ? loaded.meta : null,
  };
}

/**
 * Images need their bytes to display, so decode them first and render at the
 * real aspect ratio — reserving the final box up front keeps the message from
 * reflowing under the reader as pictures arrive.
 */
function useAttachmentImage(path: string) {
  const [loaded, setLoaded] = useState<
    { height: number; path: string; url: string; width: number } | null
  >(null);
  const [failedPath, setFailedPath] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let created: string | null = null;
    void fetch(apiUrl(path), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then(async (blob) => {
        if (controller.signal.aborted) return;
        created = URL.createObjectURL(blob);
        const image = new Image();
        image.src = created;
        await image.decode().catch(() => undefined);
        if (controller.signal.aborted) return;
        setLoaded({
          height: image.naturalHeight || 1,
          path,
          url: created,
          width: image.naturalWidth || 1,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailedPath(path);
        console.error(
          "Could not load the image:",
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
    image: loaded?.path === path ? loaded : null,
  };
}

async function downloadAttachment(path: string, fileName: string) {
  const response = await fetch(apiUrl(path));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

function AttachmentImage({ alt, path }: { alt: string; path: string }) {
  const { failed, image } = useAttachmentImage(path);

  if (failed) {
    return (
      <span className="teammate-attachment teammate-attachment--failed">
        <FileImageIcon aria-hidden="true" />
        <span className="truncate">{alt}</span>
      </span>
    );
  }
  if (!image) {
    return (
      <span
        aria-label={alt}
        className="teammate-attachment-image teammate-attachment-image--loading"
        role="img"
      />
    );
  }
  return (
    <a
      className="teammate-attachment-image"
      href={image.url}
      rel="noreferrer noopener"
      style={{ aspectRatio: `${image.width} / ${image.height}`, maxWidth: `${image.width}px` }}
      target="_blank"
      title={alt}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- object URL for a
          locally stored blob; the Next image loader cannot fetch it. */}
      <img alt={alt} src={image.url} />
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
  const { failed, meta } = useAttachmentMeta(path);
  const [downloading, setDownloading] = useState(false);
  const fallbackName = typeof children === "string" ? children : "Attachment";
  const name = meta?.display_name || fallbackName;

  if (failed) {
    return (
      <span className="teammate-attachment teammate-attachment--failed">
        <FileIcon mimeType="" />
        <span className="truncate">{fallbackName}</span>
      </span>
    );
  }
  return (
    <button
      className="teammate-attachment"
      disabled={!meta || downloading}
      onClick={() => {
        if (!meta) return;
        setDownloading(true);
        void downloadAttachment(path, meta.display_name)
          .catch((error: unknown) => {
            console.error(
              "Could not download the attachment:",
              error instanceof Error ? error.message : error,
            );
          })
          .finally(() => setDownloading(false));
      }}
      title={name}
      type="button"
    >
      {downloading ? (
        <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
      ) : (
        <FileIcon mimeType={meta?.mime_type || ""} />
      )}
      <span className="teammate-attachment__name truncate">{name}</span>
      {meta && (
        <span className="teammate-attachment__meta">{formatByteSize(meta.byte_size)}</span>
      )}
      <DownloadIcon aria-hidden="true" className="teammate-attachment__action" />
    </button>
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

function ScrollableTable({
  children,
  node: _node,
  ...props
}: ComponentProps<"table"> & ExtraProps) {
  void _node;
  return (
    <div className="prose-message__table-scroll">
      <table {...props}>{children}</table>
    </div>
  );
}

const MENTION_PATTERN = /(@[^\s,.:!?，。！？]+)/g;

/** Highlights @mentions inside the text of a rendered block. Markdown gives
 * plain text back as string children, so only those need splitting. */
function highlightMentions(children: React.ReactNode): React.ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;
    const parts = child.split(MENTION_PATTERN);
    if (parts.length === 1) return child;
    return parts.map((part, index) =>
      part.startsWith("@") ? (
        <span
          className="rounded bg-primary/10 px-0.5 font-medium text-primary"
          key={index}
        >
          {part}
        </span>
      ) : (
        part
      ),
    );
  });
}

function MentionParagraph({
  children,
  node: _node,
  ...props
}: ComponentProps<"p"> & ExtraProps) {
  void _node;
  return <p {...props}>{highlightMentions(children)}</p>;
}

function MentionListItem({
  children,
  node: _node,
  ...props
}: ComponentProps<"li"> & ExtraProps) {
  void _node;
  return <li {...props}>{highlightMentions(children)}</li>;
}

const BASE_COMPONENTS = {
  a: SafeMarkdownLink,
  img: SafeMarkdownImage,
  table: ScrollableTable,
};

const MENTION_COMPONENTS = {
  ...BASE_COMPONENTS,
  li: MentionListItem,
  p: MentionParagraph,
};

export function SafeMarkdown({
  children,
  mentions = false,
}: {
  children: string;
  /** Highlight @mentions — on for messages people write, where a mention is
   * addressed at someone rather than quoted from a transcript. */
  mentions?: boolean;
}) {
  return (
    <ReactMarkdown
      components={mentions ? MENTION_COMPONENTS : BASE_COMPONENTS}
      remarkPlugins={[remarkGfm]}
      skipHtml
    >
      {children}
    </ReactMarkdown>
  );
}
