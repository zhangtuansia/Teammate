"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardHeader, CardTitle, CardDescription, CardPanel, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import {
  isValidWorkspaceSlug,
  normalizeWorkspaceSlug,
  workspaceSlugFromName,
} from "@/lib/workspace-slug";
import { RequestDeadlineError, withRequestDeadline } from "@/lib/request-deadline";

export default function OnboardingPage() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const [checkError, setCheckError] = useState("");
  const [checkAttempt, setCheckAttempt] = useState(0);
  const router = useRouter();
  const mountedRef = useRef(true);
  const creatingRef = useRef(false);
  const createControllerRef = useRef<AbortController | null>(null);
  const checkGenerationRef = useRef(0);
  const normalizedSlug = slug.trim();
  const slugValid = isValidWorkspaceSlug(normalizedSlug);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      createControllerRef.current?.abort();
      createControllerRef.current = null;
      creatingRef.current = false;
    };
  }, []);

  useEffect(() => {
    const generation = ++checkGenerationRef.current;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    const isCurrent = () =>
      !cancelled &&
      !controller.signal.aborted &&
      checkGenerationRef.current === generation;

    async function check() {
      try {
        const supabase = createClient();
        const authRequest = supabase.auth.getUser();
        const authResult = await withRequestDeadline<Awaited<typeof authRequest>>(
          authRequest,
          10_000,
        );
        if (!isCurrent()) return;
        const user = authResult.data.user;

        if (
          !user &&
          authResult.error &&
          /auth session missing/i.test(authResult.error.message)
        ) {
          router.replace("/login");
          return;
        }
        if (authResult.error) throw authResult.error;

        if (!user) {
          router.replace("/login");
          return;
        }

        const membershipResult = await supabase
          .from("server_members")
          .select("server_id")
          .eq("member_id", user.id)
          .eq("member_type", "human")
          .limit(1)
          .abortSignal(controller.signal);
        if (!isCurrent()) return;
        if (membershipResult.error) throw membershipResult.error;

        const membership = membershipResult.data?.[0];
        if (membership) {
          const serverResult = await supabase
            .from("servers")
            .select("slug")
            .eq("id", membership.server_id)
            .maybeSingle()
            .abortSignal(controller.signal);
          if (!isCurrent()) return;
          if (serverResult.error) throw serverResult.error;
          if (serverResult.data?.slug) {
            router.replace(`/s/${serverResult.data.slug}`);
            return;
          }
        }

        setCheckError("");
        setChecking(false);
      } catch (loadError) {
        if (cancelled || checkGenerationRef.current !== generation) return;
        setCheckError(
          loadError instanceof RequestDeadlineError ||
          (loadError instanceof DOMException && loadError.name === "AbortError")
            ? "Workspace lookup timed out. Check your connection and try again."
            : loadError instanceof TypeError
              ? "Could not reach Teammate. Check your connection and try again."
            : loadError instanceof Error
              ? loadError.message
              : "Could not check your workspaces.",
        );
        setChecking(false);
      }
    }

    void check();
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [checkAttempt, router]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (creatingRef.current || !name.trim() || !slugValid) return;

    creatingRef.current = true;
    setCreating(true);
    setError("");
    const controller = new AbortController();
    createControllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch("/api/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          name: name.trim(),
          slug: normalizedSlug,
          description: description.trim() || null,
        }),
      });

      const data = (await res.json().catch(() => null)) as {
        server?: { slug?: unknown };
        apiKey?: unknown;
        error?: unknown;
      } | null;
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : "Failed to create workspace",
        );
      }
      if (typeof data?.server?.slug !== "string") {
        throw new Error("The workspace was created, but its destination was missing.");
      }
      if (!mountedRef.current || createControllerRef.current !== controller) return;

      if (typeof data.apiKey === "string") {
        try {
          sessionStorage.setItem("teammate_setup_key", data.apiKey);
        } catch {
          // The one-time setup key is optional; storage restrictions must not strand the user.
        }
      }
      router.push(`/s/${data.server.slug}?setup=true`);
    } catch (err) {
      if (mountedRef.current && createControllerRef.current === controller) {
        setError(
          err instanceof DOMException && err.name === "AbortError"
            ? "Workspace creation timed out. Please try again."
            : err instanceof Error
              ? err.message
              : "Failed to create workspace",
        );
      }
    } finally {
      window.clearTimeout(timeout);
      if (createControllerRef.current === controller) {
        createControllerRef.current = null;
        creatingRef.current = false;
        if (mountedRef.current) setCreating(false);
      }
    }
  }

  if (checking) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Spinner className="size-4" aria-hidden="true" />
          Checking your workspaces…
        </div>
      </div>
    );
  }

  if (checkError) {
    return (
      <div className="flex h-full items-center justify-center bg-background px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Couldn&apos;t load your workspaces</CardTitle>
            <CardDescription>Teammate could not finish the account check.</CardDescription>
          </CardHeader>
          <CardPanel>
            <Alert variant="error">
              <AlertDescription>{checkError}</AlertDescription>
            </Alert>
          </CardPanel>
          <CardFooter>
            <Button
              className="w-full"
              onClick={() => {
                setChecking(true);
                setCheckError("");
                setCheckAttempt((value) => value + 1);
              }}
            >
              Try again
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="w-full max-w-md mx-4">
        <Card>
          <CardHeader className="text-center">
            <div className="flex h-12 w-12 mx-auto items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground mb-4">
              T
            </div>
            <CardTitle className="text-xl">Welcome to Teammate</CardTitle>
            <CardDescription>
              Create your first workspace to get started. A workspace is where
              your agents, channels, and conversations live.
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleCreate}>
            <CardPanel>
              <div className="space-y-4">
                <Field>
                  <FieldLabel>Workspace Name</FieldLabel>
                  <Input
                    type="text"
                    value={name}
                    disabled={creating}
                    onChange={(e) => {
                      const val = (e.target as HTMLInputElement).value;
                      setName(val);
                      setError("");
                      if (!slugTouched) {
                        setSlug(workspaceSlugFromName(val));
                      }
                    }}
                    placeholder="e.g. My Workspace, Acme Inc, Side Project..."
                    maxLength={100}
                    required
                    autoFocus
                  />
                </Field>

                <Field>
                  <FieldLabel>URL Slug</FieldLabel>
                  <div className="flex items-center gap-0 rounded-lg border border-input bg-background shadow-xs/5 transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
                    <span className="pl-3.5 text-sm text-muted-foreground select-none">/s/</span>
                    <input
                      aria-label="URL Slug"
                      aria-invalid={slugTouched && !slugValid}
                      value={slug}
                      disabled={creating}
                      onChange={(e) => {
                        setSlugTouched(true);
                        setError("");
                        setSlug(normalizeWorkspaceSlug(e.target.value));
                      }}
                      placeholder="my-workspace"
                      maxLength={64}
                      className="flex-1 bg-transparent px-1 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                    />
                  </div>
                  <FieldDescription className={slugTouched && !slugValid ? "text-destructive" : undefined}>
                    {slugTouched && !slugValid
                      ? "Use lowercase letters, numbers, and single hyphens."
                      : "This will be your workspace URL. Unicode names get a stable address automatically."}
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel>
                    Description <span className="text-muted-foreground font-normal">(optional)</span>
                  </FieldLabel>
                  <Input
                    type="text"
                    value={description}
                    disabled={creating}
                    onChange={(e) => {
                      setDescription((e.target as HTMLInputElement).value);
                      setError("");
                    }}
                    placeholder="What's this workspace for?"
                    maxLength={1000}
                  />
                </Field>

                {error && (
                  <Alert variant="error">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
              </div>
            </CardPanel>
            <CardFooter>
              <Button type="submit" loading={creating} disabled={!name.trim() || !slugValid} className="w-full">
                Create Workspace
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
    </div>
  );
}
