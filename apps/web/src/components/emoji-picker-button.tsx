'use client';

import { lazy, Suspense, useState } from 'react';
import { SmileIcon } from 'lucide-react';
import type { TranslationKey } from '@/hooks/use-app-settings';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';

const EmojiPicker = lazy(() =>
  import('@/components/emoji-picker').then((module) => ({ default: module.EmojiPicker })),
);

export function EmojiPickerButton({
  label,
  onPick,
  t,
}: {
  label: string;
  onPick: (emoji: string) => void;
  t: (key: TranslationKey) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-label={label}
        className="flex size-7 items-center justify-center rounded-lg text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
        title={label}
      >
        <SmileIcon className="size-4 opacity-80" />
      </PopoverTrigger>
      <PopoverPopup align="start" padded={false} side="top">
        <Suspense fallback={<div className="h-80 w-[332px]" />}>
          <EmojiPicker
            onPick={(emoji) => {
              setOpen(false);
              onPick(emoji);
            }}
            t={t}
          />
        </Suspense>
      </PopoverPopup>
    </Popover>
  );
}
