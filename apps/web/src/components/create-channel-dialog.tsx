"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Field, FieldLabel } from "@/components/ui/field";
import { GeneratedAvatar } from "./generated-avatar";

interface Agent {
  id: string;
  display_name: string;
  description: string | null;
  status: string;
}

interface CreateChannelDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  serverId: string;
}

export function CreateChannelDialog({
  open,
  onClose,
  onCreated,
  serverId,
}: CreateChannelDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    new Set()
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const supabase = createClient();

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setSelectedAgentIds(new Set());
      setError("");
      loadAgents();
    }
  }, [open]);

  async function loadAgents() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data } = await supabase
      .from("agents")
      .select("id, display_name, description, status")
      .eq("server_id", serverId)
      .order("created_at");

    if (data) setAgents(data as Agent[]);
  }

  function toggleAgent(agentId: string) {
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    setSaving(true);
    setError("");

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data: channel, error: channelError } = await supabase
        .from("channels")
        .insert({
          name: name.trim(),
          description: description.trim() || null,
          type: "public",
          server_id: serverId,
          created_by: user.id,
        })
        .select()
        .single();

      if (channelError) throw new Error(channelError.message);

      await supabase.from("channel_members").insert({
        channel_id: channel.id,
        member_id: user.id,
        member_type: "human",
      });

      if (selectedAgentIds.size > 0) {
        const agentMembers = Array.from(selectedAgentIds).map((agentId) => ({
          channel_id: channel.id,
          member_id: agentId,
          member_type: "agent",
        }));
        await supabase.from("channel_members").insert(agentMembers);
      }

      onCreated();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create channel"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Create Channel</DialogTitle>
          <DialogDescription>Create a new group channel for your workspace.</DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogPanel>
            <div className="space-y-4">
              <Field>
                <FieldLabel>Channel Name</FieldLabel>
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground text-sm">#</span>
                  <Input
                    type="text"
                    value={name}
                    onChange={(e) =>
                      setName((e.target as HTMLInputElement).value.toLowerCase().replace(/\s+/g, "-"))
                    }
                    placeholder="e.g. design, marketing, dev..."
                    required
                    autoFocus
                    className="flex-1"
                  />
                </div>
              </Field>

              <Field>
                <FieldLabel>
                  Description <span className="text-muted-foreground font-normal">(optional)</span>
                </FieldLabel>
                <Input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription((e.target as HTMLInputElement).value)}
                  placeholder="What's this channel about?"
                />
              </Field>

              {agents.length > 0 && (
                <Field>
                  <FieldLabel>
                    Invite Agents <span className="text-muted-foreground font-normal">(optional)</span>
                  </FieldLabel>
                  <div className="rounded-lg border">
                    <div className="p-2 space-y-1">
                      {agents.map((agent) => (
                        <Label
                          key={agent.id}
                          className="flex items-center gap-2.5 rounded-md px-2.5 py-2 cursor-pointer transition-colors hover:bg-accent"
                        >
                          <Checkbox
                            checked={selectedAgentIds.has(agent.id)}
                            onCheckedChange={() => toggleAgent(agent.id)}
                          />
                          <GeneratedAvatar id={agent.id} name={agent.display_name} size="xs" />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm truncate">
                              {agent.display_name}
                            </div>
                            {agent.description && (
                              <div className="text-[10px] text-muted-foreground truncate">
                                {agent.description}
                              </div>
                            )}
                          </div>
                        </Label>
                      ))}
                    </div>
                  </div>
                </Field>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>
              Cancel
            </DialogClose>
            <Button type="submit" loading={saving} disabled={!name.trim()}>
              Create Channel
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
