'use client';

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useAppSettings } from '@/hooks/use-app-settings';

function messageExcerpt(content: string) {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 180 ? `${compact.slice(0, 180)}…` : compact;
}

export function MessageDeleteDialog({
  content,
  onConfirm,
  onOpenChange,
  open,
}: {
  content: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { t } = useAppSettings();
  const excerpt = messageExcerpt(content);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('message.deleteTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('message.deleteConfirm')}</AlertDialogDescription>
          {excerpt && (
            <blockquote className="line-clamp-3 rounded-lg border bg-muted/50 px-3 py-2 text-sm leading-relaxed text-foreground">
              {excerpt}
            </blockquote>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {t('message.delete')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
