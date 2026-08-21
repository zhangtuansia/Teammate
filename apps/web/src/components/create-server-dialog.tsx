"use client";

import { useState, useEffect, useRef } from "react";
import { apiUrl } from "@/lib/api-url";
import { useAppSettings } from "@/hooks/use-app-settings";
import { useWorkspaceNavigation } from "@/hooks/use-navigation-guard";
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
import {
  isValidWorkspaceSlug,
  normalizeWorkspaceSlug,
  workspaceSlugFromName,
} from "@/lib/workspace-slug";

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
  const creatingRef = useRef(false);
  const requestControllerRef = useRef<AbortController | null>(null);
  const { t } = useAppSettings();
  const { navigate } = useWorkspaceNavigation();
  const normalizedSlug = slug.trim();
  const slugValid = isValidWorkspaceSlug(normalizedSlug);

  useEffect(() => {
    if (open) {
      const frame = window.requestAnimationFrame(() => {
        setName("");
        setSlug("");
        setSlugTouched(false);
        setDescription("");
        setError("");
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [open]);

  useEffect(() => () => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    creatingRef.current = false;
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (creatingRef.current) return;
    if (!name.trim()) return;
    if (!slug.trim()) {
      setError(t("createWorkspace.slugRequired"));
      return;
    }
    if (!slugValid) {
      setError(t("createWorkspace.slugInvalid"));
      return;
    }

    creatingRef.current = true;
    setCreating(true);
    setError("");
    const requestController = new AbortController();
    requestControllerRef.current = requestController;
    const requestTimeout = window.setTimeout(() => requestController.abort(), 15_000);

    try {
      const res = await fetch(apiUrl("/api/servers"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: requestController.signal,
        body: JSON.stringify({
          name: name.trim(),
          slug: normalizedSlug,
          description: description.trim() || null,
        }),
      });

      const data = (await res.json().catch(() => null)) as {
        server?: { slug?: unknown };
        error?: unknown;
      } | null;
      if (!res.ok) {
        if (res.status === 409) {
          throw new Error(t("createWorkspace.slugInUse"));
        }
        throw new Error(
          typeof data?.error === "string"
            ? data.error
            : t("createWorkspace.failed"),
        );
      }
      if (typeof data?.server?.slug !== "string") {
        throw new Error(t("createWorkspace.invalidResponse"));
      }

      onClose();
      navigate(`/s/${data.server.slug}`);
    } catch (err) {
      setError(
        err instanceof DOMException && err.name === "AbortError"
          ? t("createWorkspace.failed")
          : err instanceof Error
            ? err.message
            : t("createWorkspace.failed"),
      );
    } finally {
      window.clearTimeout(requestTimeout);
      if (requestControllerRef.current === requestController) {
        requestControllerRef.current = null;
      }
      creatingRef.current = false;
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !creating) onClose(); }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("createWorkspace.title")}</DialogTitle>
          <DialogDescription>{t("createWorkspace.description")}</DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogPanel>
            <div className="space-y-4">
              <Field>
                <FieldLabel>{t("createWorkspace.name")}</FieldLabel>
                <Input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    const val = (e.target as HTMLInputElement).value;
                    setName(val);
                    setError("");
                    if (!slugTouched) {
                      setSlug(workspaceSlugFromName(val));
                    }
                  }}
                  placeholder={t("createWorkspace.namePlaceholder")}
                  maxLength={80}
                  required
                  autoFocus
                />
              </Field>

              <Field>
                <FieldLabel>{t("createWorkspace.slug")}</FieldLabel>
                <div className="flex items-center gap-0 rounded-lg border border-input bg-background shadow-xs/5 transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
                  <span className="pl-3 text-sm text-muted-foreground select-none">/s/</span>
                  <input
                    aria-label={t("createWorkspace.slug")}
                    aria-invalid={slugTouched && !slugValid}
                    value={slug}
                    onChange={(e) => {
                      setSlugTouched(true);
                      setError("");
                      setSlug(normalizeWorkspaceSlug(e.target.value));
                    }}
                    placeholder={t("createWorkspace.slugPlaceholder")}
                    maxLength={64}
                    className="flex-1 bg-transparent px-1 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                  />
                </div>
                <FieldDescription className={slugTouched && !slugValid ? "text-destructive" : undefined}>
                  {t(slugTouched && !slugValid ? "createWorkspace.slugInvalid" : "createWorkspace.slugHint")}
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel>
                  {t("createWorkspace.descriptionField")} <span className="text-muted-foreground font-normal">({t("createWorkspace.optional")})</span>
                </FieldLabel>
                <Input
                  type="text"
                  value={description}
                  onChange={(e) => {
                    setDescription((e.target as HTMLInputElement).value);
                    setError("");
                  }}
                  placeholder={t("createWorkspace.descriptionPlaceholder")}
                  maxLength={500}
                />
              </Field>

              {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" disabled={creating} />}>
              {t("createWorkspace.cancel")}
            </DialogClose>
            <Button type="submit" loading={creating} disabled={!name.trim() || !slugValid}>
              {t("createWorkspace.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
