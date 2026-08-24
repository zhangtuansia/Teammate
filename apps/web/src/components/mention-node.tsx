"use client";

import { Node, mergeAttributes } from "@tiptap/core";

/**
 * A mention in the composer.
 *
 * The message body has to carry the handle — that is what routes a delivery and
 * what the runtime matches against — but a handle is not always something a
 * person can read. A teammate called 产品经理 gets `@agent-19647d87`, because
 * the display name does not transliterate, and typing their name should not put
 * an id in front of you.
 *
 * So the two are separated: the node holds both, shows the label, and serialises
 * to `@handle`. The stored message is byte-for-byte what it was before this
 * existed, so nothing downstream has to learn anything new.
 */
export interface MentionAttributes {
  handle: string;
  label: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mention: {
      insertMention: (attributes: MentionAttributes) => ReturnType;
    };
  }
}

export const MentionNode = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  // One thing, selected and deleted as a whole: a mention with half its handle
  // left behind would route nowhere.
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      handle: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-handle"),
        renderHTML: (attributes) => ({ "data-handle": attributes.handle }),
      },
      label: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-label"),
        renderHTML: (attributes) => ({ "data-label": attributes.label }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-mention]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const label = String(node.attrs.label || node.attrs.handle || "");
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-mention": "",
        // The same chip the transcript uses, so a draft looks like the message
        // it becomes.
        class: "rounded-[3px] bg-primary/10 px-[2px] py-px text-primary",
        title: `@${String(node.attrs.handle || "")}`,
      }),
      `@${label}`,
    ];
  },

  renderText({ node }) {
    // What lands in the message. Only ever the handle.
    return `@${String(node.attrs.handle || "")}`;
  },

  addCommands() {
    return {
      insertMention:
        (attributes: MentionAttributes) =>
        ({ chain }) =>
          chain()
            .focus()
            .insertContent([
              { attrs: attributes, type: this.name },
              { text: " ", type: "text" },
            ])
            .run(),
    };
  },
});
