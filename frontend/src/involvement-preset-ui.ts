import type { HumanInvolvementPresetName } from "./types/shared.js";

/** Short copy + label shared by Admin and Home (long copy lives in HUMAN_INVOLVEMENT_PRESETS). */
export const INVOLVEMENT_PRESET_UI: Record<
  HumanInvolvementPresetName,
  { label: string; shortDescription: string; narrowDescription: string; color: string }
> = {
  yolo: {
    label: "YOLO",
    shortDescription: "Almost no protection. ~2s wait (~15s if unjustified).",
    narrowDescription: "~2s (~15s if unjustified)",
    // Crimson — hot / least protection; reads on warm gray page bg
    color: "#b42318",
  },
  aggressive: {
    label: "Aggressive",
    shortDescription: "~5 minute wait after human activity.",
    narrowDescription: "~5 minute wait",
    // Burnt amber — warm caution without washing out on cream
    color: "#b54708",
  },
  eager: {
    label: "Eager",
    shortDescription: "~2 hour wait. Balanced for most teams.",
    narrowDescription: "~2 hour wait",
    // Deep olive — yellow-green that stays legible on #f4f1ec
    color: "#3f6212",
  },
  conservative: {
    label: "Conservative",
    shortDescription: "~8 hour wait. Maximum protection.",
    narrowDescription: "~8 hour wait",
    color: "var(--color-text-primary)",
  },
};
