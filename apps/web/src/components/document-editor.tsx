"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import {
  collapseBlankLines,
  tightenMarkdownLists,
  unpadMarkdownTables,
} from "@/lib/markdown-normalize";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";

function markdownOf(editor: Editor): string {
  return unpadMarkdownTables(
    collapseBlankLines(tightenMarkdownLists(editor.getMarkdown())),
  ).trim();
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


interface BlockChoice {
  key: string;
  label: string;
  hint: string;
  run: (editor: Editor) => void;
}

/**
 * What "/" offers. These are the shapes a work document is actually made of,
 * and each one is something the Markdown round trip can carry back — offering
 * a block the file cannot hold would be a promise the document breaks on save.
 */
const BLOCKS: BlockChoice[] = [
  { hint: "#", key: "h1", label: "Heading 1", run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { hint: "##", key: "h2", label: "Heading 2", run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { hint: "###", key: "h3", label: "Heading 3", run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { hint: "- [ ]", key: "task", label: "Checklist", run: (e) => e.chain().focus().toggleTaskList().run() },
  { hint: "-", key: "bullet", label: "Bulleted list", run: (e) => e.chain().focus().toggleBulletList().run() },
  { hint: "1.", key: "ordered", label: "Numbered list", run: (e) => e.chain().focus().toggleOrderedList().run() },
  { hint: ">", key: "quote", label: "Quote", run: (e) => e.chain().focus().toggleBlockquote().run() },
  { hint: "```", key: "code", label: "Code block", run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { hint: "---", key: "rule", label: "Divider", run: (e) => e.chain().focus().setHorizontalRule().run() },
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
  // The "/" menu. Its state lives here rather than in the editor because the
  // list that renders it is React's, and the keyboard has to reach both.
  const [slash, setSlash] = useState<
    { from: number; query: string; left: number; top: number } | null
  >(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashRef = useRef<{ from: number; query: string } | null>(null);
  const slashIndexRef = useRef(0);
  const matches = useMemo(
    () =>
      slash
        ? BLOCKS.filter((block) =>
            block.label.toLowerCase().includes(slash.query.toLowerCase()),
          )
        : [],
    [slash],
  );
  const matchesRef = useRef<BlockChoice[]>([]);

  useEffect(() => {
    slashRef.current = slash;
    slashIndexRef.current = slashIndex;
    matchesRef.current = matches;
  }, [matches, slash, slashIndex]);

  const closeSlash = useCallback(() => {
    slashRef.current = null;
    setSlash(null);
    setSlashIndex(0);
  }, []);

  const editor = useEditor({
    content,
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: "focus:outline-none min-h-[55vh]",
      },
      handleKeyDown: (_view, event) => {
        const open = slashRef.current;
        const options = matchesRef.current;
        if (!open || options.length === 0) return false;
        if (event.key === "ArrowDown") {
          setSlashIndex((prev) => (prev + 1) % options.length);
          return true;
        }
        if (event.key === "ArrowUp") {
          setSlashIndex((prev) => (prev - 1 + options.length) % options.length);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          applyBlockRef.current(options[Math.min(slashIndexRef.current, options.length - 1)]);
          return true;
        }
        if (event.key === "Escape") {
          closeSlash();
          return true;
        }
        return false;
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
      // Tables are a normal part of a work document, and the official Markdown
      // extension lets each node say how it serialises, so a table an agent
      // wrote now survives being opened and saved.
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder }),
      Markdown,
    ],
    // The editor is created on the client only; rendering it on the server
    // and rehydrating produces a mismatch warning and an empty first paint.
    immediatelyRender: false,
    onSelectionUpdate: ({ editor: instance }) => {
      // Moving the caret away from the slash abandons the menu, the same way
      // clicking elsewhere would.
      const open = slashRef.current;
      if (open && instance.state.selection.from < open.from) closeSlash();
    },
    onUpdate: ({ editor: instance }) => {
      onChange(markdownOf(instance));
      trackSlashRef.current(instance);
    },
  });

  // "/" opens the menu only where a block could start: on an empty line, or
  // after a space. Mid-word it is a slash, and a date should not summon a menu.
  const trackSlash = useCallback(
    (instance: Editor) => {
      const { $from, empty } = instance.state.selection;
      if (!empty || instance.isActive("codeBlock")) {
        closeSlash();
        return;
      }
      const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\ufffc");
      const match = /(?:^|\s)\/([^\s/]*)$/.exec(before);
      if (!match) {
        closeSlash();
        return;
      }
      const from = $from.pos - match[1].length - 1;
      // Position is taken here, where the view is already in hand and the caret
      // is exactly where the menu should hang from.
      const box = instance.view.dom.getBoundingClientRect();
      const at = instance.view.coordsAtPos(from);
      const next = {
        from,
        left: at.left - box.left,
        query: match[1],
        top: at.bottom - box.top + 4,
      };
      slashRef.current = next;
      setSlash(next);
      setSlashIndex(0);
    },
    [closeSlash],
  );
  const trackSlashRef = useRef(trackSlash);

  const applyBlock = useCallback(
    (choice: BlockChoice) => {
      if (!editor) return;
      const open = slashRef.current;
      closeSlash();
      if (open) {
        // Take the "/query" back out before the block goes in, or it would be
        // left sitting inside the heading it just created.
        editor.chain().focus().deleteRange({ from: open.from, to: open.from + open.query.length + 1 }).run();
      }
      choice.run(editor);
    },
    [closeSlash, editor],
  );
  const applyBlockRef = useRef(applyBlock);

  useEffect(() => {
    trackSlashRef.current = trackSlash;
    applyBlockRef.current = applyBlock;
  }, [applyBlock, trackSlash]);

  // A document can change underneath the editor — a teammate writing to it, or
  // switching to another document entirely. Only replace the content when it
  // genuinely differs, or every keystroke would reset the cursor.
  useEffect(() => {
    if (!editor) return;
    if (markdownOf(editor) === content) return;
    editor.commands.setContent(content, { contentType: "markdown", emitUpdate: false });
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
      <div className="relative">
        <EditorContent
          className="prose-message document-editor wrap-break-word text-[15px] subpixel-antialiased"
          editor={editor}
          style={{ lineHeight: "22px" }}
        />
        {slash && matches.length > 0 && (
          // Anchored to the caret rather than to the block, so the menu opens
          // where you are typing however far into the line that is.
          <div
            className="absolute z-30 w-56 overflow-hidden rounded-lg bg-card py-1 shadow-[0_0_0_1px_var(--border),0_2px_8px_0_rgba(0,0,0,0.10)]"
            role="listbox"
            style={{ left: slash.left, top: slash.top }}
          >
            {matches.map((block, index) => (
              <button
                aria-selected={index === slashIndex}
                className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[13px] ${
                  index === slashIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-accent/50"
                }`}
                key={block.key}
                // The editor loses focus on mousedown otherwise, and the
                // command lands with nowhere to apply itself.
                onMouseDown={(event) => {
                  event.preventDefault();
                  applyBlock(block);
                }}
                role="option"
                type="button"
              >
                <span>{block.label}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{block.hint}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
