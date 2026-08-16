import { useEffect, useState } from "react";

export const DOC_NARROW_LAYOUT_MAX_PX = 1000;

export type DocLayoutMode = "wide" | "narrow";

function modeForWidth(width: number): DocLayoutMode {
  return width <= DOC_NARROW_LAYOUT_MAX_PX ? "narrow" : "wide";
}

export function useDocLayoutMode(): DocLayoutMode {
  const [mode, setMode] = useState<DocLayoutMode>(() => modeForWidth(window.innerWidth));

  useEffect(() => {
    const measure = () => setMode(modeForWidth(window.innerWidth));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  return mode;
}
