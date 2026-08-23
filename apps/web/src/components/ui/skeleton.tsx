import type React from "react";
import { cn } from "@/lib/utils";

export function Skeleton({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "teammate-sweep rounded-sm bg-muted [--teammate-sweep-highlight:--alpha(var(--color-white)/64%)] dark:[--teammate-sweep-highlight:--alpha(var(--color-white)/4%)]",
        className,
      )}
      data-slot="skeleton"
      {...props}
    />
  );
}
