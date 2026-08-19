/**
 * apply-link-mark — confirm path for the link document-path picker. Mirrors the
 * stock Milkdown `LinkEditTooltip#confirmEdit` semantics:
 *
 *   1. collapse a rendered app URL (`/docs/…` pathname or same-origin absolute)
 *      to its stored content-root form, so `/docs` never enters the mark attrs,
 *   2. sanitize the href with DOMPurify (same safety as stock),
 *   3. if editing an existing mark and the resulting href is unchanged, reset
 *      without dispatching a transaction,
 *   4. otherwise remove the old link mark (when editing) and addMark a fresh
 *      commonmark `link` mark for [from, to], then dispatch.
 */

import type { Ctx } from "@milkdown/ctx";
import type { EditorView } from "@milkdown/prose/view";
import type { Mark } from "@milkdown/prose/model";
import { linkSchema } from "@milkdown/preset-commonmark";
import DOMPurify from "dompurify";

import { storedContentHrefFromRendered } from "../../app/docs-location";

/**
 * Apply (or update) a commonmark `link` mark over [from, to].
 *
 * @param ctx           The editor context (used to resolve the link mark type).
 * @param view          The ProseMirror editor view to dispatch into.
 * @param from          Selection start (inclusive).
 * @param to            Selection end (exclusive).
 * @param existingMark  The current link mark when editing, else null.
 * @param rawHref       The user-entered href (internal path or external URL).
 */
export function applyLinkMark(
  ctx: Ctx,
  view: EditorView,
  from: number,
  to: number,
  existingMark: Mark | null,
  rawHref: string,
): void {
  const type = linkSchema.type(ctx);
  const href = DOMPurify.sanitize(storedContentHrefFromRendered(rawHref));

  // Unchanged-href reset: editing an existing mark whose href already equals the
  // sanitized value — no-op, matching stock (no transaction dispatched).
  if (existingMark && existingMark.attrs.href === href) return;

  const tr = view.state.tr;
  if (existingMark) tr.removeMark(from, to, existingMark);
  tr.addMark(from, to, type.create({ href }));
  view.dispatch(tr);
}
