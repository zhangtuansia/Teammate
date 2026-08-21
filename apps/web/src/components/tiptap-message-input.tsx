"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Extension } from "@tiptap/core";
import { forwardRef, useImperativeHandle, useEffect, useRef } from "react";

export interface TiptapMessageInputHandle {
  focus: () => void;
  clear: () => void;
  getMarkdown: () => string;
  /** Replace @query text near cursor with replacement string */
  replaceMention: (query: string, replacement: string) => void;
}

interface TiptapMessageInputProps {
  placeholder?: string;
  ariaLabel?: string;
  ariaControls?: string;
  ariaExpanded?: boolean;
  ariaActiveDescendant?: string;
  disabled?: boolean;
  initialContent?: string;
  /** Called when user presses Enter on non-empty content */
  onSend: (text: string) => boolean | void | Promise<boolean | void>;
  /** Called on every content change */
  onTextUpdate?: (textBeforeCursor: string, fullText: string) => void;
  /** Called when only the cursor selection changes. */
  onSelectionUpdate?: (textBeforeCursor: string) => void;
  /** Intercept keys before Tiptap. Return true to consume (for @mention nav). */
  onKeyDown?: (event: KeyboardEvent) => boolean;
}

function createSendOnEnterExtension(
  onSendRef: React.RefObject<
    (text: string) => boolean | void | Promise<boolean | void>
  >
) {
  return Extension.create({
    name: "sendOnEnter",
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor }) => {
          if (editor.view.composing) return false;
          const text = editor.getText({ blockSeparator: "\n" });
          if (!text.trim()) return true;
          void Promise.resolve(onSendRef.current(text))
            .then((sent) => {
              if (sent !== false) editor.commands.clearContent(true);
            })
            .catch(() => {
              // The parent owns delivery feedback. Keep the editor content when
              // an asynchronous send handler rejects instead of losing the draft.
            });
          return true;
        },
      };
    },
  });
}

function textDocument(content: string) {
  return {
    type: "doc",
    content: content.split("\n").map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    })),
  };
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
    onSend,
    onTextUpdate,
    onSelectionUpdate,
    onKeyDown,
  },
  ref
) {
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const placeholderRef = useRef(placeholder || "Write a message...");
  placeholderRef.current = placeholder || "Write a message...";

  const editor = useEditor({
    content: textDocument(initialContent),
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        codeBlock: false,
        horizontalRule: false,
        dropcursor: false,
        gapcursor: false,
      }),
      Placeholder.configure({
        placeholder: () => placeholderRef.current,
      }),
      createSendOnEnterExtension(onSendRef),
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
    },
    onSelectionUpdate: ({ editor: ed }) => {
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
    editor.view.dom.setAttribute(
      "aria-label",
      ariaLabel || placeholder || "Write a message",
    );
    // Placeholder decorations read through the ref, so recompute them without
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
    getMarkdown: () => editor?.getText({ blockSeparator: "\n" }) ?? "",
    replaceMention: (query: string, replacement: string) => {
      if (!editor) return;
      const { from } = editor.state.selection;
      const $from = editor.state.doc.resolve(from);
      const textBefore = $from.parent.textBetween(0, $from.parentOffset);
      const searchStr = `@${query}`;
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
  }));

  return (
    <div className="tiptap-input">
      <EditorContent editor={editor} />
    </div>
  );
});

export default TiptapMessageInput;
