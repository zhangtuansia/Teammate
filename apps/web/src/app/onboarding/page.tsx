"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardHeader, CardTitle, CardDescription, CardPanel, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function OnboardingPage() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const router = useRouter();

  useEffect(() => {
    async function check() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push("/login");
        return;
      }

      const { data: memberships } = await supabase
        .from("server_members")
        .select("server_id")
        .eq("member_id", user.id)
        .eq("member_type", "human");

      if (memberships && memberships.length > 0) {
        const { data: server } = await supabase
          .from("servers")
          .select("slug")
          .eq("id", memberships[0].server_id)
          .single();

        if (server) {
          router.replace(`/s/${server.slug}`);
          return;
        }
      }

      setChecking(false);
    }

    check();
  }, [router]);

  async function handleCreate(e: React.FormEvent) {
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

      const { server, apiKey } = await res.json();
      // Store the auto-generated API key for the setup wizard
      if (apiKey) {
        sessionStorage.setItem("zano_setup_key", apiKey);
      }
      router.push(`/s/${server.slug}?setup=true`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace");
      setCreating(false);
    }
  }

  if (checking) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="w-full max-w-md mx-4">
        <Card>
          <CardHeader className="text-center">
            <div className="flex h-12 w-12 mx-auto items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground mb-4">
              Z
            </div>
            <CardTitle className="text-xl">Welcome to Zano</CardTitle>
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
                    placeholder="e.g. My Workspace, Acme Inc, Side Project..."
                    required
                    autoFocus
                  />
                </Field>

                <Field>
                  <FieldLabel>URL Slug</FieldLabel>
                  <div className="flex items-center gap-0 rounded-lg border border-input bg-background shadow-xs/5 transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
                    <span className="pl-3.5 text-sm text-muted-foreground select-none">/s/</span>
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
                      className="flex-1 bg-transparent px-1 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                    />
                  </div>
                  <FieldDescription>
                    This will be your workspace URL. Use lowercase letters, numbers, and hyphens.
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

                {error && (
                  <Alert variant="error">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
              </div>
            </CardPanel>
            <CardFooter>
              <Button type="submit" loading={creating} disabled={!name.trim()} className="w-full">
                Create Workspace
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
    </div>
  );
}
