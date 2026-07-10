/**
 * useDocumentActivity — direct fake-timer coverage of the DocTransportStatus
 * presentation adapter (spec follow-up — harden save receipts).
 *
 * The pill NEVER infers success on its own: it shows "Saved" / "Up to date" ONLY
 * when the shared `DocTransportStatus` model actually reaches its success rung
 * (`saved` for a local save, `upToDate` for an inbound update). Any other terminal
 * rung (`savedToProposal` stuck, `offline`, `idle`) must fade WITHOUT claiming
 * success. These tests pin exactly that mapping.
 *
 * The pill's wording (mirrors DocumentActivityIndicator):
 *   settled + local  → "Saved"        settled + inbound → "Up to date"
 *   active  + local  → "Saving"       active  + inbound → "Updating"
 *   idle             → (hidden)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDocumentActivity } from "../../hooks/useDocumentActivity";
import type { DocumentActivityState } from "../../hooks/useDocumentActivity";
import type { DocTransportStatus } from "../../services/section-save-state";

/** The pill label the indicator would render for a hook state (null = hidden). */
function pillLabel(state: DocumentActivityState): string | null {
  if (state.phase === "settled") return state.kind === "local" ? "Saved" : "Up to date";
  if (state.phase === "active") return state.kind === "local" ? "Saving" : "Updating";
  return null;
}

/** Advance fake timers inside act() so effect-scheduled callbacks flush. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useDocumentActivity — DocTransportStatus adapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderFor(initial: DocTransportStatus) {
    return renderHook(({ status }: { status: DocTransportStatus }) => useDocumentActivity(status), {
      initialProps: { status: initial },
    });
  }

  it("saving → savedToProposal → saved shows 'Saved'", () => {
    const { result, rerender } = renderFor("saving");
    expect(pillLabel(result.current)).toBe("Saving");

    // Transient not-yet-committed rung: stays active, no false success.
    rerender({ status: "savedToProposal" });
    expect(pillLabel(result.current)).toBe("Saving");

    // The shared model confirms the landing → success is now legitimate.
    rerender({ status: "saved" });
    advance(500); // past MIN_SAVING_MS hold
    expect(pillLabel(result.current)).toBe("Saved");
  });

  it("saving → savedToProposal stuck past the grace fades WITHOUT 'Saved'", () => {
    const { result, rerender } = renderFor("saving");
    rerender({ status: "savedToProposal" });
    expect(pillLabel(result.current)).toBe("Saving");

    // Never reaches `saved`; the bounded confirm-grace expires → fade to hidden,
    // never claiming success.
    advance(1300); // past CONFIRM_GRACE_MS
    expect(result.current.phase).toBe("idle");
    expect(pillLabel(result.current)).toBeNull();
  });

  it("saving → offline never shows 'Saved'", () => {
    const { result, rerender } = renderFor("saving");
    rerender({ status: "offline" });

    // Offline is a definitive non-success → drop immediately, no "Saved".
    expect(result.current.phase).toBe("idle");
    expect(pillLabel(result.current)).toBeNull();

    // And it must not resurrect a success later.
    advance(2000);
    expect(pillLabel(result.current)).toBeNull();
  });

  it("updating → upToDate shows 'Up to date'", () => {
    const { result, rerender } = renderFor("updating");
    expect(pillLabel(result.current)).toBe("Updating");

    rerender({ status: "upToDate" });
    advance(500); // past MIN_SAVING_MS hold
    expect(pillLabel(result.current)).toBe("Up to date");
  });

  it("updating → idle does not claim success", () => {
    const { result, rerender } = renderFor("updating");
    rerender({ status: "idle" });

    // `idle` is not the inbound success rung → wait out the grace, fade to hidden.
    advance(1300);
    expect(result.current.phase).toBe("idle");
    expect(pillLabel(result.current)).toBeNull();
  });
});
