/**
 * Shared Milkdown serializer module.
 *
 * Provides headless markdown ↔ ProseMirror conversion using the same schema
 * and remark config as the browser Milkdown editor. Runs in Node with zero
 * DOM dependencies.
 *
 * Extracted from the Phase 0 feasibility spike.
 */

import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import remarkInlineLinks from "remark-inline-links";
import { visit } from "unist-util-visit";
import { visitParents } from "unist-util-visit-parents";
import {
  Schema,
  Node as ProseMirrorNode,
  Fragment,
} from "@milkdown/prose/model";
import { ParserState, SerializerState } from "@milkdown/transformer";

// Re-export for consumer convenience (used by ydoc-roundtrip tests etc.)
export { Schema, Node as ProseMirrorNode, Fragment } from "@milkdown/prose/model";

// ─────────────────────────────────────────────────────────
// Remark Plugins (extracted from @milkdown/preset-commonmark)
// ─────────────────────────────────────────────────────────

/** Strips <br /> HTML nodes used to preserve empty lines */
function remarkPreserveEmptyLine() {
  return (ast: any) => {
    visitParents(
      ast,
      (node: any) =>
        node.type === "html" &&
        ["<br />", "<br>", "<br >", "<br/>"].includes(node.value?.trim()),
      (node: any, parents: any[]) => {
        if (!parents.length) return;
        const parent = parents[parents.length - 1];
        if (!parent) return;
        const index = parent.children.indexOf(node);
        if (index === -1) return;
        parent.children.splice(index, 1);
      },
      true,
    );
  };
}

/** Adds numeric labels to ordered list items */
function remarkAddOrderInList() {
  return (tree: any) => {
    visit(tree, "list", (node: any) => {
      if (node.ordered) {
        const start = node.start ?? 1;
        node.children.forEach((child: any, index: number) => {
          child.label = index + start;
        });
      }
    });
  };
}

/** Converts soft line breaks to break nodes */
function remarkLineBreak() {
  return (tree: any) => {
    const find = /[\t ]*(?:\r?\n|\r)/g;
    visit(tree, "text", (node: any, index: any, parent: any) => {
      if (!node.value || typeof node.value !== "string") return;
      const result: any[] = [];
      let start = 0;
      find.lastIndex = 0;
      let match = find.exec(node.value);
      while (match) {
        const position = match.index;
        if (start !== position)
          result.push({
            type: "text",
            value: node.value.slice(start, position),
          });
        result.push({ type: "break" });
        start = position + match[0].length;
        match = find.exec(node.value);
      }
      if (result.length > 0 && parent && typeof index === "number") {
        if (start < node.value.length)
          result.push({ type: "text", value: node.value.slice(start) });
        parent.children.splice(index, 1, ...result);
        return index + result.length;
      }
    });
  };
}

/** Wraps inline HTML in paragraph when inside block containers */
// Note: 'root' is intentionally excluded. Root-level HTML blocks should remain
// as block-level html nodes, not be wrapped in paragraphs (which expect inline content).
const BLOCK_CONTAINER_TYPES = [
  "blockquote",
  "listItem",
  "footnoteDefinition",
];
function remarkHtmlTransformer() {
  return (tree: any) => {
    flatMapWithDepth(tree, (node: any, _index: number, parent: any) => {
      if (node.type !== "html") return [node];
      if (parent && BLOCK_CONTAINER_TYPES.includes(parent.type)) {
        node.children = [{ ...node }];
        delete node.value;
        node.type = "paragraph";
      }
      return [node];
    });
  };
}

function flatMapWithDepth(
  ast: any,
  fn: (node: any, index: number, parent: any) => any[],
): any {
  return transform(ast, 0, null)[0];
  function transform(node: any, index: number, parent: any): any[] {
    if (node.children) {
      const out: any[] = [];
      for (let i = 0, n = node.children.length; i < n; i++) {
        const nthChild = node.children[i];
        if (nthChild) {
          const xs = transform(nthChild, i, node);
          if (xs) {
            for (let j = 0, m = xs.length; j < m; j++) {
              out.push(xs[j]);
            }
          }
        }
      }
      node.children = out;
    }
    return fn(node, index, parent);
  }
}

/** Annotates emphasis/strong nodes with their original marker character */
function remarkMarker() {
  return (tree: any, file: any) => {
    const getMarker = (node: any) => {
      if (!node.position?.start?.offset) return "*";
      return file.value.charAt(node.position.start.offset);
    };
    visit(
      tree,
      (node: any) => ["strong", "emphasis"].includes(node.type),
      (node: any) => {
        node.marker = getMarker(node);
      },
    );
  };
}

