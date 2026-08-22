"use client";

import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import Image from "@tiptap/extension-image";
import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api-url";
import { isAuthenticatedLocalAssetPath } from "@/lib/local-auth";

/**
 * Attachments are served behind the local controller's credential, and an
 * `<img src>` cannot carry it — so a picture a teammate attached would render
 * as a broken box inside the editor even though the document is perfectly
 * fine. This fetches the bytes the same way the message list does and hands
 * the node an object URL instead.
 */
function AuthenticatedImage({ node }: { node: { attrs: Record<string, unknown> } }) {
  const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const needsCredential = isAuthenticatedLocalAssetPath(src);
  const [resolved, setResolved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!needsCredential) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void fetch(apiUrl(src), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setResolved(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [needsCredential, src]);

  const displaySrc = needsCredential ? resolved : src;

  return (
    <NodeViewWrapper as="span" className="block">
      {displaySrc && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- local runtime URLs.
        <img alt={alt} className="max-h-80 max-w-full rounded-lg" src={displaySrc} />
      ) : (
        <span className="inline-block rounded border border-dashed px-2 py-1 text-xs text-muted-foreground">
          {alt || src}
        </span>
      )}
    </NodeViewWrapper>
  );
}

/** The image node, drawn through the credential-aware view above. */
export const DocumentImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(AuthenticatedImage);
  },
});
