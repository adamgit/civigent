import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  CRDTProposalGenerator,
  PublishTriggerPolicy,
  type LiveDocumentSource,
} from "../../crdt/crdt-proposal-generator.js";
import { BEFORE_FIRST_HEADING_KEY } from "../../crdt/ydoc-fragments.js";
import { ProposalAdoptionId, type WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = { id: "user-alice", type: "human", displayName: "Alice" };

const emptySource: LiveDocumentSource = {
  partitionLiveFragmentsByStructuralCleanliness: () => ({ materializableBodies: [], awaitingStructuralReconciliation: [] }),
};

function makeGenerator(): CRDTProposalGenerator {
  return new CRDTProposalGenerator({
    docPath: "guide.md",
    proposalAdoptionId: ProposalAdoptionId.create(),
    writer,
    source: emptySource,
  });
}

describe("CRDTProposalGenerator structural normalization (quiescence-driven)", () => {
  it("empty-document BFH bootstrap seeds the synthetic before-first-heading fragment inside a transaction", () => {
    const gen = makeGenerator();
    const ydoc = new Y.Doc();

    let txnOrigin: unknown = "not-run";
    ydoc.on("afterTransaction", (txn) => { txnOrigin = txn.origin; });

    gen.bootstrapEmptyDocument(ydoc, () => {
      const fragment = ydoc.getXmlFragment(BEFORE_FIRST_HEADING_KEY);
      const para = new Y.XmlElement("paragraph");
      fragment.insert(0, [para]);
    });

    expect(txnOrigin).not.toBe("not-run"); // a transaction actually ran
    expect(ydoc.getXmlFragment(BEFORE_FIRST_HEADING_KEY).length).toBe(1);
    ydoc.destroy();
  });

  it("runs the structural mutation inside a single Y.transact (atomic, no intermediate state)", async () => {
    const gen = makeGenerator();
    const ydoc = new Y.Doc();
    // Seed a section fragment.
    const frag = ydoc.getXmlFragment("section::sec_a");
    frag.insert(0, [new Y.XmlElement("paragraph")]);

    let transactionCount = 0;
    ydoc.on("afterTransaction", () => { transactionCount++; });
    const countBefore = transactionCount;

    // Orphan/predecessor convergence-style mutation: append a sibling fragment
    // as a precomputed delta, applied inside the transaction.
    const { applied } = await gen.normalizeQuiescedSection(
      ydoc,
      ["section::sec_a"],
      // computeDelta — runs OUTSIDE the transaction against a snapshot
      () => ({ newKey: "section::sec_b" }),
      // applyDelta — runs INSIDE the transaction
      (delta) => {
        const f = ydoc.getXmlFragment(delta.newKey);
        f.insert(0, [new Y.XmlElement("paragraph")]);
      },
    );

    expect(applied).toBe(true);
    expect(ydoc.getXmlFragment("section::sec_b").length).toBe(1);
    // Exactly one structural transaction was opened for the mutation.
    expect(transactionCount - countBefore).toBe(1);
    ydoc.destroy();
  });

  it("is a no-op when computeDelta returns null (already normalized)", async () => {
    const gen = makeGenerator();
    const ydoc = new Y.Doc();
    const { applied } = await gen.normalizeQuiescedSection(
      ydoc,
      ["section::sec_a"],
      () => null,
      () => { throw new Error("applyDelta must not run when delta is null"); },
    );
    expect(applied).toBe(false);
    ydoc.destroy();
  });

  it("aborts + retries on Y.Doc movement between snapshot and apply (optimistic concurrency)", async () => {
    const gen = makeGenerator();
    const ydoc = new Y.Doc();
    const frag = ydoc.getXmlFragment("section::sec_a");
    frag.insert(0, [new Y.XmlElement("paragraph")]);

    let computeCalls = 0;
    const { applied } = await gen.normalizeQuiescedSection(
      ydoc,
      ["section::sec_a"],
      () => {
        computeCalls++;
        // On the first compute, mutate the doc AFTER snapshot so the pre-flight
        // clock check inside the transaction detects movement and aborts. On the
        // retry, leave it stable so the apply succeeds.
        if (computeCalls === 1) {
          ydoc.getXmlFragment("section::sec_a").insert(0, [new Y.XmlElement("paragraph")]);
        }
        return { ok: true };
      },
      () => {
        ydoc.getXmlFragment("section::sec_normalized").insert(0, [new Y.XmlElement("paragraph")]);
      },
    );

    // It retried at least once (first attempt detected movement).
    expect(computeCalls).toBeGreaterThanOrEqual(2);
    expect(applied).toBe(true);
    ydoc.destroy();
  });

  it("PublishTriggerPolicy quiescence threshold gates fragment quietness", () => {
    const policy = new PublishTriggerPolicy({ quiescenceThresholdMs: 2000 });
    const now = 10_000;
    expect(policy.isFragmentQuiescent(now - 500, now)).toBe(false);
    expect(policy.isFragmentQuiescent(now - 2500, now)).toBe(true);
  });
});
