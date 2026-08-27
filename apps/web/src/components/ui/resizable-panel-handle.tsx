'use client';

import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';

interface ResizablePanelHandleProps {
  ariaLabel: string;
  defaultValue: number;
  max: number;
  min: number;
  onResize: (value: number) => void;
  onResizeEnd: (value: number) => void;
  value: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * The shared leading-edge handle for right-side auxiliary panels.
 *
 * Pointer movement previews the width at animation-frame cadence; release,
 * keyboard movement, and double-click are the moments the owner persists it.
 * Keeping pointer capture and body cleanup here prevents every panel from
 * implementing subtly different drag and cancellation behavior.
 */
export function ResizablePanelHandle({
  ariaLabel,
  defaultValue,
  max,
  min,
  onResize,
  onResizeEnd,
  value,
}: ResizablePanelHandleProps) {
  const frameRef = useRef<number | null>(null);
  const resizeRef = useRef<{
    pendingValue: number;
    pointerId: number;
    previousCursor: string;
    previousSelection: string;
    startValue: number;
    startX: number;
  } | null>(null);

  const preview = (nextValue: number) => {
    const bounded = clamp(nextValue, min, max);
    onResize(bounded);
    return bounded;
  };

  const commit = (nextValue: number) => {
    const bounded = preview(nextValue);
    onResizeEnd(bounded);
  };

  const finish = (
    event: ReactPointerEvent<HTMLDivElement>,
    usePointerPosition: boolean,
  ) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const nextValue = usePointerPosition
      ? resize.startValue + resize.startX - event.clientX
      : resize.pendingValue;
    resizeRef.current = null;
    commit(nextValue);
    document.body.style.cursor = resize.previousCursor;
    document.body.style.userSelect = resize.previousSelection;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    const resize = resizeRef.current;
    if (resize) {
      document.body.style.cursor = resize.previousCursor;
      document.body.style.userSelect = resize.previousSelection;
    }
  }, []);

  return (
    <div
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={value}
      className="group/panel-resize absolute inset-y-0 -left-1 z-20 hidden w-2 cursor-col-resize touch-none outline-none xl:block"
      onDoubleClick={() => commit(defaultValue)}
      onKeyDown={(event) => {
        if (event.key === 'Home') {
          event.preventDefault();
          commit(min);
          return;
        }
        if (event.key === 'End') {
          event.preventDefault();
          commit(max);
          return;
        }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        commit(value + (event.key === 'ArrowLeft' ? 16 : -16));
      }}
      onPointerCancel={(event) => finish(event, false)}
      onPointerDown={(event) => {
        if (resizeRef.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        resizeRef.current = {
          pendingValue: value,
          pointerId: event.pointerId,
          previousCursor: document.body.style.cursor,
          previousSelection: document.body.style.userSelect,
          startValue: value,
          startX: event.clientX,
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }}
      onPointerMove={(event) => {
        const resize = resizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        resize.pendingValue = resize.startValue + resize.startX - event.clientX;
        if (frameRef.current !== null) return;
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          const activeResize = resizeRef.current;
          if (activeResize) preview(activeResize.pendingValue);
        });
      }}
      onPointerUp={(event) => finish(event, true)}
      role="separator"
      tabIndex={0}
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover/panel-resize:bg-primary/45 group-focus/panel-resize:bg-primary/45" />
    </div>
  );
}
