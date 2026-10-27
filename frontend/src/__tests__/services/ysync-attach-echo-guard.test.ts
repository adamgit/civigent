/**
 * Attach echo guard.
 *
 * A document whose markdown differs from the fragment is written through
 * while the latch is still shut, and a later change is written too.
 * Markdown that matches the fragment is not written.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { updateYFragment } from "y-prosemirror";
import { markdownToProseMirrorNode, type ProseMirrorNode } from "@ks/milkdown-serializer";
import { installAttachEchoGuard } from "../../services/ysync-attach-echo-guard";

const FRAGMENT_KEY = "section::overview";
const FRAGMENT_MARKDOWN = "## Overview\n\nsome body text.";

interface FakeBinding {
  _prosemirrorChanged: (doc: ProseMirrorNode) => void;
  writes: ProseMirrorNode[];
}

function buildFakeBinding(): FakeBinding {
  const writes: ProseMirrorNode[] = [];
  return {
    writes,
    _prosemirrorChanged(doc: ProseMirrorNode) {
      writes.push(doc);
    },
  };
}

function seededFragment(): { doc: Y.Doc; node: ProseMirrorNode } {
  const doc = new Y.Doc();
  const node = markdownToProseMirrorNode(FRAGMENT_MARKDOWN);
  const fragment = doc.getXmlFragment(FRAGMENT_KEY);
  doc.transact(() => {
    updateYFragment(doc, fragment, node, { mapping: new Map(), isOMark: new Map() });
  });
  return { doc, node };
}

function install(
  binding: FakeBinding,
  doc: Y.Doc,
): () => void {
  return installAttachEchoGuard({ binding }, doc, FRAGMENT_KEY);
}

describe("installAttachEchoGuard", () => {
  it("writes a changed document through while the latch is shut, then the next change too", () => {
    const { doc } = seededFragment();
    const binding = buildFakeBinding();
    install(binding, doc);

    const edited = markdownToProseMirrorNode("## Overview\n\nedited.");
    const editedAgain = markdownToProseMirrorNode("## Overview\n\nedited again.");
    binding._prosemirrorChanged(edited);
    binding._prosemirrorChanged(editedAgain);

    expect(binding.writes).toEqual([edited, editedAgain]);
  });

  it("does not write markdown that matches the fragment", () => {
    const { doc, node } = seededFragment();
    const binding = buildFakeBinding();
    install(binding, doc);

    binding._prosemirrorChanged(node);

    expect(binding.writes).toHaveLength(0);
  });

  it("writes through after an explicit disarm", () => {
    const binding = buildFakeBinding();
    const disarm = installAttachEchoGuard({ binding }, new Y.Doc(), FRAGMENT_KEY);

    disarm();
    const renderedDoc = markdownToProseMirrorNode(FRAGMENT_MARKDOWN);
    binding._prosemirrorChanged(renderedDoc);

    expect(binding.writes).toHaveLength(1);
  });

  it("is a no-op installer when the plugin state has no binding", () => {
    const disarm = installAttachEchoGuard(null, new Y.Doc(), FRAGMENT_KEY);
    expect(typeof disarm).toBe("function");
    disarm();
  });
});
