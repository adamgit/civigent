/**
 * useViewingPresence — viewingPresence: client-informational, cosmetic UI only.
 *
 * Returns an array of remote users whose Awareness state includes the given
 * sectionKey in their viewingSections array. Subscribes to Awareness "change"
 * events and memoizes the result to avoid unnecessary re-renders.
 *
 * Signal source is editor focus for now; can be swapped to
 * IntersectionObserver without touching backend.
 */

import { useEffect, useState, useRef } from "react";
import type { Awareness } from "y-protocols/awareness";

export interface ViewingUser {
  name: string;
  color: string;
}

/**
 * Hook to get remote users viewing a specific section via Y.js Awareness.
 *
 * @param awareness - The Y.js Awareness instance (or null if not connected)
 * @param sectionKey - The fragment key of the section to check
 * @returns Array of remote users currently viewing this section
 */
export function useViewingPresence(
  awareness: Awareness | null,
  sectionKey: string,
): ViewingUser[] {
  const [viewers, setViewers] = useState<ViewingUser[]>([]);
  const prevJsonRef = useRef<string>("[]");

  useEffect(() => {
    if (!awareness) {
      if (prevJsonRef.current !== "[]") {
        prevJsonRef.current = "[]";
        setViewers([]);
      }
      return;
    }

    const localClientID = awareness.clientID;

    function computeViewers(): ViewingUser[] {
      const result: ViewingUser[] = [];
      const states = awareness!.getStates();
      for (const [clientID, state] of states) {
        if (clientID === localClientID) continue;
        const user = state.user;
        if (!user) continue;
        const viewingSections: string[] | undefined = user.viewingSections;
        if (!viewingSections || !viewingSections.includes(sectionKey)) continue;
        result.push({
          name: user.name ?? "Anonymous",
          color: user.color ?? "#888",
        });
      }
      return result;
    }

    function onAwarenessChange() {
      const next = computeViewers();
      const nextJson = JSON.stringify(next);
      if (nextJson !== prevJsonRef.current) {
        prevJsonRef.current = nextJson;
        setViewers(next);
      }
    }

    // Compute initial state
    onAwarenessChange();

    awareness.on("change", onAwarenessChange);
    return () => {
      awareness.off("change", onAwarenessChange);
    };
  }, [awareness, sectionKey]);

  return viewers;
}
