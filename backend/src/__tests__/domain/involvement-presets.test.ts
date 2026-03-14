import { describe, it, expect } from "vitest";
import { HUMAN_INVOLVEMENT_PRESETS } from "../../types/shared.js";

describe("Human-Involvement Presets", () => {
  it("all named presets exist: yolo, aggressive, eager, conservative", () => {
    expect(HUMAN_INVOLVEMENT_PRESETS).toHaveProperty("yolo");
    expect(HUMAN_INVOLVEMENT_PRESETS).toHaveProperty("aggressive");
    expect(HUMAN_INVOLVEMENT_PRESETS).toHaveProperty("eager");
    expect(HUMAN_INVOLVEMENT_PRESETS).toHaveProperty("conservative");
  });

  it("each preset has name, description, midpoint_seconds, and steepness", () => {
    for (const [, preset] of Object.entries(HUMAN_INVOLVEMENT_PRESETS)) {
      expect(preset).toHaveProperty("name");
      expect(preset).toHaveProperty("description");
      expect(typeof preset.description).toBe("string");
      expect(preset).toHaveProperty("midpoint_seconds");
      expect(typeof preset.midpoint_seconds).toBe("number");
      expect(preset).toHaveProperty("steepness");
      expect(typeof preset.steepness).toBe("number");
    }
  });

  it("yolo has the shortest midpoint (least protection)", () => {
    expect(HUMAN_INVOLVEMENT_PRESETS.yolo.midpoint_seconds).toBeLessThan(
      HUMAN_INVOLVEMENT_PRESETS.conservative.midpoint_seconds,
    );
  });

  it("conservative has the longest midpoint (most protection)", () => {
    const midpoints = Object.values(HUMAN_INVOLVEMENT_PRESETS).map((p) => p.midpoint_seconds);
    const maxMidpoint = Math.max(...midpoints);
    expect(HUMAN_INVOLVEMENT_PRESETS.conservative.midpoint_seconds).toBe(maxMidpoint);
  });
});
