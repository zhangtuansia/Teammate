"use client";

import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import React from "react";

export type AgentActivity = "idle" | "thinking" | "working" | "error";

export interface ActivityState {
  activity: AgentActivity;
  /** Human-readable label: "Thinking", "Reading file", "Sending message", etc. */
  label: string;
  /** Specific detail: file path, command, message target, or agent text output */
  detail: string;
}

type ActivitiesMap = Map<string, ActivityState>;

const AgentActivityContext = createContext<ActivitiesMap>(new Map());

/**
 * Provider that manages a single Supabase broadcast subscription
 * for agent activity. Mount once in a shared layout so all consumers
 * share the same subscription — no channel conflicts on unmount.
 */
export function AgentActivityProvider({ children }: { children: ReactNode }) {
  const [activities, setActivities] = useState<ActivitiesMap>(new Map());
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel("agent-activity", {
      config: { broadcast: { self: false } },
    });

    channel
      .on("broadcast", { event: "activity" }, (msg: { payload: Record<string, unknown> }) => {
        const { agentId, activity, label, detail } = msg.payload as {
          agentId: string;
          activity: AgentActivity;
          label?: string;
          detail?: string;
        };

        setActivities((prev) => {
          const next = new Map(prev);
          next.set(agentId, {
            activity,
            label: label || "",
            detail: detail || "",
          });
          return next;
        });

        // Set a timeout: if no update within 90s, fall back to idle
        const existing = timeoutsRef.current.get(agentId);
        if (existing) clearTimeout(existing);

        if (activity === "thinking" || activity === "working") {
          timeoutsRef.current.set(
            agentId,
            setTimeout(() => {
              setActivities((prev) => {
                const next = new Map(prev);
                next.set(agentId, { activity: "idle", label: "Idle", detail: "" });
                return next;
              });
              timeoutsRef.current.delete(agentId);
            }, 90_000)
          );
        } else {
          timeoutsRef.current.delete(agentId);
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      for (const t of timeoutsRef.current.values()) clearTimeout(t);
      timeoutsRef.current.clear();
    };
  }, []);

  return React.createElement(AgentActivityContext.Provider, { value: activities }, children);
}

/**
 * Subscribe to real-time agent activity broadcasts.
 * Returns a Map of agentId -> { activity, label, detail }.
 * Must be used within an AgentActivityProvider.
 */
export function useAgentActivity() {
  return useContext(AgentActivityContext);
}
