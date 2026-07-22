import { useCallback, useEffect, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";

export function useActiveEditors(
  awareness: Awareness | null,
  isLiveAuthority: boolean,
): (fragmentKey: string) => string[] {
  const [snapshot, setSnapshot] = useState<Map<string, string[]>>(() => new Map());
  const prevJsonRef = useRef<string>("[]");

  useEffect(() => {
    if (!awareness || !isLiveAuthority) {
      if (prevJsonRef.current !== "[]") {
        prevJsonRef.current = "[]";
        setSnapshot(new Map());
      }
      return;
    }

    const localClientID = awareness.clientID;

    function computeSnapshot(): Map<string, string[]> {
      const map = new Map<string, string[]>();
      for (const [clientID, state] of awareness!.getStates()) {
        if (clientID === localClientID) continue;
        const viewingSections: string[] | undefined = state.user?.viewingSections;
        if (!viewingSections) continue;
        for (const fragmentKey of viewingSections) {
          const editors = map.get(fragmentKey) ?? [];
          editors.push(String(clientID));
          map.set(fragmentKey, editors);
        }
      }
      return map;
    }

    function onAwarenessChange() {
      const next = computeSnapshot();
      const nextJson = JSON.stringify([...next.entries()]);
      if (nextJson !== prevJsonRef.current) {
        prevJsonRef.current = nextJson;
        setSnapshot(next);
      }
    }

    onAwarenessChange();
    awareness.on("change", onAwarenessChange);
    return () => {
      awareness.off("change", onAwarenessChange);
    };
  }, [awareness, isLiveAuthority]);

  return useCallback((fragmentKey: string) => snapshot.get(fragmentKey) ?? [], [snapshot]);
}
