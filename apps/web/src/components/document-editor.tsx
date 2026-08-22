"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "tiptap-markdown";
import { tightenMarkdownLists } from "@/lib/markdown-normalize";
import { useEffect } from "react";
import type { Editor } from "@tiptap/core";

interface MarkdownStorage {
  getMarkdown: () => string;
}

/** tiptap-markdown declares its storage through module augmentation the local
 * TypeScript setup does not pick up, so reach it explicitly rather than
 * loosening the editor type everywhere it is used. */
function markdownOf(editor: Editor): string {
  const raw = (editor.storage as unknown as Record<string, MarkdownStorage>).markdown.getMarkdown();
  return tightenMarkdownLists(raw);
}


/** What the selection toolbar offers, in the order Slack shows it. */
const MARKS: Array<{
  name: string;
  label: string;
  icon: string;
  run: (editor: Editor) => void;
}> = [
  { icon: "B", label: "Bold", name: "bold", run: (e) => e.chain().focus().toggleBold().run() },
  { icon: "I", label: "Italic", name: "italic", run: (e) => e.chain().focus().toggleItalic().run() },
  { icon: "S", label: "Strikethrough", name: "strike", run: (e) => e.chain().focus().toggleStrike().run() },
  { icon: "</>", label: "Code", name: "code", run: (e) => e.chain().focus().toggleCode().run() },
];

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
      // Work documents are full of things to do; Slack's canvas puts a
      // checkbox in reach for the same reason.
      TaskList,
      TaskItem.configure({ nested: true }),
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
    <>
      {editor && (
        // Formatting reaches for the text you have already selected, rather
        // than sending you to a toolbar at the edge of the window.
        <BubbleMenu editor={editor}>
          <div className="flex items-center gap-0.5 rounded-lg bg-card p-1 shadow-[0_0_0_1px_var(--border),0_1px_3px_0_rgba(0,0,0,0.08)]">
            {MARKS.map((mark) => (
              <button
                aria-label={mark.label}
                aria-pressed={editor.isActive(mark.name)}
                className={`flex size-7 items-center justify-center rounded text-[13px] transition-colors ${
                  editor.isActive(mark.name)
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/60"
                }`}
                key={mark.name}
                onClick={() => mark.run(editor)}
                title={mark.label}
                type="button"
              >
                {mark.icon}
              </button>
            ))}
          </div>
        </BubbleMenu>
      )}
      <EditorContent
        className="prose-message document-editor wrap-break-word text-[15px] subpixel-antialiased"
        editor={editor}
        style={{ lineHeight: "22px" }}
      />
    </>
  );
}
