import type { ComponentProps } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

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
