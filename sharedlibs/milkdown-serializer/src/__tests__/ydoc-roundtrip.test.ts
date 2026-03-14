/**
 * Phase 1D, 1E — Yjs / y-prosemirror round-trip and concurrent editing tests.
 *
 * These encode upstream assumptions about y-prosemirror and Yjs CRDT behaviour.
 * If those packages diverge, these tests provide early warning.
 *
 * TDD: implementation pending Phase 1.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  prosemirrorToYDoc,
  yDocToProsemirrorJSON,
} from "y-prosemirror";
import { Node as ProseMirrorNode } from "@milkdown/prose/model";
import {
  markdownToProseMirrorNode,
  proseMirrorNodeToMarkdown,
  getSchema,
} from "../index.js";

// ─── helpers ───────────────────────────────────────────────

function mdViaYDoc(md: string): string {
  const schema = getSchema() as import("@milkdown/prose/model").Schema;
  const pmNode = markdownToProseMirrorNode(md) as ProseMirrorNode;
  const ydoc = prosemirrorToYDoc(pmNode, "prosemirror");
  const json = yDocToProsemirrorJSON(ydoc, "prosemirror");
  const reconstructed = ProseMirrorNode.fromJSON(schema, json);
  return proseMirrorNodeToMarkdown(reconstructed);
}

function mdDirect(md: string): string {
  const node = markdownToProseMirrorNode(md);
  return proseMirrorNodeToMarkdown(node);
}

/** Sync all updates from src to dst. */
function syncYDocs(src: Y.Doc, dst: Y.Doc): void {
  const update = Y.encodeStateAsUpdate(src);
  Y.applyUpdate(dst, update);
}

// ─── 1D: Upstream assumption encoding (y-prosemirror) ─────────

describe("1D: y-prosemirror round-trip assumptions", () => {
  const testDoc = `# Hello World

This is a **test** with *formatting* and \`code\`.

## Section Two

* Item one
* Item two

Some more text.
`;

  it("md → PM → Y.Doc → PM → md matches md → PM → md", () => {
    expect(mdViaYDoc(testDoc)).toBe(mdDirect(testDoc));
  });

  it("second Y.Doc round-trip is identical to first", () => {
    const schema = getSchema() as import("@milkdown/prose/model").Schema;
    const first = mdViaYDoc(testDoc);
    const pmNode = markdownToProseMirrorNode(first) as ProseMirrorNode;
    const ydoc2 = prosemirrorToYDoc(pmNode, "prosemirror");
    const json2 = yDocToProsemirrorJSON(ydoc2, "prosemirror");
    const node2 = ProseMirrorNode.fromJSON(schema, json2);
    const second = proseMirrorNodeToMarkdown(node2);
    expect(second).toBe(first);
  });

  it("two Y.Docs initialized from same update produce identical PM JSON", () => {
    const pmNode = markdownToProseMirrorNode(testDoc) as ProseMirrorNode;
    const source = prosemirrorToYDoc(pmNode, "prosemirror");
    const update = Y.encodeStateAsUpdate(source);

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    Y.applyUpdate(docA, update);
    Y.applyUpdate(docB, update);

    const jsonA = yDocToProsemirrorJSON(docA, "prosemirror");
    const jsonB = yDocToProsemirrorJSON(docB, "prosemirror");
    expect(jsonA).toEqual(jsonB);
  });

  it("encodeStateAsUpdate → applyUpdate to fresh doc → same PM JSON", () => {
    const pmNode = markdownToProseMirrorNode(testDoc) as ProseMirrorNode;
    const original = prosemirrorToYDoc(pmNode, "prosemirror");
    const originalJson = yDocToProsemirrorJSON(original, "prosemirror");

    const update = Y.encodeStateAsUpdate(original);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, update);
    const freshJson = yDocToProsemirrorJSON(fresh, "prosemirror");

    expect(freshJson).toEqual(originalJson);
  });

  it("Node.fromJSON reconstructs a valid PM doc from Y.Doc JSON", () => {
    const schema = getSchema() as import("@milkdown/prose/model").Schema;
    const pmNode = markdownToProseMirrorNode(testDoc) as ProseMirrorNode;
    const ydoc = prosemirrorToYDoc(pmNode, "prosemirror");
    const json = yDocToProsemirrorJSON(ydoc, "prosemirror");

    const reconstructed = ProseMirrorNode.fromJSON(schema, json);
    expect(reconstructed).toBeDefined();
    expect(reconstructed.type.name).toBe("doc");
    expect(reconstructed.content.size).toBeGreaterThan(0);
  });

  it("all node types survive Y.Doc round-trip", () => {
    const comprehensive = `# Heading

Paragraph text.

* List item

1. Ordered item

\`\`\`js
code
\`\`\`

> Blockquote

***

![alt](https://example.com/img.png "title")

| Col A | Col B |
| --- | --- |
| 1 | 2 |
`;
    const direct = mdDirect(comprehensive);
    const viaYDoc = mdViaYDoc(comprehensive);
    expect(viaYDoc).toBe(direct);
  });

  it("all mark types survive Y.Doc round-trip", () => {
    const marks = "**bold** *italic* `code` [link](https://example.com) ~~strike~~\n";
    const direct = mdDirect(marks);
    const viaYDoc = mdViaYDoc(marks);
    expect(viaYDoc).toBe(direct);
  });

  it("node attrs (heading level, code language, link href, image src) survive Y.Doc round-trip", () => {
    const withAttrs = `### Level 3 Heading

\`\`\`python
print("hello")
\`\`\`

[Click](https://example.com "Title")

![Alt text](https://img.example.com/pic.jpg "Img title")
`;
    const direct = mdDirect(withAttrs);
    const viaYDoc = mdViaYDoc(withAttrs);
    expect(viaYDoc).toBe(direct);
  });
});

