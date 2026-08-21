"use client";

import { useEffect, useRef, useState } from "react";
import { createAbortableClient } from "@/lib/supabase/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardDescription, CardPanel, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  isNetworkRequestError,
  RequestDeadlineError,
  withRequestDeadline,
} from "@/lib/request-deadline";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const mountedRef = useRef(true);
  const submittingRef = useRef(false);
  const submitGenerationRef = useRef(0);
  const submitControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      submittingRef.current = false;
      submitControllerRef.current?.abort();
      submitControllerRef.current = null;
    };
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current || !email.trim() || !password) return;
    submittingRef.current = true;
    const generation = ++submitGenerationRef.current;
    const isCurrent = () => mountedRef.current && submitGenerationRef.current === generation;
    setLoading(true);
    setError(null);
    const requestController = new AbortController();
    submitControllerRef.current?.abort();
    submitControllerRef.current = requestController;

    let navigating = false;
    try {
      const supabase = createAbortableClient(requestController.signal);
      const request = supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      const result = await withRequestDeadline<Awaited<typeof request>>(
        request,
        20_000,
        () => requestController.abort(),
      );
      if (!isCurrent()) return;
      if (result.error) throw result.error;
      navigating = true;
      router.replace("/");
      router.refresh();
    } catch (loginError) {
      if (!isCurrent()) return;
      setError(
        loginError instanceof RequestDeadlineError
          ? "Sign in timed out. Check your connection and try again."
          : isNetworkRequestError(loginError)
            ? "Could not reach Teammate. Check your connection and try again."
          : loginError instanceof Error
            ? loginError.message
            : "Could not sign in. Please try again.",
      );
    } finally {
      if (isCurrent() && !navigating) {
        submittingRef.current = false;
        setLoading(false);
      }
      if (submitControllerRef.current === requestController) {
        submitControllerRef.current = null;
      }
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="w-full max-w-sm mx-4">
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Teammate</CardTitle>
            <CardDescription>Sign in to your workspace</CardDescription>
          </CardHeader>
          <form onSubmit={handleLogin}>
            <CardPanel>
              <div className="space-y-4">
                <Field>
                  <FieldLabel>Email</FieldLabel>
                  <Input
                    type="email"
                    value={email}
                    disabled={loading}
                    autoComplete="email"
                    onChange={(e) => {
                      setEmail((e.target as HTMLInputElement).value);
                      setError(null);
                    }}
                    required
                    placeholder="you@example.com"
                  />
                </Field>

                <Field>
                  <FieldLabel>Password</FieldLabel>
                  <Input
                    type="password"
                    value={password}
                    disabled={loading}
                    autoComplete="current-password"
                    onChange={(e) => {
                      setPassword((e.target as HTMLInputElement).value);
                      setError(null);
                    }}
                    required
                    placeholder="Your password"
                  />
                </Field>

                {error && (
                  <Alert variant="error">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
              </div>
            </CardPanel>
            <CardFooter className="flex-col gap-4">
              <Button type="submit" loading={loading} disabled={!email.trim() || !password} className="w-full">
                Sign in
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                Don&apos;t have an account?{" "}
                <Link
                  href="/signup"
                  className="text-foreground underline underline-offset-4 hover:text-foreground/80"
                >
                  Sign up
                </Link>
              </p>
            </CardFooter>
          </form>
        </Card>
      </div>
    </div>
  );
}