// ─────────────────────────────────────────────────────────
// Custom remark-stringify handlers (from @milkdown/core)
// ─────────────────────────────────────────────────────────

const remarkHandlers = {
  text: (node: any, _: any, state: any, info: any) => {
    const value = node.value;
    if (/^[^*_\\]*\s+$/.test(value)) {
      return value;
    }
    const escaped = state.safe(value, { ...info, encode: [] });
    // GFM: underscores between word characters don't trigger emphasis,
    // so undo unnecessary backslash-escaping of word-internal underscores.
    return escaped.replace(/(?<=\w)\\_(?=\w)/g, "_");
  },
  strong: (node: any, _: any, state: any, info: any) => {
    const marker = node.marker || state.options.strong || "*";
    const exit = state.enter("strong");
    const tracker = state.createTracker(info);
    let value = tracker.move(marker + marker);
    value += tracker.move(
      state.containerPhrasing(node, {
        before: value,
        after: marker,
        ...tracker.current(),
      }),
    );
    value += tracker.move(marker + marker);
    exit();
    return value;
  },
  emphasis: (node: any, _: any, state: any, info: any) => {
    const marker = node.marker || state.options.emphasis || "*";
    const exit = state.enter("emphasis");
    const tracker = state.createTracker(info);
    let value = tracker.move(marker);
    value += tracker.move(
      state.containerPhrasing(node, {
        before: value,
        after: marker,
        ...tracker.current(),
      }),
    );
    value += tracker.move(marker);
    exit();
    return value;
  },
};

// ─────────────────────────────────────────────────────────
// ProseMirror Schema (matching Milkdown presets)
// ─────────────────────────────────────────────────────────

function serializeText(state: any, node: any) {
  const lastIsHardBreak =
    node.childCount >= 1 && node.lastChild?.type.name === "hardbreak";
  if (!lastIsHardBreak) {
    state.next(node.content);
    return;
  }
  const contentArr: any[] = [];
  node.content.forEach((n: any, _: any, i: number) => {
    if (i === node.childCount - 1) return;
    contentArr.push(n);
  });
  state.next(Fragment.fromArray(contentArr));
}

