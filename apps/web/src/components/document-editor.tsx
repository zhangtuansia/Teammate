"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { useEffect } from "react";
import type { Editor } from "@tiptap/core";

interface MarkdownStorage {
  getMarkdown: () => string;
}

/** tiptap-markdown declares its storage through module augmentation the local
 * TypeScript setup does not pick up, so reach it explicitly rather than
 * loosening the editor type everywhere it is used. */
function markdownOf(editor: Editor): string {
  return (editor.storage as unknown as Record<string, MarkdownStorage>).markdown.getMarkdown();
}

/**
 * The document, edited where it is read. It is deliberately not a form: there
 * is no field, no label and no box, because a document is not a set of values
 * someone fills in — the page you look at is the page you type on.
 *
 * Markdown stays the stored form. It is what teammates read and write through
 * the CLI, it diffs, and it outlives any editor we happen to use.
 */
export function DocumentEditor({
  content,
  onChange,
  placeholder,
}: {
  content: string;
  onChange: (markdown: string) => void;
  placeholder: string;
}) {
  const editor = useEditor({
    content,
    editorProps: {
      attributes: {
        class: "focus:outline-none min-h-[55vh]",
      },
    },
    extensions: [
      StarterKit.configure({
        dropcursor: false,
        gapcursor: false,
        link: false,
      }),
      Link.configure({ autolink: true, linkOnPaste: true, openOnClick: false }),
      Placeholder.configure({ placeholder }),
      Markdown.configure({
        // The stored document keeps the shape a person or a teammate wrote it
        // in; the editor should not go re-flowing paragraphs behind them.
        breaks: true,
        linkify: false,
        transformPastedText: true,
      }),
    ],
    // The editor is created on the client only; rendering it on the server
    // and rehydrating produces a mismatch warning and an empty first paint.
    immediatelyRender: false,
    onUpdate: ({ editor: instance }) => {
      onChange(markdownOf(instance));
    },
  });

  // A document can change underneath the editor — a teammate writing to it, or
  // switching to another document entirely. Only replace the content when it
  // genuinely differs, or every keystroke would reset the cursor.
  useEffect(() => {
    if (!editor) return;
    if (markdownOf(editor) === content) return;
    editor.commands.setContent(content, { emitUpdate: false });
  }, [content, editor]);

  return (
    <EditorContent
      className="prose-message document-editor wrap-break-word text-[15px] subpixel-antialiased"
      editor={editor}
      style={{ lineHeight: "22px" }}
    />
  );
}
