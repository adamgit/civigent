/**
 * Unit tests for the y-prosemirror attach-time echo guard: while armed, every
 * editor→fragment write is dropped. Disarm only from a real local edit
 * (`beforeinput`) or an explicit caller disarm.
 */

import { describe, it, expect } from "vitest";
import { markdownToProseMirrorNode, type ProseMirrorNode } from "@ks/milkdown-serializer";
import { installAttachEchoGuard } from "../../services/ysync-attach-echo-guard";

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

describe("installAttachEchoGuard", () => {
  it("drops every editor→fragment write while armed", () => {
    const binding = buildFakeBinding();
    installAttachEchoGuard({ binding });

    binding._prosemirrorChanged(markdownToProseMirrorNode(FRAGMENT_MARKDOWN));
    binding._prosemirrorChanged(markdownToProseMirrorNode("## Overview\n\nedited."));

    expect(binding.writes).toHaveLength(0);
  });

  it("writes through after an explicit disarm", () => {
    const binding = buildFakeBinding();
    const disarm = installAttachEchoGuard({ binding });

    disarm();
    const renderedDoc = markdownToProseMirrorNode(FRAGMENT_MARKDOWN);
    binding._prosemirrorChanged(renderedDoc);

    expect(binding.writes).toHaveLength(1);
  });

  it("is a no-op installer when the plugin state has no binding", () => {
    const disarm = installAttachEchoGuard(null);
    expect(typeof disarm).toBe("function");
    disarm();
  });
});
