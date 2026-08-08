/**
 * Squarified treemap layout over the search hit forest.
 *
 * Area encodes `totalDescendants`, so a folder that holds most of the hits looks
 * like it holds most of the hits. Squarify (Bruls/Huizing/van Wijk) is used
 * rather than a naive slice-and-dice because long thin slivers are unclickable
 * and their areas are impossible to compare by eye.
 *
 * Pure geometry: no React, no colors, no new dependency.
 */
import type { SearchTreeNode } from "./search-hit-forest";

export interface TreemapBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TreemapRect extends TreemapBounds {
  node: SearchTreeNode;
  /** 0 for the children of the node being laid out, 1 for their children, … */
  depth: number;
}

interface SizedNode {
  node: SearchTreeNode;
  value: number;
}

/**
 * `worst` from the squarify paper: the worst aspect ratio in a row of areas laid
 * out along a side of the given length.
 */
function worstAspectRatio(row: readonly number[], sideLength: number): number {
  if (row.length === 0) return Infinity;
  let sum = 0;
  let min = Infinity;
  let max = 0;
  for (const value of row) {
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (sum <= 0 || sideLength <= 0) return Infinity;
  const sideSquared = sideLength * sideLength;
  const sumSquared = sum * sum;
  return Math.max((sideSquared * max) / sumSquared, sumSquared / (sideSquared * min));
}

/** Place one finished row along the short side of `rect`, and return what is left. */
function placeRow(row: readonly SizedNode[], rect: TreemapBounds, out: TreemapRect[], depth: number): TreemapBounds {
  const rowTotal = row.reduce((sum, item) => sum + item.value, 0);
  if (rowTotal <= 0) return rect;

  if (rect.w >= rect.h) {
    const columnWidth = rowTotal / rect.h;
    let y = rect.y;
    for (const item of row) {
      const height = item.value / columnWidth;
      out.push({ node: item.node, x: rect.x, y, w: columnWidth, h: height, depth });
      y += height;
    }
    return { x: rect.x + columnWidth, y: rect.y, w: rect.w - columnWidth, h: rect.h };
  }

  const rowHeight = rowTotal / rect.w;
  let x = rect.x;
  for (const item of row) {
    const width = item.value / rowHeight;
    out.push({ node: item.node, x, y: rect.y, w: width, h: rowHeight, depth });
    x += width;
  }
  return { x: rect.x, y: rect.y + rowHeight, w: rect.w, h: rect.h - rowHeight };
}

/**
 * Lay out one level: the given nodes fill `bounds` in proportion to their
 * `totalDescendants`. Nodes with no hits beneath them are dropped — an empty
 * rectangle would claim area it has not earned.
 */
export function squarifyNodes(
  nodes: readonly SearchTreeNode[],
  bounds: TreemapBounds,
  depth = 0,
): TreemapRect[] {
  const sized = nodes
    .filter((node) => node.totalDescendants > 0)
    .map((node) => ({ node, value: node.totalDescendants }))
    .sort((a, b) => (b.value - a.value) || a.node.label.localeCompare(b.node.label));

  const total = sized.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0 || bounds.w <= 0 || bounds.h <= 0) return [];

  // Scale counts to pixel area so row ratios are computed in the same units the
  // rectangles are drawn in.
  const scale = (bounds.w * bounds.h) / total;
  const scaled: SizedNode[] = sized.map((item) => ({ node: item.node, value: item.value * scale }));

  const out: TreemapRect[] = [];
  let rect: TreemapBounds = { ...bounds };
  let row: SizedNode[] = [];
  let index = 0;

  while (index < scaled.length) {
    const candidate = scaled[index];
    const side = Math.min(rect.w, rect.h);
    const rowValues = row.map((item) => item.value);
    const currentWorst = worstAspectRatio(rowValues, side);
    const nextWorst = worstAspectRatio([...rowValues, candidate.value], side);

    if (row.length === 0 || nextWorst <= currentWorst) {
      row.push(candidate);
      index += 1;
      continue;
    }

    rect = placeRow(row, rect, out, depth);
    row = [];
  }

  if (row.length > 0) {
    placeRow(row, rect, out, depth);
  }
  return out;
}

export interface TreemapLayoutOptions {
  /** How many levels below the laid-out node to nest. 1 = children only. */
  maxDepth?: number;
  /** Strip reserved at the top of a nested rectangle for its own label. */
  headerPx?: number;
  /** A rectangle smaller than this in either axis is not subdivided further. */
  minSubdivisionPx?: number;
}

/**
 * Nested layout: `root`'s children fill `bounds`, and each rectangle big enough
 * to be worth subdividing gets its own children laid out inside it (below a
 * header strip that keeps the parent's label readable).
 *
 * Rectangles are returned parent-before-child, so painting them in order draws
 * children on top.
 */
export function buildTreemapRects(
  root: SearchTreeNode,
  bounds: TreemapBounds,
  options: TreemapLayoutOptions = {},
): TreemapRect[] {
  const maxDepth = options.maxDepth ?? 3;
  const headerPx = options.headerPx ?? 16;
  const minSubdivisionPx = options.minSubdivisionPx ?? 64;

  const all: TreemapRect[] = [];

  const layoutLevel = (node: SearchTreeNode, area: TreemapBounds, depth: number): void => {
    if (depth >= maxDepth) return;
    const rects = squarifyNodes(node.children, area, depth);
    all.push(...rects);
    for (const rect of rects) {
      const hasDrawableChildren = rect.node.children.some((child) => child.totalDescendants > 0);
      if (!hasDrawableChildren) continue;
      if (rect.w < minSubdivisionPx || rect.h < minSubdivisionPx + headerPx) continue;
      layoutLevel(rect.node, { x: rect.x, y: rect.y + headerPx, w: rect.w, h: rect.h - headerPx }, depth + 1);
    }
  };

  layoutLevel(root, bounds, 0);
  return all;
}
