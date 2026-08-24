"use client";

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { MentionNode } from "./mention-node";
import Link from "@tiptap/extension-link";
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import {
  BoldIcon,
  CodeIcon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  SquareCodeIcon,
  StrikethroughIcon,
  TextQuoteIcon,
} from "lucide-react";
import { forwardRef, useImperativeHandle, useEffect, useReducer } from "react";
import { Toggle } from "@/components/ui/toggle";

export interface TiptapMessageInputHandle {
  focus: () => void;
  clear: () => void;
  getMarkdown: () => string;
  /** Insert text at the cursor and focus, for composer shortcuts like "@". */
  insertText: (text: string) => void;
  /** Replace a `<trigger><query>` run near the cursor with the replacement. */
  replaceMention: (query: string, replacement: string, trigger?: string) => void;
  /** Replace the typed `@query` with a mention that reads as a name. */
  insertMention: (query: string, handle: string, label: string) => void;
}

interface TiptapMessageInputProps {
  placeholder?: string;
  ariaLabel?: string;
  ariaControls?: string;
  ariaExpanded?: boolean;
  ariaActiveDescendant?: string;
  disabled?: boolean;
  initialContent?: string;
  /** Render the formatting toolbar above the editor. */
  showFormatting?: boolean;
  /** Localized labels for the formatting controls. */
  formattingLabels?: Partial<Record<FormattingAction, string>>;
  /** Called when user presses Enter on non-empty content */
  onSend: (text: string) => boolean | void | Promise<boolean | void>;
  /** Called on every content change */
  onTextUpdate?: (textBeforeCursor: string, fullText: string) => void;
  /** Called when only the cursor selection changes. */
  onSelectionUpdate?: (textBeforeCursor: string) => void;
  /** Intercept keys before Tiptap. Return true to consume (for @mention nav). */
  onKeyDown?: (event: KeyboardEvent) => boolean;
  /** Files pasted into the editor, so a screenshot can go straight into a message. */
  onPasteFiles?: (files: File[]) => void;
}

export type FormattingAction =
  | "bold"
  | "italic"
  | "strike"
  | "orderedList"
  | "bulletList"
  | "blockquote"
  | "code"
  | "codeBlock";

/**
 * Serializes the document to the Markdown the workspace stores and renders.
 *
 * Written by hand rather than delegated to a generic serializer so plain
 * prose survives untouched: a generic one escapes Markdown punctuation, which
 * would turn ordinary chat text like snake_case or a * bullet into backslash
 * noise for every message anyone sends.
 */
function serializeInline(node: ProseMirrorNode): string {
  let out = "";
  node.forEach((child) => {
    if (child.type.name === "hardBreak") {
      out += "\n";
      return;
    }
    if (child.type.name === "mention") {
      // The handle is what the message carries; the label was only ever for
      // the person typing.
      out += `@${String(child.attrs.handle || "")} `;
      return;
    }
    if (!child.isText) {
      out += child.textContent;
      return;
    }
    let text = child.text || "";
    if (!text) return;
    const marks = child.marks.map((mark) => mark.type.name);
    // Code spans are literal: Markdown emphasis does not nest inside them.
    if (marks.includes("code")) {
      out += `\`${text}\``;
      return;
    }
    if (marks.includes("bold")) text = `**${text}**`;
    if (marks.includes("italic")) text = `*${text}*`;
    if (marks.includes("strike")) text = `~~${text}~~`;
    const link = child.marks.find((mark) => mark.type.name === "link");
    if (link?.attrs.href) text = `[${text}](${String(link.attrs.href)})`;
    out += text;
  });
  return out;
}

