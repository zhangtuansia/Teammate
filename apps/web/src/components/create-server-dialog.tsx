"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";

interface CreateServerDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateServerDialog({ open, onClose }: CreateServerDialogProps) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  useEffect(() => {
    if (open) {
      setName("");
      setSlug("");
      setSlugTouched(false);
      setDescription("");
      setError("");
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    setCreating(true);
    setError("");

    try {
      const res = await fetch("/api/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim() || undefined,
          description: description.trim() || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create workspace");
      }

      const { server } = await res.json();
      onClose();
      router.push(`/s/${server.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Create Workspace</DialogTitle>
          <DialogDescription>Set up a new workspace for your team and agents.</DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogPanel>
            <div className="space-y-4">
              <Field>
                <FieldLabel>Workspace Name</FieldLabel>
                <Input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    const val = (e.target as HTMLInputElement).value;
                    setName(val);
                    if (!slugTouched) {
                      setSlug(
                        val
                          .trim()
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, "-")
                          .replace(/^-|-$/g, "")
                      );
                    }
                  }}
                  placeholder="e.g. My Workspace, Acme Inc..."
                  required
                  autoFocus
                />
              </Field>

              <Field>
                <FieldLabel>URL Slug</FieldLabel>
                <div className="flex items-center gap-0 rounded-lg border border-input bg-background shadow-xs/5 transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
                  <span className="pl-3 text-sm text-muted-foreground select-none">/s/</span>
                  <input
                    value={slug}
                    onChange={(e) => {
                      setSlugTouched(true);
                      setSlug(
                        e.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9-]/g, "")
                      );
                    }}
                    placeholder="my-workspace"
                    className="flex-1 bg-transparent px-1 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                  />
                </div>
                <FieldDescription>
                  Use lowercase letters, numbers, and hyphens.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel>
                  Description <span className="text-muted-foreground font-normal">(optional)</span>
                </FieldLabel>
                <Input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription((e.target as HTMLInputElement).value)}
                  placeholder="What's this workspace for?"
                />
              </Field>

              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>
              Cancel
            </DialogClose>
            <Button type="submit" loading={creating} disabled={!name.trim()}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
