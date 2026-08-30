/**
 * `applyClientUpdate` must report exactly the fragment keys an update altered.
 *
 * The DocSession actor uses this set as the single source of truth for
 * per-section activity, so a key missing from it is an accepted edit that is
 * broadcast to every peer and never materialized into the `inprogress`
 * proposal — silent, and invisible until the Y.Doc is discarded.
 *
 * Two arrivals exercise the same contract:
 *   T1 — a key that entered `ydoc.share` as an untyped placeholder (created by
 *        `Y.applyUpdate`, not by a server-side `getXmlFragment`) and was later
 *        swapped by the server's own typed read.
 *   T2 — a key appearing for the very first time in an inbound update.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { DocPath } from "../../types/shared.js";
import type { FragmentContent } from "../../storage/section-formatting.js";

const DOC = DocPath.parse("/test/touched-key-attribution.md");

function clientUpdateWriting(baseDoc: Y.Doc, fragmentKey: string, content: string): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(baseDoc));
  const tempStore = new LiveFragmentStringsStore(temp, [fragmentKey], DOC);
  tempStore.replaceFragmentString(fragmentKey, content as FragmentContent);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(baseDoc));
  temp.destroy();
  return update;
}

describe("touched fragment key attribution", () => {
  it("T1: a key whose typed read swapped its identity still attributes on later edits", () => {
    const doc = new Y.Doc();
    const store = new LiveFragmentStringsStore(doc, ["k1"], DOC);

    store.applyClientUpdate("w", clientUpdateWriting(doc, "k1", "first"), null);

    // The server's own markdown read types the fragment, which replaces the
    // object sitting in `ydoc.share` without changing `share.size`.
    store.readFragmentString("k1");

    const touched = store.applyClientUpdate("w", clientUpdateWriting(doc, "k1", "second"), null);

    expect([...touched]).toEqual(["k1"]);
  });

  it("T2: a key appearing for the first time in an inbound update is attributed", () => {
    const doc = new Y.Doc();
    const store = new LiveFragmentStringsStore(doc, [], DOC);

    const touched = store.applyClientUpdate("w", clientUpdateWriting(doc, "k2", "hello"), null);

    expect([...touched]).toEqual(["k2"]);
  });
});