function serializeBlock(node: ProseMirrorNode, indent = ""): string[] {
  switch (node.type.name) {
    case "paragraph":
      return serializeInline(node)
        .split("\n")
        .map((line) => `${indent}${line}`);
    case "codeBlock": {
      const language = typeof node.attrs.language === "string" ? node.attrs.language : "";
      return [
        `${indent}\`\`\`${language}`,
        ...node.textContent.split("\n").map((line) => `${indent}${line}`),
        `${indent}\`\`\``,
      ];
    }
    case "blockquote": {
      const lines: string[] = [];
      node.forEach((child) => lines.push(...serializeBlock(child, indent)));
      return lines.map((line) => `${indent}> ${line.slice(indent.length)}`);
    }
    case "bulletList":
    case "orderedList": {
      const ordered = node.type.name === "orderedList";
      const start = ordered && typeof node.attrs.start === "number" ? node.attrs.start : 1;
      const lines: string[] = [];
      node.forEach((item, _offset, index) => {
        const marker = ordered ? `${start + index}. ` : "- ";
        const itemLines: string[] = [];
        item.forEach((child) => itemLines.push(...serializeBlock(child, "")));
        itemLines.forEach((line, lineIndex) => {
          lines.push(
            lineIndex === 0
              ? `${indent}${marker}${line}`
              : `${indent}${" ".repeat(marker.length)}${line}`,
          );
        });
      });
      return lines;
    }
    default: {
      if (node.isTextblock) {
        return serializeInline(node)
          .split("\n")
          .map((line) => `${indent}${line}`);
      }
      const lines: string[] = [];
      node.forEach((child) => lines.push(...serializeBlock(child, indent)));
      return lines;
    }
  }
}

function serializeDocument(editor: Editor | null): string {
  if (!editor) return "";
  const blocks: string[] = [];
  editor.state.doc.forEach((node) => {
    blocks.push(serializeBlock(node).join("\n"));
  });
  // Blank paragraphs are the user's own spacing; collapse only trailing ones.
  return blocks.join("\n").replace(/\n+$/, "");
}

interface SendMessageStorage {
  onSend: (text: string) => boolean | void | Promise<boolean | void>;
  onPasteFiles: (files: File[]) => void;
  placeholder: string;
}

const DEFAULT_PLACEHOLDER = "Write a message...";

function sendStorage(editor: Editor): SendMessageStorage {
  // Tiptap types `editor.storage` from global extension augmentation, which a
  // locally declared extension does not participate in.
  return (editor.storage as unknown as Record<string, SendMessageStorage>)
    .sendMessage;
}

function sendCurrentDocument(editor: Editor) {
  if (editor.view.composing) return false;
  const markdown = serializeDocument(editor);
  if (!markdown.trim()) return true;
  void Promise.resolve(sendStorage(editor).onSend(markdown))
    .then((sent) => {
      if (sent !== false) editor.commands.clearContent(true);
    })
    .catch(() => {
      // The parent owns delivery feedback. Keep the editor content when
      // an asynchronous send handler rejects instead of losing the draft.
    });
  return true;
}

/**
 * Holds the live send handler and placeholder in editor storage rather than in
 * component refs: the editor instance outlives every render, so the props it
 * needs are pushed into it from an effect instead of read during render.
 */
const SendMessageExtension = Extension.create<
  Record<string, never>,
  SendMessageStorage
>({
  name: "sendMessage",
  addStorage(): SendMessageStorage {
    return {
      onPasteFiles: () => undefined,
      onSend: () => undefined,
      placeholder: DEFAULT_PLACEHOLDER,
    };
  },
  addProseMirrorPlugins() {
    const { editor } = this;
    return [
      new Plugin({
        key: new PluginKey("teammateAttachmentPaste"),
        props: {
          handlePaste: (_view, event) => {
            const files = Array.from(event.clipboardData?.files || []);
            if (files.length === 0) return false;
            sendStorage(editor).onPasteFiles(files);
            return true;
          },
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        // Inside a code block or a list, Enter is structural: it opens the
        // next line or the next item. Everywhere else it sends.
        if (editor.isActive("codeBlock") || editor.isActive("listItem")) {
          return false;
        }
        return sendCurrentDocument(editor);
      },
      "Mod-Enter": ({ editor }) => sendCurrentDocument(editor),
    };
  },
});

function textDocument(content: string) {
  return {
    type: "doc",
    content: content.split("\n").map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    })),
  };
}

