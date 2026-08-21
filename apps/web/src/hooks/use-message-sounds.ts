"use client";

import { useCallback, useEffect, useRef } from "react";

export type MessageSoundKind = "send" | "receive";

interface MessageSoundPlayer {
  close: () => void;
  play: (kind: MessageSoundKind) => void;
  unlock: () => void;
}

function createMessageSoundPlayer(): MessageSoundPlayer {
  let context: AudioContext | null = null;
  let unlocked = false;

  function unlock() {
    if (typeof window === "undefined") return;

    try {
      if (!context || context.state === "closed") {
        context = new window.AudioContext();
      }

      const currentContext = context;
      if (currentContext.state === "running") {
        unlocked = true;
        return;
      }

      void currentContext
        .resume()
        .then(() => {
          if (context === currentContext && currentContext.state === "running") {
            unlocked = true;
          }
        })
        .catch(() => undefined);
    } catch {
      // Message sounds are optional; unsupported or blocked audio stays silent.
    }
  }

  function play(kind: MessageSoundKind) {
    if (!unlocked || !context || context.state !== "running") return;

    try {
      const start = context.currentTime;
      const duration = kind === "send" ? 0.09 : 0.11;
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(kind === "send" ? 520 : 720, start);
      oscillator.frequency.exponentialRampToValueAtTime(
        kind === "send" ? 700 : 560,
        start + duration,
      );

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.022, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.addEventListener(
        "ended",
        () => {
          oscillator.disconnect();
          gain.disconnect();
        },
        { once: true },
      );
      oscillator.start(start);
      oscillator.stop(start + duration);
    } catch {
      // A suspended browser or unavailable output device should not affect chat.
    }
  }

  function close() {
    unlocked = false;
    const currentContext = context;
    context = null;
    if (currentContext && currentContext.state !== "closed") {
      void currentContext.close().catch(() => undefined);
    }
  }

  return { close, play, unlock };
}

export function useMessageSounds(enabled: boolean) {
  const enabledRef = useRef(enabled);
  const playerRef = useRef<MessageSoundPlayer | null>(null);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      playerRef.current?.close();
      playerRef.current = null;
    }
  }, [enabled]);

  useEffect(() => {
    const unlockFromGesture = (event: Event) => {
      if (!event.isTrusted || !enabledRef.current) return;
      if (!playerRef.current) playerRef.current = createMessageSoundPlayer();
      playerRef.current.unlock();
    };

    window.addEventListener("pointerdown", unlockFromGesture, true);
    window.addEventListener("keydown", unlockFromGesture, true);

    return () => {
      window.removeEventListener("pointerdown", unlockFromGesture, true);
      window.removeEventListener("keydown", unlockFromGesture, true);
      playerRef.current?.close();
      playerRef.current = null;
    };
  }, []);

  return useCallback((kind: MessageSoundKind) => {
    if (!enabledRef.current) return;
    playerRef.current?.play(kind);
  }, []);
}