const schemaSpec = {
  nodes: {
    doc: {
      content: "block+",
      parseMarkdown: {
        match: (node: any) => node.type === "root",
        runner: (state: any, node: any, type: any) => {
          state.injectRoot(node, type);
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "doc",
        runner: (state: any, node: any) => {
          state.openNode("root");
          state.next(node.content);
        },
      },
    },
    paragraph: {
      content: "inline*",
      group: "block",
      parseMarkdown: {
        match: (node: any) => node.type === "paragraph",
        runner: (state: any, node: any, type: any) => {
          state.openNode(type);
          if (node.children) state.next(node.children);
          state.closeNode();
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "paragraph",
        runner: (state: any, node: any) => {
          state.openNode("paragraph");
          serializeText(state, node);
          state.closeNode();
        },
      },
    },
    heading: {
      content: "inline*",
      group: "block",
      attrs: {
        level: { default: 1 },
        id: { default: "" },
      },
      defining: true,
      parseMarkdown: {
        match: (node: any) => node.type === "heading",
        runner: (state: any, node: any, type: any) => {
          state.openNode(type, { level: node.depth });
          state.next(node.children);
          state.closeNode();
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "heading",
        runner: (state: any, node: any) => {
          state.openNode("heading", undefined, { depth: node.attrs.level });
          serializeText(state, node);
          state.closeNode();
        },
      },
    },
    blockquote: {
      content: "block+",
      group: "block",
      defining: true,
      parseMarkdown: {
        match: (node: any) => node.type === "blockquote",
        runner: (state: any, node: any, type: any) => {
          state.openNode(type).next(node.children).closeNode();
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "blockquote",
        runner: (state: any, node: any) => {
          state.openNode("blockquote").next(node.content).closeNode();
        },
      },
    },
    code_block: {
      content: "text*",
      group: "block",
      marks: "",
      defining: true,
      code: true,
      attrs: {
        language: { default: "" },
      },
      parseMarkdown: {
        match: (node: any) => node.type === "code",
        runner: (state: any, node: any, type: any) => {
          state.openNode(type, { language: node.lang || "" });
          if (node.value) state.addText(node.value);
          state.closeNode();
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "code_block",
        runner: (state: any, node: any) => {
          state.addNode("code", undefined, node.content.firstChild?.text || "", {
            lang: node.attrs.language,
          });
        },
      },
    },
    hr: {
      group: "block",
      parseMarkdown: {
        match: (node: any) => node.type === "thematicBreak",
        runner: (state: any, _node: any, type: any) => {
          state.addNode(type);
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "hr",
        runner: (state: any) => {
          state.addNode("thematicBreak");
        },
      },
    },
    image: {
      inline: true,
      group: "inline",
      attrs: {
        src: { default: "" },
        alt: { default: "" },
        title: { default: "" },
      },
      parseMarkdown: {
        match: (node: any) => node.type === "image",
        runner: (state: any, node: any, type: any) => {
          state.addNode(type, {
            src: node.url || "",
            alt: node.alt || "",
            title: node.title || "",
          });
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "image",
        runner: (state: any, node: any) => {
          state.addNode("image", undefined, undefined, {
            title: node.attrs.title,
            url: node.attrs.src,
            alt: node.attrs.alt,
          });
        },
      },
    },
    hardbreak: {
      inline: true,
      group: "inline",
      selectable: false,
      attrs: {
        isInline: { default: false },
      },
      parseMarkdown: {
        match: (node: any) => node.type === "break",
        runner: (state: any, _node: any, type: any) => {
          state.addNode(type);
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "hardbreak",
        runner: (state: any, node: any) => {
          if (node.attrs.isInline) state.addNode("text", undefined, "\n");
          else state.addNode("break");
        },
      },
    },
    bullet_list: {
      content: "list_item+",
      group: "block",
      attrs: {
        spread: { default: false },
      },
      parseMarkdown: {
        match: (node: any) => node.type === "list" && !node.ordered,
        runner: (state: any, node: any, type: any) => {
          state
            .openNode(type, {
              spread: node.spread ? "true" : "false",
            })
            .next(node.children)
            .closeNode();
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "bullet_list",
        runner: (state: any, node: any) => {
          state
            .openNode("list", undefined, {
              ordered: false,
              spread: node.attrs.spread,
            })
            .next(node.content)
            .closeNode();
        },
      },
    },
    ordered_list: {
      content: "list_item+",
      group: "block",
      attrs: {
        order: { default: 1 },
        spread: { default: false },
      },
      parseMarkdown: {
        match: (node: any) => node.type === "list" && !!node.ordered,
        runner: (state: any, node: any, type: any) => {
          state
            .openNode(type, {
              spread: node.spread ? "true" : "false",
            })
            .next(node.children)
            .closeNode();
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "ordered_list",
        runner: (state: any, node: any) => {
          state.openNode("list", undefined, {
            ordered: true,
            start: 1,
            spread: node.attrs.spread === "true",
          });
          state.next(node.content);
          state.closeNode();
        },
      },
    },
    list_item: {
      content: "paragraph block*",
      group: "block",
      defining: true,
      attrs: {
        label: { default: null },
        listType: { default: null },
        spread: { default: "true" },
      },
      parseMarkdown: {
        match: (node: any) => node.type === "listItem",
        runner: (state: any, node: any, type: any) => {
          state.openNode(type, {
            label: node.label ?? null,
            listType: node.listType ?? null,
            spread: node.spread ? "true" : "false",
          });
          state.next(node.children);
          state.closeNode();
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "list_item",
        runner: (state: any, node: any) => {
          state.openNode("listItem", undefined, {
            spread: node.attrs.spread,
          });
          state.next(node.content);
          state.closeNode();
        },
      },
    },
    html: {
      group: "block",
      attrs: {
        value: { default: "" },
      },
      parseMarkdown: {
        match: (node: any) => node.type === "html",
        runner: (state: any, node: any, type: any) => {
          state.addNode(type, { value: node.value || "" });
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "html",
        runner: (state: any, node: any) => {
          state.addNode("html", undefined, node.attrs.value);
        },
      },
    },
    text: {
      group: "inline",
      parseMarkdown: {
        match: (node: any) => node.type === "text",
        runner: (state: any, node: any) => {
          state.addText(node.value || "");
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "text",
        runner: (state: any, node: any) => {
          state.addNode("text", undefined, node.text);
        },
      },
    },
    // GFM: Table nodes
    table: {
      content: "table_header_row table_row*",
      group: "block",
      tableRole: "table",
      isolating: true,
      parseMarkdown: {
        match: (node: any) => node.type === "table",
        runner: (state: any, node: any, type: any) => {
          const align = node.align || [];
          const [firstRow, ...restRows] = node.children || [];
          state.openNode(type);
          if (firstRow) {
            const headerRowType = state.schema?.nodes?.table_header_row;
            if (headerRowType) {
              state.openNode(headerRowType);
              (firstRow.children || []).forEach((cell: any, i: number) => {
                const headerType = state.schema?.nodes?.table_header;
                if (headerType) {
                  state.openNode(headerType, {
                    alignment: align[i] || null,
                  });
                  state.next(cell.children);
                  state.closeNode();
                }
              });
              state.closeNode();
            }
          }
          restRows.forEach((row: any) => {
            const rowType = state.schema?.nodes?.table_row;
            if (rowType) {
              state.openNode(rowType);
              (row.children || []).forEach((cell: any, i: number) => {
                const cellType = state.schema?.nodes?.table_cell;
                if (cellType) {
                  state.openNode(cellType, {
                    alignment: align[i] || null,
                  });
                  state.next(cell.children);
                  state.closeNode();
                }
              });
              state.closeNode();
            }
          });
          state.closeNode();
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "table",
        runner: (state: any, node: any) => {
          const firstLine = node.content.firstChild?.content;
          if (!firstLine) return;
          const align: any[] = [];
          firstLine.forEach((cell: any) => {
            align.push(cell.attrs.alignment);
          });
          state.openNode("table", undefined, { align });
          state.next(node.content);
          state.closeNode();
        },
      },
    },
    table_header_row: {
      content: "table_header+",
      tableRole: "header_row",
      parseMarkdown: {
        match: (node: any) => node.type === "tableRow" && node.isHeader,
        runner: (state: any, node: any, type: any) => {
          state.openNode(type).next(node.children).closeNode();
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "table_header_row",
        runner: (state: any, node: any) => {
          state.openNode("tableRow", undefined, { isHeader: true });
          state.next(node.content);
          state.closeNode();
        },
      },
    },
    table_row: {
      content: "table_cell+",
      tableRole: "row",
      parseMarkdown: {
        match: (node: any) => node.type === "tableRow" && !node.isHeader,
        runner: (state: any, node: any, type: any) => {
          state.openNode(type).next(node.children).closeNode();
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "table_row",
        runner: (state: any, node: any) => {
          if (node.content.size === 0) return;
          state.openNode("tableRow");
          state.next(node.content);
          state.closeNode();
        },
      },
    },
    table_header: {
      content: "inline*",
      tableRole: "header_cell",
      attrs: {
        alignment: { default: null },
      },
      isolating: true,
      parseMarkdown: {
        match: (node: any) => node.type === "tableCell" && node.isHeader,
        runner: (state: any, node: any, type: any) => {
          state.openNode(type);
          state.next(node.children);
          state.closeNode();
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "table_header",
        runner: (state: any, node: any) => {
          state.openNode("tableCell");
          state.next(node.content);
          state.closeNode();
        },
      },
    },
    table_cell: {
      content: "inline*",
      tableRole: "cell",
      attrs: {
        alignment: { default: null },
      },
      isolating: true,
      parseMarkdown: {
        match: (node: any) => node.type === "tableCell" && !node.isHeader,
        runner: (state: any, node: any, type: any) => {
          state.openNode(type);
          state.next(node.children);
          state.closeNode();
        },
      },
      toMarkdown: {
        match: (node: any) => node.type.name === "table_cell",
        runner: (state: any, node: any) => {
          state.openNode("tableCell");
          state.next(node.content);
          state.closeNode();
        },
      },
    },
  },
  marks: {
    emphasis: {
      attrs: { marker: { default: "*" } },
      parseMarkdown: {
        match: (node: any) => node.type === "emphasis",
        runner: (state: any, node: any, markType: any) => {
          state.openMark(markType, { marker: node.marker });
          state.next(node.children);
          state.closeMark(markType);
        },
      },
      toMarkdown: {
        match: (mark: any) => mark.type.name === "emphasis",
        runner: (state: any, mark: any) => {
          state.withMark(mark, "emphasis", undefined, {
            marker: mark.attrs.marker,
          });
        },
      },
    },
    strong: {
      attrs: { marker: { default: "*" } },
      parseMarkdown: {
        match: (node: any) => node.type === "strong",
        runner: (state: any, node: any, markType: any) => {
          state.openMark(markType, { marker: node.marker });
          state.next(node.children);
          state.closeMark(markType);
        },
      },
      toMarkdown: {
        match: (mark: any) => mark.type.name === "strong",
        runner: (state: any, mark: any) => {
          state.withMark(mark, "strong", undefined, {
            marker: mark.attrs.marker,
          });
        },
      },
    },
    inlineCode: {
      parseMarkdown: {
        match: (node: any) => node.type === "inlineCode",
        runner: (state: any, node: any, markType: any) => {
          state.openMark(markType);
          state.addText(node.value || "");
          state.closeMark(markType);
        },
      },
      toMarkdown: {
        match: (mark: any) => mark.type.name === "inlineCode",
        runner: (state: any, mark: any, node: any) => {
          state.withMark(mark, "inlineCode", node.text || "");
        },
      },
    },
    link: {
      attrs: {
        href: { default: "" },
        title: { default: "" },
      },
      inclusive: false,
      parseMarkdown: {
        match: (node: any) => node.type === "link",
        runner: (state: any, node: any, markType: any) => {
          state.openMark(markType, {
            href: node.url || "",
            title: node.title || "",
          });
          state.next(node.children);
          state.closeMark(markType);
        },
      },
      toMarkdown: {
        match: (mark: any) => mark.type.name === "link",
        runner: (state: any, mark: any) => {
          state.withMark(mark, "link", undefined, {
            title: mark.attrs.title,
            url: mark.attrs.href,
          });
        },
      },
    },
    strike_through: {
      parseMarkdown: {
        match: (node: any) => node.type === "delete",
        runner: (state: any, node: any, markType: any) => {
          state.openMark(markType);
          state.next(node.children);
          state.closeMark(markType);
        },
      },
      toMarkdown: {
        match: (mark: any) => mark.type.name === "strike_through",
        runner: (state: any, mark: any) => {
          state.withMark(mark, "delete");
        },
      },
    },
  },
};

// ─────────────────────────────────────────────────────────
// Singleton instances (lazily initialized)
// ─────────────────────────────────────────────────────────

let _schema: Schema | null = null;
let _remarkProcessor: Processor | null = null;
let _parser: ((md: string) => ProseMirrorNode) | null = null;
let _serializer: ((node: ProseMirrorNode) => string) | null = null;

function ensureInitialized() {
  if (_schema) return;

  _schema = new Schema(schemaSpec as any);

  _remarkProcessor = unified()
    .use(remarkParse)
    .use(remarkStringify, {
      handlers: remarkHandlers,
      encode: [],
    })
    // Commonmark remark plugins (order matters):
    .use(remarkPreserveEmptyLine)
    .use(remarkAddOrderInList)
    .use(remarkLineBreak)
    .use(remarkInlineLinks)
    .use(remarkHtmlTransformer)
    .use(remarkMarker)
    // GFM remark plugin:
    .use(remarkGfm) as unknown as Processor;

  _parser = ParserState.create(_schema, _remarkProcessor as any);
  _serializer = SerializerState.create(_schema, _remarkProcessor as any);
}

// ─────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────

/** Parse a markdown string into a ProseMirror document node. */
export function markdownToProseMirrorNode(md: string): ProseMirrorNode {
  ensureInitialized();
  return _parser!(md);
}

/** Serialize a ProseMirror document node back to markdown. */
export function proseMirrorNodeToMarkdown(node: ProseMirrorNode): string {
  ensureInitialized();
  return _serializer!(node);
}

/** Return the shared ProseMirror Schema instance. */
export function getSchema(): Schema {
  ensureInitialized();
  return _schema!;
}

/** Return the shared unified remark Processor instance. */
export function getRemarkProcessor(): Processor {
  ensureInitialized();
  return _remarkProcessor!;
}

// ─────────────────────────────────────────────────────────
// JSON-boundary API: safe to call across package boundaries
// (avoids prosemirror-model instanceof issues with separate
// node_modules copies)
// ─────────────────────────────────────────────────────────

/**
 * Return the ProseMirror-compatible schema spec as a plain JS object.
 * Consumers can create their own Schema with their own prosemirror-model copy.
 * Only includes ProseMirror-relevant properties (content, group, attrs, etc.),
 * not the parseMarkdown/toMarkdown handlers.
 */
export function getSchemaSpec(): { nodes: Record<string, unknown>; marks: Record<string, unknown> } {
  const nodes: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schemaSpec.nodes)) {
    const { parseMarkdown, toMarkdown, ...pmSpec } = spec as any;
    nodes[name] = pmSpec;
  }
  const marks: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schemaSpec.marks)) {
    const { parseMarkdown, toMarkdown, ...pmSpec } = spec as any;
    marks[name] = pmSpec;
  }
  return { nodes, marks };
}

/** Parse markdown to ProseMirror JSON (plain object, no class instances). */
export function markdownToJSON(md: string): Record<string, unknown> {
  return markdownToProseMirrorNode(md).toJSON() as Record<string, unknown>;
}

/** Convert ProseMirror JSON back to a markdown string. */
export function jsonToMarkdown(json: Record<string, unknown>): string {
  ensureInitialized();
  const node = _schema!.nodeFromJSON(json);
  return _serializer!(node);
}