const FORMATTING_CONTROLS: Array<{
  action: FormattingAction;
  fallbackLabel: string;
  Icon: typeof BoldIcon;
  separatorBefore?: boolean;
}> = [
  { action: "bold", fallbackLabel: "Bold", Icon: BoldIcon },
  { action: "italic", fallbackLabel: "Italic", Icon: ItalicIcon },
  { action: "strike", fallbackLabel: "Strikethrough", Icon: StrikethroughIcon },
  {
    action: "orderedList",
    fallbackLabel: "Ordered list",
    Icon: ListOrderedIcon,
    separatorBefore: true,
  },
  { action: "bulletList", fallbackLabel: "Bulleted list", Icon: ListIcon },
  {
    action: "blockquote",
    fallbackLabel: "Blockquote",
    Icon: TextQuoteIcon,
    separatorBefore: true,
  },
  { action: "code", fallbackLabel: "Code", Icon: CodeIcon },
  { action: "codeBlock", fallbackLabel: "Code block", Icon: SquareCodeIcon },
];

function runFormatting(editor: Editor, action: FormattingAction) {
  const chain = editor.chain().focus();
  switch (action) {
    case "bold":
      return chain.toggleBold().run();
    case "italic":
      return chain.toggleItalic().run();
    case "strike":
      return chain.toggleStrike().run();
    case "orderedList":
      return chain.toggleOrderedList().run();
    case "bulletList":
      return chain.toggleBulletList().run();
    case "blockquote":
      return chain.toggleBlockquote().run();
    case "code":
      return chain.toggleCode().run();
    case "codeBlock":
      return chain.toggleCodeBlock().run();
  }
}

function FormattingToolbar({
  editor,
  disabled,
  labels,
}: {
  editor: Editor;
  disabled?: boolean;
  labels?: Partial<Record<FormattingAction, string>>;
}): React.ReactElement {
  return (
    <div
      aria-label={labels?.bold ? undefined : "Formatting"}
      className="flex flex-wrap items-center gap-0.5 border-b px-2 py-1"
      role="toolbar">
      {FORMATTING_CONTROLS.map(({ action, fallbackLabel, Icon, separatorBefore }) => (
        <div className="contents" key={action}>
          {separatorBefore && (
            <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
          )}
          <Toggle
            aria-label={labels?.[action] || fallbackLabel}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onPressedChange={() => runFormatting(editor, action)}
            pressed={editor.isActive(action)}
            size="sm"
            title={labels?.[action] || fallbackLabel}>
            <Icon />
          </Toggle>
        </div>
      ))}
    </div>
  );
}

const TiptapMessageInput = forwardRef<
  TiptapMessageInputHandle,
  TiptapMessageInputProps
