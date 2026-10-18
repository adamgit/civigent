/**
 * Unit tests for the connection-state → UX mapping.
 *
 * This is the exact logic that was previously gated on `reconnecting`/`error`
 * only, leaving `connecting` (first-connect / hung socket) with no banner and no
 * read-only affordance. These tests pin every raw provider state to its phase,
 * its degraded-ness, and its banner/section messaging so a missed state can't
 * regress silently again.
 */

import { describe, it, expect } from "vitest";
import type { CrdtConnectionState } from "../../services/crdt-provider";
import { editing, viewing } from "../../status/live-document-session";
import { SectionId } from "../../types/live-sections";
import {
  crdtConnectionPhase,
  crdtBannerInfo,
  connectionBannerInfo,
} from "../../services/crdt-connection-ux";

const ALL_STATES: CrdtConnectionState[] = [
  "disconnected",
  "connecting",
  "connected",
  "reconnecting",
  "error",
];

describe("crdtConnectionPhase", () => {
  it("maps every raw state to a coarse phase", () => {
    expect(crdtConnectionPhase("connected")).toBe("live");
    expect(crdtConnectionPhase("connecting")).toBe("connecting");
    expect(crdtConnectionPhase("reconnecting")).toBe("reconnecting");
    expect(crdtConnectionPhase("error")).toBe("offline");
    expect(crdtConnectionPhase("disconnected")).toBe("offline");
  });

  it("covers all states (no undefined fall-through)", () => {
    for (const s of ALL_STATES) {
      expect(crdtConnectionPhase(s)).toBeDefined();
    }
  });
});

describe("crdtBannerInfo", () => {
  it("returns null only when live", () => {
    expect(crdtBannerInfo("connected")).toBeNull();
  });

  it("returns a banner for every degraded state, including connecting", () => {
    for (const s of ALL_STATES) {
      if (s === "connected") continue;
      const info = crdtBannerInfo(s);
      expect(info).not.toBeNull();
      expect(info!.message.length).toBeGreaterThan(0);
      expect(info!.sectionLabel.length).toBeGreaterThan(0);
      expect(["amber", "red"]).toContain(info!.tone);
    }
  });

  it("uses a calm amber tone for transient phases and red for offline", () => {
    expect(crdtBannerInfo("connecting")!.tone).toBe("amber");
    expect(crdtBannerInfo("reconnecting")!.tone).toBe("amber");
    expect(crdtBannerInfo("error")!.tone).toBe("red");
    expect(crdtBannerInfo("disconnected")!.tone).toBe("red");
  });
});

describe("connectionBannerInfo (editing vs viewing)", () => {
  const section = SectionId.brand("s1");

  it("while editing, follows the editor pipe phase incl. error", () => {
    expect(connectionBannerInfo(editing(section, { phase: "live" }, false))).toBeNull();
    expect(connectionBannerInfo(editing(section, { phase: "reconnecting" }, false))!.message).toMatch(/reconnect/i);
    expect(connectionBannerInfo(editing(section, { phase: "error" }, false))!.tone).toBe("red");
  });

  it("while viewing, surfaces the observer's active degraded phases", () => {
    expect(connectionBannerInfo(viewing({ phase: "reconnecting" }, false))).not.toBeNull();
    expect(connectionBannerInfo(viewing({ phase: "connecting" }, false))).not.toBeNull();
  });

  it("while viewing, shows NO banner when the observer is live", () => {
    expect(connectionBannerInfo(viewing({ phase: "live" }, false))).toBeNull();
  });

  it("the viewing banner never claims unsaved changes (a viewer has no edits)", () => {
    const info = connectionBannerInfo(viewing({ phase: "reconnecting" }, false))!;
    expect(info.message.toLowerCase()).not.toContain("saved");
    expect(info.tone).toBe("amber");
  });
});
