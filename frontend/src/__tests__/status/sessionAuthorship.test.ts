/**
 * EphemeralSessionAuthorshipLedger — the client-side "did THIS session author
 * this fragment" signal that replaces the writer-id basis for the save-status
 * ladder. These tests pin its behaviour AND its deliberately minimal surface:
 * the only readout is a boolean, so there is nothing to serialize, persist, or
 * push onto the wire (the architecture constraint that keeps this a pure
 * presentation artifact).
 */

import { describe, it, expect } from "vitest";
import {
  EphemeralSessionAuthorshipLedger,
  type LocalEditOriginSink,
  type SessionAuthorshipView,
} from "../../status/sessionAuthorship.js";

const FRAG_A = "section::alpha";
const FRAG_B = "section::beta";

describe("EphemeralSessionAuthorshipLedger", () => {
  it("a fresh ledger has authored nothing (open-with-stranded-work reads empty)", () => {
    const ledger = new EphemeralSessionAuthorshipLedger();
    expect(ledger.wasAuthoredThisSession(FRAG_A)).toBe(false);
    expect(ledger.wasAuthoredThisSession(FRAG_B)).toBe(false);
  });

  it("records a locally-authored fragment and reports only that one", () => {
    const ledger = new EphemeralSessionAuthorshipLedger();
    ledger.recordLocalEdit(FRAG_A);
    expect(ledger.wasAuthoredThisSession(FRAG_A)).toBe(true);
    expect(ledger.wasAuthoredThisSession(FRAG_B)).toBe(false);
  });

  it("recording the same fragment twice is idempotent", () => {
    const ledger = new EphemeralSessionAuthorshipLedger();
    ledger.recordLocalEdit(FRAG_A);
    ledger.recordLocalEdit(FRAG_A);
    expect(ledger.wasAuthoredThisSession(FRAG_A)).toBe(true);
  });

  describe("port segregation — only the two methods are reachable (item 7c)", () => {
    it("the read-only view exposes no write method, the write-only sink no read method", () => {
      const ledger = new EphemeralSessionAuthorshipLedger();
      const view: SessionAuthorshipView = ledger;
      const sink: LocalEditOriginSink = ledger;

      // @ts-expect-error — the read-only view cannot record edits.
      view.recordLocalEdit;
      // @ts-expect-error — the write-only sink cannot read authorship.
      sink.wasAuthoredThisSession;

      // The view's sole readout is a boolean — there is no serialization surface
      // to push onto the wire or into storage.
      // @ts-expect-error — no toJSON exists on the view.
      view.toJSON;
      // @ts-expect-error — no snapshot/key enumeration exists on the view.
      view.snapshot;

      expect(view.wasAuthoredThisSession(FRAG_A)).toBe(false);
      void sink;
    });

    it("the concrete ledger carries no toJSON/snapshot/encode readout", () => {
      const ledger = new EphemeralSessionAuthorshipLedger() as unknown as Record<string, unknown>;
      expect(ledger.toJSON).toBeUndefined();
      expect(ledger.snapshot).toBeUndefined();
      expect(ledger.encode).toBeUndefined();
    });
  });
});
