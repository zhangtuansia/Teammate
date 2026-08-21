"use client";

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import type { ReactNode } from "react";
import { MenuItem, MenuPopup } from "@/components/ui/menu";
import { cn } from "@/lib/utils";

interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  children: ReactNode;
  className?: string;
  items: MenuItem[];
}

export function ContextMenu({ children, className, items }: ContextMenuProps) {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger className={className}>
        {children}
      </ContextMenuPrimitive.Trigger>
      <MenuPopup align="start" className="min-w-40" sideOffset={2}>
        {items.map((item) => (
          <MenuItem
            key={item.label}
            className={cn(
              item.danger &&
                "text-destructive-foreground data-highlighted:bg-destructive/8 data-highlighted:text-destructive-foreground",
            )}
            onClick={item.onClick}
          >
            {item.icon}
            <span>{item.label}</span>
          </MenuItem>
        ))}
      </MenuPopup>
    </ContextMenuPrimitive.Root>
  );
}
