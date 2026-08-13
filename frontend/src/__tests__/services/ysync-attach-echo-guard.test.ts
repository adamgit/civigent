/**
 * Unit tests for the y-prosemirror attach-time echo guard: CRDT attachment must
 * not clear and repopulate a populated Y.XmlFragment when its Markdown already
 * matches the editor state, and must write through as soon as the editor
 * genuinely diverges (or the caller disarms on a real local edit).
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { prosemirrorJSONToYDoc } from "y-prosemirror";
import { Schema } from "prosemirror-model";
import {
  markdownToJSON,
  markdownToProseMirrorNode,
  getSchemaSpec,
  type ProseMirrorNode,
} from "@ks/milkdown-serializer";
import { installAttachEchoGuard } from "../../services/ysync-attach-echo-guard";

const FRAGMENT_KEY = "section::overview";
const FRAGMENT_MARKDOWN = "## Overview\n\nsome body text.";

const localSchema = new Schema(getSchemaSpec());

function buildYDocWithFragment(markdown: string): Y.Doc {
  const seeded = prosemirrorJSONToYDoc(localSchema, markdownToJSON(markdown), FRAGMENT_KEY);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seeded));
  seeded.destroy();
  return doc;
}

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

describe("installAttachEchoGuard", () => {
  it("skips the editor→fragment write while markdown matches the fragment", () => {
    const ydoc = buildYDocWithFragment(FRAGMENT_MARKDOWN);
    const binding = buildFakeBinding();
    installAttachEchoGuard({ binding }, ydoc, FRAGMENT_KEY);

    const renderedDoc = markdownToProseMirrorNode(FRAGMENT_MARKDOWN);
    binding._prosemirrorChanged(renderedDoc);
    binding._prosemirrorChanged(renderedDoc);

    expect(binding.writes).toHaveLength(0);
  });

  it("writes through and disarms on genuine divergence", () => {
    const ydoc = buildYDocWithFragment(FRAGMENT_MARKDOWN);
    const binding = buildFakeBinding();
    installAttachEchoGuard({ binding }, ydoc, FRAGMENT_KEY);

    const renderedDoc = markdownToProseMirrorNode(FRAGMENT_MARKDOWN);
    binding._prosemirrorChanged(renderedDoc);
    expect(binding.writes).toHaveLength(0);

    const editedDoc = markdownToProseMirrorNode("## Overview\n\nsome body text, edited.");
    binding._prosemirrorChanged(editedDoc);
    expect(binding.writes).toHaveLength(1);

    const matchingAgain = markdownToProseMirrorNode(FRAGMENT_MARKDOWN);
    binding._prosemirrorChanged(matchingAgain);
    expect(binding.writes).toHaveLength(2);
  });

  it("writes through after an explicit disarm even when markdown matches", () => {
    const ydoc = buildYDocWithFragment(FRAGMENT_MARKDOWN);
    const binding = buildFakeBinding();
    const disarm = installAttachEchoGuard({ binding }, ydoc, FRAGMENT_KEY);

    disarm();
    const renderedDoc = markdownToProseMirrorNode(FRAGMENT_MARKDOWN);
    binding._prosemirrorChanged(renderedDoc);

    expect(binding.writes).toHaveLength(1);
  });

  it("skips writes for a matching fragment containing a duplicate heading (corrupt-but-unchanged state)", () => {
    const corrupt = "## Overview\n\nfirst body\n\n## Overview\n\nsecond body";
    const ydoc = buildYDocWithFragment(corrupt);
    const binding = buildFakeBinding();
    installAttachEchoGuard({ binding }, ydoc, FRAGMENT_KEY);

    binding._prosemirrorChanged(markdownToProseMirrorNode(corrupt));

    expect(binding.writes).toHaveLength(0);
  });

  it("is a no-op installer when the plugin state has no binding", () => {
    const ydoc = buildYDocWithFragment(FRAGMENT_MARKDOWN);
    const disarm = installAttachEchoGuard(null, ydoc, FRAGMENT_KEY);
    expect(typeof disarm).toBe("function");
    disarm();
  });
});