>(function TiptapMessageInput(
  {
    placeholder,
    ariaLabel,
    ariaControls,
    ariaExpanded,
    ariaActiveDescendant,
    disabled,
    initialContent = "",
    showFormatting = false,
    formattingLabels,
    onSend,
    onTextUpdate,
    onSelectionUpdate,
    onKeyDown,
    onPasteFiles,
  },
  ref
) {
  // Formatting buttons reflect the caret, which moves without changing content.
  const [, refreshToolbar] = useReducer((count: number) => count + 1, 0);

  const editor = useEditor({
    content: textDocument(initialContent),
    extensions: [
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        dropcursor: false,
        gapcursor: false,
        link: false,
      }),
      Link.configure({
        autolink: true,
        linkOnPaste: true,
        openOnClick: false,
      }),
      Placeholder.configure({
        placeholder: ({ editor: ed }) => sendStorage(ed).placeholder,
      }),
      MentionNode,
      SendMessageExtension,
    ],
    editorProps: {
      attributes: {
        "aria-label": ariaLabel || placeholder || "Write a message",
        "aria-multiline": "true",
        class: "focus:outline-none",
        role: "textbox",
      },
      handleKeyDown: (_view, event) => {
        if (onKeyDown) {
          const handled = onKeyDown(event);
          if (handled) return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const { from } = ed.state.selection;
      const $from = ed.state.doc.resolve(from);
      const textBeforeCursor = $from.parent.textBetween(
        0,
        $from.parentOffset
      );
      onTextUpdate?.(textBeforeCursor, ed.getText({ blockSeparator: "\n" }));
      onSelectionUpdate?.(textBeforeCursor);
      refreshToolbar();
    },
    onSelectionUpdate: ({ editor: ed }) => {
      refreshToolbar();
      if (onSelectionUpdate) {
        const { from } = ed.state.selection;
        const $from = ed.state.doc.resolve(from);
        const textBeforeCursor = $from.parent.textBetween(
          0,
          $from.parentOffset
        );
        onSelectionUpdate(textBeforeCursor);
      }
    },
    immediatelyRender: false,
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
    if (disabled) editor.view.dom.setAttribute("aria-disabled", "true");
    else editor.view.dom.removeAttribute("aria-disabled");
  }, [editor, disabled]);

  useEffect(() => {
    if (!editor) return;
    sendStorage(editor).onSend = onSend;
  }, [editor, onSend]);

  useEffect(() => {
    if (!editor || !onPasteFiles) return;
    sendStorage(editor).onPasteFiles = onPasteFiles;
  }, [editor, onPasteFiles]);

  useEffect(() => {
    if (!editor) return;
    sendStorage(editor).placeholder = placeholder || DEFAULT_PLACEHOLDER;
    editor.view.dom.setAttribute(
      "aria-label",
      ariaLabel || placeholder || "Write a message",
    );
    // Placeholder decorations read from storage, so recompute them without
    // recreating the editor or discarding an in-progress draft.
    editor.view.updateState(editor.state);
  }, [ariaLabel, editor, placeholder]);

  useEffect(() => {
    if (!editor) return;
    const editorElement = editor.view.dom;
    if (ariaControls) editorElement.setAttribute("aria-controls", ariaControls);
    else editorElement.removeAttribute("aria-controls");
    if (ariaExpanded !== undefined) {
      editorElement.setAttribute("aria-expanded", String(ariaExpanded));
    } else {
      editorElement.removeAttribute("aria-expanded");
    }
    if (ariaActiveDescendant) {
      editorElement.setAttribute("aria-activedescendant", ariaActiveDescendant);
    } else {
      editorElement.removeAttribute("aria-activedescendant");
    }
  }, [ariaActiveDescendant, ariaControls, ariaExpanded, editor]);

  useImperativeHandle(ref, () => ({
    focus: () => editor?.commands.focus(),
    clear: () => editor?.commands.clearContent(true),
    getMarkdown: () => serializeDocument(editor),
    insertText: (text: string) => {
      editor?.chain().focus().insertContent(text).run();
    },
    replaceMention: (query: string, replacement: string, trigger = "@") => {
      if (!editor) return;
      const { from } = editor.state.selection;
      const $from = editor.state.doc.resolve(from);
      const textBefore = $from.parent.textBetween(0, $from.parentOffset);
      const searchStr = `${trigger}${query}`;
      const idx = textBefore.lastIndexOf(searchStr);
      if (idx === -1) return;
      const start = $from.start() + idx;
      const end = start + searchStr.length;
      editor
        .chain()
        .deleteRange({ from: start, to: end })
        .insertContent(replacement)
        .run();
    },
    insertMention: (query: string, handle: string, label: string) => {
      if (!editor) return;
      const { from } = editor.state.selection;
      const $from = editor.state.doc.resolve(from);
      const textBefore = $from.parent.textBetween(0, $from.parentOffset);
      const typed = `@${query}`;
      const idx = textBefore.lastIndexOf(typed);
      if (idx === -1) return;
      const start = $from.start() + idx;
      editor
        .chain()
        .deleteRange({ from: start, to: start + typed.length })
        .insertMention({ handle, label })
        .run();
    },
  }));

  return (
    <div className="tiptap-input">
      {showFormatting && editor && (
        <FormattingToolbar
          disabled={disabled}
          editor={editor}
          labels={formattingLabels}
        />
      )}
      {/* Matches the transcript's metrics so a draft looks like the message
          it becomes. */}
      <div className="px-4 pt-3 pb-1 text-[15px] leading-[22px]">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
});

export default TiptapMessageInput;
