"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { Field, FieldLabel } from "@/components/ui/field";
import { apiUrl } from "@/lib/api-url";
import { CheckIcon, CopyIcon, LoaderIcon, MonitorIcon, TerminalIcon } from "lucide-react";
import { CODEX_MODEL_ITEMS } from "@/lib/agent-runtime";

interface SetupWizardProps {
  serverId: string;
  serverSlug: string;
  onComplete: () => void;
}

const MODEL_ITEMS: Array<{ value: string; label: string }> =
  CODEX_MODEL_ITEMS.map((item) => ({ ...item }));

type Step = "connect" | "connected" | "create-agent";

export function SetupWizard({ serverId, serverSlug, onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<Step>("connect");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [machineName, setMachineName] = useState("");

  // Create agent form
  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");
  const [agentModel, setAgentModel] = useState("default");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [agentError, setAgentError] = useState("");

  const router = useRouter();
  const mountedRef = useRef(false);
  const creatingAgentRef = useRef(false);
  const createAgentControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      createAgentControllerRef.current?.abort();
      createAgentControllerRef.current = null;
      creatingAgentRef.current = false;
    };
  }, []);

  // Load API key from sessionStorage
  useEffect(() => {
    const storedKey = sessionStorage.getItem("teammate_setup_key");
    if (storedKey) {
      sessionStorage.removeItem("teammate_setup_key");
      const frame = window.requestAnimationFrame(() => setApiKey(storedKey));
      return () => window.cancelAnimationFrame(frame);
    }
  }, []);

  // Poll for bridge connection (check if the key's last_used_at becomes non-null)
  useEffect(() => {
    if (step !== "connect" || !apiKey) return;

    const keyPrefix = apiKey.substring(0, 11); // "tm_" + first 8 hex chars
    let cancelled = false;
    let pollTimer: number | null = null;
    let pollController: AbortController | null = null;

    async function checkConnection() {
      if (cancelled) return;
      const controller = new AbortController();
      pollController = controller;
      const timeout = window.setTimeout(() => controller.abort(), 8_000);
      try {
        const res = await fetch(apiUrl(`/api/bridge/keys?server_id=${serverId}`), {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const { keys } = (await res.json()) as { keys?: unknown };
        if (!Array.isArray(keys)) return;
        const matchedKey = keys.find(
          (k: { key_prefix: string; last_used_at: string | null }) =>
            k.key_prefix === keyPrefix
        );
        if (!cancelled && matchedKey?.last_used_at) {
          setMachineName(matchedKey.name || "");
          setStep("connected");
        }
      } catch {
        // A later poll can recover from a transient local-runtime or network failure.
      } finally {
        window.clearTimeout(timeout);
        if (pollController === controller) pollController = null;
        if (!cancelled) {
          pollTimer = window.setTimeout(() => {
            pollTimer = null;
            void checkConnection();
          }, 3_000);
        }
      }
    }

    void checkConnection();
    return () => {
      cancelled = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollController?.abort();
    };
  }, [step, apiKey, serverId]);

  const npxCommand = apiKey
    ? `npx @teammate/runtime --api-key ${apiKey}`
    : "";

  async function handleCopy() {
    if (!npxCommand) return;
    await navigator.clipboard.writeText(npxCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleCreateAgent(e: React.FormEvent) {
    e.preventDefault();
    if (!agentName.trim() || creatingAgentRef.current) return;

    creatingAgentRef.current = true;
    setCreatingAgent(true);
    setAgentError("");
    const controller = new AbortController();
    createAgentControllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(apiUrl("/api/agents"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          display_name: agentName.trim(),
          description: agentDescription.trim() || undefined,
          runtime: "codex",
          model: agentModel,
          system_prompt: agentPrompt.trim() || undefined,
          server_id: serverId,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        channel?: { id?: unknown };
        error?: unknown;
      } | null;

      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : "Failed to create agent",
        );
      }
      if (!data || (data.channel?.id !== undefined && typeof data.channel.id !== "string")) {
        throw new Error("The created agent response was invalid.");
      }
      if (!mountedRef.current || createAgentControllerRef.current !== controller) return;

      // Navigate to the agent's DM
      if (data.channel?.id) {
        router.push(`/s/${serverSlug}/dm/${data.channel.id}`);
      }
      onComplete();
    } catch (err) {
      if (mountedRef.current && createAgentControllerRef.current === controller) {
        setAgentError(
          err instanceof DOMException && err.name === "AbortError"
            ? "Agent creation timed out. Please try again."
            : err instanceof Error
              ? err.message
              : "Failed to create agent",
        );
      }
    } finally {
      window.clearTimeout(timeout);
      if (createAgentControllerRef.current === controller) {
        createAgentControllerRef.current = null;
        creatingAgentRef.current = false;
        if (mountedRef.current) setCreatingAgent(false);
      }
    }
  }

  function handleSkip() {
    if (creatingAgentRef.current) return;
    onComplete();
  }

  const selectedModel = MODEL_ITEMS.find((m) => m.value === agentModel) ?? MODEL_ITEMS[0];

  return (
    <Dialog open onOpenChange={(open) => { if (!open) handleSkip(); }}>
      <DialogPopup showCloseButton={false} className="max-w-md">
        {step === "connect" && (
          <>
            <DialogHeader>
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-2">
                <MonitorIcon className="size-6" />
              </div>
              <DialogTitle className="text-center">Connect Your Machine</DialogTitle>
              <DialogDescription className="text-center">
                Run this command on your computer to connect it to Teammate.
                The runtime uses your existing Codex CLI login by default.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="space-y-4">
                {apiKey ? (
                  <>
                    <div className="relative">
                      <div className="rounded-lg border bg-muted/50 p-3 pr-10 font-mono text-xs break-all select-all leading-relaxed">
                        {npxCommand}
                      </div>
                      <button
                        onClick={handleCopy}
                        className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                        title="Copy command"
                      >
                        {copied ? (
                          <CheckIcon className="size-3.5 text-green-500" />
                        ) : (
                          <CopyIcon className="size-3.5" />
                        )}
                      </button>
                    </div>
                    <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-2">
                      <LoaderIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                      <span>Waiting for connection...</span>
                    </div>
                  </>
                ) : (
                  <div className="text-center py-4 text-sm text-muted-foreground">
                    Generating API key...
                  </div>
                )}
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="ghost" onClick={handleSkip}>
                Skip for now
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "connected" && (
          <>
            <DialogHeader>
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-green-500/10 text-green-500 mb-2">
                <CheckIcon className="size-6" />
              </div>
              <DialogTitle className="text-center">Machine Connected</DialogTitle>
              <DialogDescription className="text-center">
                Your computer is now connected to Teammate.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="space-y-4">
                <Field>
                  <FieldLabel>Machine Name</FieldLabel>
                  <Input
                    type="text"
                    value={machineName}
                    onChange={(e) => setMachineName((e.target as HTMLInputElement).value)}
                    placeholder="e.g. My MacBook, Work PC..."
                  />
                </Field>
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button onClick={() => setStep("create-agent")}>
                Continue
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "create-agent" && (
          <>
            <DialogHeader>
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-2">
                <TerminalIcon className="size-6" />
              </div>
              <DialogTitle className="text-center">Create Your First Agent</DialogTitle>
              <DialogDescription className="text-center">
                Agents are AI assistants that live in your workspace. Create one to get started.
              </DialogDescription>
            </DialogHeader>
            <form className="contents" onSubmit={handleCreateAgent}>
              <DialogPanel>
                <div className="space-y-4">
                  <Field>
                    <FieldLabel>Name</FieldLabel>
                    <Input
                      type="text"
                      value={agentName}
                      onChange={(e) => setAgentName((e.target as HTMLInputElement).value)}
                      placeholder="e.g. Design Assistant, Code Reviewer..."
                      required
                      autoFocus
                    />
                  </Field>

                  <Field>
                    <FieldLabel>
                      Description <span className="text-muted-foreground font-normal">(optional)</span>
                    </FieldLabel>
                    <Input
                      type="text"
                      value={agentDescription}
                      onChange={(e) => setAgentDescription((e.target as HTMLInputElement).value)}
                      placeholder="What does this agent do?"
                    />
                  </Field>

                  <Field>
                    <FieldLabel>Model</FieldLabel>
                    <Select
                      value={selectedModel}
                      onValueChange={(val) => {
                        if (val) setAgentModel((val as typeof selectedModel).value);
                      }}
                      items={MODEL_ITEMS}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a model" />
                      </SelectTrigger>
                      <SelectPopup>
                        {MODEL_ITEMS.map((item) => (
                          <SelectItem key={item.value} value={item}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </Field>

                  <Field>
                    <FieldLabel>
                      Instructions <span className="text-muted-foreground font-normal">(optional)</span>
                    </FieldLabel>
                    <Textarea
                      value={agentPrompt}
                      onChange={(e) => setAgentPrompt((e.target as HTMLTextAreaElement).value)}
                      placeholder="Tell the agent how to behave, what it's good at..."
                    />
                  </Field>

                  {agentError && (
                    <p className="text-sm text-destructive">{agentError}</p>
                  )}
                </div>
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={handleSkip}
                  disabled={creatingAgent}
                >
                  Skip for now
                </Button>
                <Button type="submit" loading={creatingAgent} disabled={!agentName.trim()}>
                  Create Agent
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
