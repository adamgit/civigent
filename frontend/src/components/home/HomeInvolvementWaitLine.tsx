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

  if (layoutMode === "narrow") {
    return (
      <p className="home-wait" data-testid="involvement-wait-line" title={long.description}>
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

  return (
    <p
      data-testid="involvement-wait-line"
      title={long.description}
      style={{
        maxWidth: "75%",
        margin: "-0.75rem auto 1.75rem",
        fontSize: 13,
        lineHeight: 1.45,
        color: "var(--color-text-primary)",
      }}
    >
      AI waits for humans:{" "}
      <Link
        to="/admin"
        title={long.description}
        style={{
          color: ui.color,
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        {ui.label}
      </Link>
      {" - "}
      <Link
        to="/admin"
        title={long.description}
        style={{ color: "var(--color-text-primary)", textDecoration: "none" }}
      >
        {ui.shortDescription}
      </Link>
    </p>
  );
}