// ─── 1E: Concurrent editing simulation (Yjs core assumptions) ──

describe("1E: Yjs concurrent editing assumptions", () => {
  it("two docs: A inserts at start, B inserts at end → merge has both", () => {
    const ydocA = new Y.Doc();
    const ydocB = new Y.Doc();

    // Initialize both with same content
    const textA = ydocA.getText("test");
    textA.insert(0, "middle");
    syncYDocs(ydocA, ydocB);

    // A inserts at start, B inserts at end (concurrently)
    ydocA.getText("test").insert(0, "START ");
    ydocB.getText("test").insert(ydocB.getText("test").length, " END");

    // Sync both ways
    syncYDocs(ydocA, ydocB);
    syncYDocs(ydocB, ydocA);

    const resultA = ydocA.getText("test").toString();
    const resultB = ydocB.getText("test").toString();

    expect(resultA).toBe(resultB);
    expect(resultA).toContain("START");
    expect(resultA).toContain("middle");
    expect(resultA).toContain("END");
  });

  it("two docs: concurrent insert at same position → both present, no loss", () => {
    const ydocA = new Y.Doc();
    const ydocB = new Y.Doc();

    const textA = ydocA.getText("test");
    textA.insert(0, "base");
    syncYDocs(ydocA, ydocB);

    // Both insert at position 2 concurrently
    ydocA.getText("test").insert(2, "AAA");
    ydocB.getText("test").insert(2, "BBB");

    syncYDocs(ydocA, ydocB);
    syncYDocs(ydocB, ydocA);

    const resultA = ydocA.getText("test").toString();
    const resultB = ydocB.getText("test").toString();

    expect(resultA).toBe(resultB);
    expect(resultA).toContain("AAA");
    expect(resultA).toContain("BBB");
    // "base" is split by concurrent inserts at position 2 (e.g. "baAAABBBse")
    // All original characters are present, just interleaved
    expect(resultA).toContain("ba");
    expect(resultA).toContain("se");
  });

  it("A deletes a range, B edits within that range → consistent result, no crash", () => {
    const ydocA = new Y.Doc();
    const ydocB = new Y.Doc();

    const textA = ydocA.getText("test");
    textA.insert(0, "hello world");
    syncYDocs(ydocA, ydocB);

    // A deletes "world" (positions 6–11)
    ydocA.getText("test").delete(6, 5);
    // B inserts inside the deleted range
    ydocB.getText("test").insert(8, "XYZ");

    syncYDocs(ydocA, ydocB);
    syncYDocs(ydocB, ydocA);

    const resultA = ydocA.getText("test").toString();
    const resultB = ydocB.getText("test").toString();

    // Both must converge to the same value
    expect(resultA).toBe(resultB);
    // The result should be consistent (no crash, no corruption)
    expect(typeof resultA).toBe("string");
  });

  it("sync A→B then B→A → both docs identical", () => {
    const ydocA = new Y.Doc();
    const ydocB = new Y.Doc();

    ydocA.getText("test").insert(0, "from A");
    ydocB.getText("test").insert(0, "from B");

    syncYDocs(ydocA, ydocB);
    syncYDocs(ydocB, ydocA);

    expect(ydocA.getText("test").toString()).toBe(
      ydocB.getText("test").toString()
    );
  });

  it("100 rapid edits from A sync to B without loss", () => {
    const ydocA = new Y.Doc();
    const ydocB = new Y.Doc();

    const text = ydocA.getText("test");
    for (let i = 0; i < 100; i++) {
      text.insert(text.length, `edit${i} `);
    }

    syncYDocs(ydocA, ydocB);

    const resultB = ydocB.getText("test").toString();
    for (let i = 0; i < 100; i++) {
      expect(resultB).toContain(`edit${i}`);
    }
  });

  it("three docs: A↔B, B↔C → A and C converge", () => {
    const ydocA = new Y.Doc();
    const ydocB = new Y.Doc();
    const ydocC = new Y.Doc();

    ydocA.getText("test").insert(0, "from A ");
    ydocC.getText("test").insert(0, "from C ");

    // A → B
    syncYDocs(ydocA, ydocB);
    // C → B
    syncYDocs(ydocC, ydocB);
    // B → A
    syncYDocs(ydocB, ydocA);
    // B → C
    syncYDocs(ydocB, ydocC);

    const resultA = ydocA.getText("test").toString();
    const resultC = ydocC.getText("test").toString();

    expect(resultA).toBe(resultC);
    expect(resultA).toContain("from A");
    expect(resultA).toContain("from C");
  });
});
