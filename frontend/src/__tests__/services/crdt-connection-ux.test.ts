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
import {
  crdtConnectionPhase,
  isCrdtDegraded,
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

describe("isCrdtDegraded", () => {
  it("is false only when live", () => {
    expect(isCrdtDegraded("connected")).toBe(false);
  });

  it("is true for connecting (the bug that was missed)", () => {
    expect(isCrdtDegraded("connecting")).toBe(true);
  });

  it("is true for every non-live state", () => {
    for (const s of ALL_STATES) {
      expect(isCrdtDegraded(s)).toBe(s !== "connected");
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
  it("while editing, follows the editor transport state incl. offline", () => {
    expect(connectionBannerInfo(true, "connected", "disconnected")).toBeNull();
    expect(connectionBannerInfo(true, "reconnecting", "disconnected")!.message).toMatch(/reconnect/i);
    expect(connectionBannerInfo(true, "error", "disconnected")!.tone).toBe("red");
  });

  it("while viewing, surfaces the observer's active degraded phases", () => {
    // The bug being fixed: a server loss while only viewing was silently lost.
    expect(connectionBannerInfo(false, "disconnected", "reconnecting")).not.toBeNull();
    expect(connectionBannerInfo(false, "disconnected", "connecting")).not.toBeNull();
  });

  it("while viewing, shows NO banner when the observer is live or not running", () => {
    expect(connectionBannerInfo(false, "disconnected", "connected")).toBeNull();
    // "disconnected" observer = no observer running (not a failure) → no banner.
    expect(connectionBannerInfo(false, "disconnected", "disconnected")).toBeNull();
  });

  it("the viewing banner never claims unsaved changes (a viewer has no edits)", () => {
    const info = connectionBannerInfo(false, "disconnected", "reconnecting")!;
    expect(info.message.toLowerCase()).not.toContain("saved");
    expect(info.tone).toBe("amber");
  });
});
