import { Link } from "react-router-dom";
import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";
import { INVOLVEMENT_PRESET_UI } from "../../involvement-preset-ui";
import { HUMAN_INVOLVEMENT_PRESETS, type HumanInvolvementPresetName } from "../../types/shared.js";

interface HomeInvolvementWaitLineProps {
  preset: HumanInvolvementPresetName;
  layoutMode: DocLayoutMode;
}

export function HomeInvolvementWaitLine({ preset, layoutMode }: HomeInvolvementWaitLineProps) {
  const ui = INVOLVEMENT_PRESET_UI[preset];
  const long = HUMAN_INVOLVEMENT_PRESETS[preset];

  return (
    <p
      className={`home-wait${layoutMode === "wide" ? " home-wait--inline" : ""}`}
      data-testid="involvement-wait-line"
      title={long.description}
    >
      AI waits for humans:{" "}
      <Link
        to="/admin"
        className="home-wait__preset"
        title={long.description}
        style={{ color: ui.color }}
      >
        {ui.label}
      </Link>
      {" \u00b7 "}
      {ui.narrowDescription}
    </p>
  );
}
