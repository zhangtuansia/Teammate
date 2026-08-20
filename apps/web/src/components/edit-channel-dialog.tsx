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

interface Channel {
  id: string;
  name: string;
  type: string;
  description: string | null;
}

interface EditChannelDialogProps {
  channel: Channel;
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

export function EditChannelDialog({
  channel,
  open,
  onClose,
  onUpdated,
}: EditChannelDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [memberAgentIds, setMemberAgentIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const supabase = createClient();

  useEffect(() => {
    if (open) {
      setName(channel.name);
      setDescription(channel.description || "");
      setError("");
      loadData();
    }
  }, [open, channel]);

  async function loadData() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data: agents } = await supabase
      .from("agents")
      .select("id, display_name, description, status")
      .eq("owner_id", user.id)
      .order("created_at");

    if (agents) setAllAgents(agents as Agent[]);

    const { data: members } = await supabase
      .from("channel_members")
      .select("member_id")
      .eq("channel_id", channel.id)
      .eq("member_type", "agent");

    if (members) {
      setMemberAgentIds(
        new Set(members.map((m: { member_id: string }) => m.member_id))
      );
    }
  }

  function toggleAgent(agentId: string) {
    setMemberAgentIds((prev) => {
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
      const { error: updateError } = await supabase
        .from("channels")
        .update({
          name: name.trim(),
          description: description.trim() || null,
        })
        .eq("id", channel.id);

      if (updateError) throw new Error(updateError.message);

      const { data: currentMembers } = await supabase
        .from("channel_members")
        .select("member_id")
        .eq("channel_id", channel.id)
        .eq("member_type", "agent");

      const currentIds = new Set<string>(
        (currentMembers || []).map(
          (m: { member_id: string }) => m.member_id
        )
      );

      const toAdd = Array.from(memberAgentIds).filter(
        (id) => !currentIds.has(id)
      );
      if (toAdd.length > 0) {
        await supabase.from("channel_members").insert(
          toAdd.map((agentId) => ({
            channel_id: channel.id,
            member_id: agentId,
            member_type: "agent",
          }))
        );
      }

      const toRemove = Array.from(currentIds).filter(
        (id) => !memberAgentIds.has(id)
      );
      for (const agentId of toRemove) {
        await supabase
          .from("channel_members")
          .delete()
          .eq("channel_id", channel.id)
          .eq("member_id", agentId);
      }

      onUpdated();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update channel"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Edit Channel</DialogTitle>
          <DialogDescription>Update channel settings and agent membership.</DialogDescription>
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
                    required
                    autoFocus
                    className="flex-1"
                  />
                </div>
              </Field>

              <Field>
                <FieldLabel>Description</FieldLabel>
                <Input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription((e.target as HTMLInputElement).value)}
                  placeholder="What's this channel about?"
                />
              </Field>

              {allAgents.length > 0 && (
                <Field>
                  <FieldLabel>Agents in Channel</FieldLabel>
                  <div className="rounded-lg border">
                    <div className="p-2 space-y-1">
                      {allAgents.map((agent) => (
                        <Label
                          key={agent.id}
                          className="flex items-center gap-2.5 rounded-md px-2.5 py-2 cursor-pointer transition-colors hover:bg-accent"
                        >
                          <Checkbox
                            checked={memberAgentIds.has(agent.id)}
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
              Save Changes
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
