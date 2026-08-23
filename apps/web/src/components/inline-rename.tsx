"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Renaming happens in the row, not in a dialog. A prompt box tears you out of
 * the page to ask one question and gives back nothing you could not have typed
 * where the name already was — and it cannot show you the row you are renaming
 * while it is open.
 *
 * Enter and clicking away both commit, since both mean "done". Escape abandons.
 * The name arrives selected, because the common case is replacing it.
 */
export function InlineRename({
  className,
  onCancel,
  onCommit,
  style,
  value,
}: {
  className?: string;
  onCancel: () => void;
  onCommit: (next: string) => void;
  style?: React.CSSProperties;
  value: string;
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  // Committing on blur means the commit can fire twice — once from Enter, once
  // from the blur Enter causes.
  const settled = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    const next = draft.trim();
    if (!next || next === value) onCancel();
    else onCommit(next);
  };

  const cancel = () => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  };

  return (
    <input
      className={className}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      // The row underneath is a button, and a click in the field would reach it.
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
        // Arrow keys and the like belong to the field while it is open.
        event.stopPropagation();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      ref={inputRef}
      style={style}
      type="text"
      value={draft}
    />
  );
}
