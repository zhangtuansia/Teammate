"use client";

import { useEffect, useState, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export interface ThinkingIndicatorProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  detail?: string;
  showElapsed?: boolean;
}

/**
 * Compact agent activity feedback. `detail` carries whatever the runtime is
 * currently doing — a tool target, a query, or the model's reasoning summary —
 * as a single truncated line, so a long turn shows progress instead of a
 * frozen label. It is live status, not transcript: nothing here is persisted.
 */
export function ThinkingIndicator({
  className,
  label,
  detail,
  showElapsed = true,
  ...props
}: ThinkingIndicatorProps): React.ReactElement {
  const [elapsed, setElapsed] = useState(0);
  const [startedAt] = useState(() => Date.now());

  useEffect(() => {
    if (!showElapsed) return;

    let interval: number | null = null;
    const updateElapsed = () => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    };
    const stopTimer = () => {
      if (interval === null) return;
      window.clearInterval(interval);
      interval = null;
    };
    const startTimer = () => {
      stopTimer();
      updateElapsed();
      interval = window.setInterval(updateElapsed, 1000);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") startTimer();
      else stopTimer();
    };

    handleVisibilityChange();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [showElapsed, startedAt]);

  return (
    <div
      aria-atomic="true"
      aria-live="polite"
      className={cn(
        "flex min-w-0 items-center gap-2 text-xs text-muted-foreground",
        className,
      )}
      role="status"
      {...props}
    >
      <span className="sr-only">{detail ? `${label}: ${detail}` : label}</span>
      <svg
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
        fill="none"
        viewBox="0 0 24 24"
      >
        <path
          className="teammate-thinking-track"
          d="M12 12c2-3.6 4-5 6.1-5C20.8 7 22 9.2 22 12s-1.2 5-3.9 5c-2.1 0-4.1-1.4-6.1-5Zm0 0c-2-3.6-4-5-6.1-5C3.2 7 2 9.2 2 12s1.2 5 3.9 5c2.1 0 4.1-1.4 6.1-5Z"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
        <path
          className="teammate-thinking-pulse"
          d="M12 12c2-3.6 4-5 6.1-5C20.8 7 22 9.2 22 12s-1.2 5-3.9 5c-2.1 0-4.1-1.4-6.1-5Zm0 0c-2-3.6-4-5-6.1-5C3.2 7 2 9.2 2 12s1.2 5 3.9 5c2.1 0 4.1-1.4 6.1-5Z"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      </svg>
      <span
        aria-hidden="true"
        key={label}
        className="animate-response-label teammate-thinking-label shrink-0 font-medium"
      >
        {label}
      </span>
      {detail && <span aria-hidden="true" className="min-w-0 truncate">{detail}</span>}
      {showElapsed && (
        <span
          aria-hidden="true"
          className="min-w-[4ch] shrink-0 text-right tabular-nums text-muted-foreground/60"
        >
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  );
}
