"use client";

import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import React from "react";

export type AgentActivity = "idle" | "thinking" | "working" | "error";

export interface ActivityState {
  activity: AgentActivity;
  /** Human-readable label: "Thinking", "Reading file", "Sending message", etc. */
  label: string;
  /** Optional sanitized, user-facing detail. Never contains reasoning, commands, or paths. */
  detail: string;
  /** Channel where the current turn is running. Null for workspace-wide idle state. */
  channelId: string | null;
  /** Terminal outcome for the most recent turn. */
  terminal: "success" | "failure" | "timeout" | null;
  /** Local receipt time used to ignore terminal events from an earlier turn. */
  receivedAt: number;
  /**
   * When this turn started, carried across label changes within it.
   *
   * A teammate woken by a message it decides not to answer is busy for a
   * moment and then idle again. Showing that as a bubble means one appears and
   * vanishes with nothing in it, which reads as something having gone wrong.
   * Consumers wait this out before drawing anything.
   */
  busySince: number;
}

type ActivitiesMap = Map<string, ActivityState>;
const EMPTY_ACTIVITIES: ActivitiesMap = new Map();

const AgentActivityContext = createContext<ActivitiesMap>(new Map());

/**
 * Provider that manages a single Supabase broadcast subscription
 * for agent activity. Mount once in a shared layout so all consumers
 * share the same subscription — no channel conflicts on unmount.
 */
export function AgentActivityProvider({
  children,
  serverId,
}: {
  children: ReactNode;
  serverId: string;
}) {
  const [snapshot, setSnapshot] = useState<{
    serverId: string;
    activities: ActivitiesMap;
  }>({ serverId, activities: new Map() });
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const activities = snapshot.serverId === serverId ? snapshot.activities : EMPTY_ACTIVITIES;

  useEffect(() => {
    const supabase = createClient();
    const timeouts = new Map<string, ReturnType<typeof setTimeout>>();
    timeoutsRef.current = timeouts;
    const channel = supabase.channel(`agent-activity:${serverId}`, {
      config: { private: true, broadcast: { self: false } },
    });

    channel
      .on("broadcast", { event: "activity" }, (msg: { payload: Record<string, unknown> }) => {
        const { agentId, activity, label, detail, channelId, serverId: payloadServerId } = msg.payload as {
          agentId: string;
          activity: AgentActivity;
          label?: string;
          detail?: string;
          channelId?: string | null;
          serverId?: string;
        };
        if (
          payloadServerId !== serverId ||
          typeof agentId !== "string" ||
          !["idle", "thinking", "working", "error"].includes(activity)
        ) {
          return;
        }

        setSnapshot((currentSnapshot) => {
          const currentActivities = currentSnapshot.serverId === serverId
            ? currentSnapshot.activities
            : EMPTY_ACTIVITIES;
          const nextState: ActivityState = {
            activity,
            label: typeof label === "string" ? label : "",
            detail: typeof detail === "string" ? detail : "",
            channelId: typeof channelId === "string" ? channelId : null,
            terminal: activity === "idle"
              ? "success"
              : activity === "error"
                ? "failure"
                : null,
            receivedAt: Date.now(),
            busySince: 0,
          };
          const currentState = currentActivities.get(agentId);
          const busy = activity === "thinking" || activity === "working";
          const wasBusy = currentState?.activity === "thinking" ||
            currentState?.activity === "working";
          // Only a fresh turn resets the clock; a new label inside one does not.
          nextState.busySince = busy
            ? (wasBusy && currentState ? currentState.busySince : Date.now())
            : 0;
          if (
            currentSnapshot.serverId === serverId &&
            currentState?.activity === nextState.activity &&
            currentState.label === nextState.label &&
            currentState.detail === nextState.detail &&
            currentState.channelId === nextState.channelId &&
            currentState.terminal === nextState.terminal
          ) {
            return currentSnapshot;
          }
          const nextActivities = new Map(currentActivities);
          nextActivities.set(agentId, nextState);
          return { serverId, activities: nextActivities };
        });

        // A lost terminal event must not leave the conversation in Thinking forever.
        const existing = timeouts.get(agentId);
        if (existing) clearTimeout(existing);

        if (activity === "thinking" || activity === "working") {
          timeouts.set(
            agentId,
            setTimeout(() => {
              setSnapshot((currentSnapshot) => {
                if (currentSnapshot.serverId !== serverId) return currentSnapshot;
                const currentState = currentSnapshot.activities.get(agentId);
                if (
                  currentState?.activity !== "thinking" &&
                  currentState?.activity !== "working"
                ) return currentSnapshot;
                const nextActivities = new Map(currentSnapshot.activities);
                nextActivities.set(agentId, {
                  activity: "error",
                  label: "Response timed out",
                  detail: "",
                  busySince: 0,
                  channelId: currentState.channelId,
                  terminal: "timeout",
                  receivedAt: Date.now(),
                });
                return { serverId, activities: nextActivities };
              });
              timeouts.delete(agentId);
            }, 90_000)
          );
        } else {
          timeouts.delete(agentId);
        }
      })
      .subscribe((status: string, error?: Error) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("Agent activity subscription failed", { status, error, serverId });
        }
      });

    return () => {
      supabase.removeChannel(channel);
      for (const timeout of timeouts.values()) clearTimeout(timeout);
      timeouts.clear();
    };
  }, [serverId]);

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
