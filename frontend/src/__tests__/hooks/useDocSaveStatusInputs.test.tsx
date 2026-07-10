/**
 * useDocSaveStatusInputs — the "mine-now" axis is session authorship, not writer
 * id. These tests pin the two scenarios the writer-id basis got wrong, end to
 * end through the real store, a real EphemeralSessionAuthorshipLedger, and the
 * (unchanged) resolveTransportStatus resolver:
 *
 *   (a) work stranded from a PREVIOUS session — same writer id, but the ledger
 *       is empty on open — must read as inbound (updating → upToDate), never as
 *       your save (savedToProposal/saving/saved).
 *   (b) a real local edit THIS session — the ledger records the fragment — still
 *       walks the full local ladder (syncing → savedToProposal → saving → saved).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BrowserFragmentReplicaStore } from "../../services/browser-fragment-replica-store.js";
import { resolveTransportStatus } from "../../services/section-save-state.js";
import { useDocSaveStatusInputs } from "../../hooks/useDocSaveStatusInputs.js";
import { EphemeralSessionAuthorshipLedger } from "../../status/sessionAuthorship.js";

const FRAG_A = "section::alpha";
// The default resolveWriterId() value — using it as the pending author proves
// the OLD writer-id filter would have matched (and mislabeled), while the ledger
// correctly does not.
const MY_WRITER_ID = "human-ui";

type Inputs = ReturnType<typeof useDocSaveStatusInputs>;

/** Resolve the topbar rung from the live hook inputs + a transport overlay. */
function rung(inputs: Inputs, opts: { publishPaused?: boolean } = {}): string {
  return resolveTransportStatus(
    "connected",
    opts.publishPaused ?? false,
    true, // isEditing
    inputs.allReceived,
    inputs.hasLocalUncommittedEdits,
    inputs.hasInboundActivity,
    inputs.hadLocalEdits,
    inputs.backendError,
  );
}

describe("useDocSaveStatusInputs (session-authorship basis)", () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  let store: BrowserFragmentReplicaStore;

  beforeEach(() => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    store = new BrowserFragmentReplicaStore(doc, awareness);
    store.setConnectionState("connected");
  });

  afterEach(() => {
    awareness.destroy();
    doc.destroy();
  });

  it("(a) stranded same-writer pending on open (ledger empty) → updating then upToDate", () => {
    const ledger = new EphemeralSessionAuthorshipLedger();
    const { result } = renderHook(() => useDocSaveStatusInputs(store, true, ledger));

    // Stranded work replays as section:pending carrying OUR own writer id — but
    // this session never authored it, so the ledger stays empty.
    act(() => {
      store.setSectionPending(FRAG_A, { writerId: MY_WRITER_ID, writerDisplayName: "You" });
    });

    expect(result.current.hasLocalUncommittedEdits).toBe(false);
    expect(result.current.hasInboundActivity).toBe(true);
    expect(result.current.hasLocalEdits).toBe(false);
    expect(result.current.hadLocalEdits).toBe(false);

    // During the inbound commit's publish pause → updating, never saving.
    expect(rung(result.current, { publishPaused: true })).toBe("updating");
    // Pause ended, inbound pending still present → upToDate, never your save.
    const resting = rung(result.current);
    expect(resting).toBe("upToDate");
    expect(resting).not.toBe("savedToProposal");
    expect(resting).not.toBe("saving");
    expect(resting).not.toBe("saved");
  });

  it("(b) a real local edit this session walks syncing → savedToProposal → saving → saved", () => {
    const ledger = new EphemeralSessionAuthorshipLedger();
    const { result } = renderHook(() => useDocSaveStatusInputs(store, true, ledger));

    // The producer side fired: this session authored FRAG_A.
    ledger.recordLocalEdit(FRAG_A);

    // In flight to the server (receipt watermark behind).
    act(() => { store.setReceiptAllReceived(false); });
    expect(rung(result.current)).toBe("syncing");

    // Received, but the inprogress proposal still holds your edits.
    act(() => {
      store.setReceiptAllReceived(true);
      store.setSectionPending(FRAG_A, { writerId: MY_WRITER_ID, writerDisplayName: "You" });
    });
    expect(result.current.hasLocalUncommittedEdits).toBe(true);
    expect(result.current.hasInboundActivity).toBe(false);
    expect(rung(result.current)).toBe("savedToProposal");

    // The commit runs for your edits.
    expect(rung(result.current, { publishPaused: true })).toBe("saving");

    // Committed and clean — the sticky flag keeps it on "saved", not "idle".
    act(() => { store.setSectionSettled(FRAG_A); });
    expect(result.current.hadLocalEdits).toBe(true);
    expect(rung(result.current)).toBe("saved");
  });

  it("(c) a backend-reported error surfaces as `error` and does NOT collapse into savedToProposal / saved / upToDate", () => {
    const ledger = new EphemeralSessionAuthorshipLedger();
    const { result } = renderHook(() => useDocSaveStatusInputs(store, true, ledger));

    // Local edit lands: server acknowledged AND wrote it into the inprogress proposal.
    ledger.recordLocalEdit(FRAG_A);
    act(() => {
      store.setReceiptAllReceived(true);
      store.setSectionPending(FRAG_A, { writerId: MY_WRITER_ID, writerDisplayName: "You" });
    });
    expect(rung(result.current)).toBe("savedToProposal");

    // The server subsequently reports a materialize/normalize/validate/publish
    // failure. The topbar must switch to `error` — hiding this under
    // savedToProposal would tell the user their work is safe when it is not.
    act(() => { store.setError("normalization failed: duplicate heading"); });
    expect(result.current.backendError).toBe("normalization failed: duplicate heading");
    expect(rung(result.current)).toBe("error");

    // The error does not get masked when the pause is running or after the
    // sticky "you-saved-this-session" flag has latched.
    expect(rung(result.current, { publishPaused: true })).toBe("error");
    act(() => { store.setSectionSettled(FRAG_A); });
    expect(rung(result.current)).toBe("error");

    // Once the backend clears the error, the ladder resumes at its true rung.
    act(() => { store.setError(null); });
    expect(rung(result.current)).toBe("saved");
  });
});
