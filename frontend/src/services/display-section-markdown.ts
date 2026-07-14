/**
 * Choose the markdown string to show for a section (BUG1 display authority, F1).
 *
 * The single answer to "what text should the UI paint for this section right
 * now?" when a live CRDT store may exist:
 *
 *   - No live store        → `section.content` (cold bootstrap / REST seed).
 *   - Store, key NOT present in the shared doc → `section.content` (cold seed;
 *     the live fragment has not arrived / been created yet).
 *   - Store, key present    → the live fragment markdown, which is the authority.
 *     `section.content` may still hold a reconstructed `# Heading` from a
 *     skeleton prepend after the live fragment already demoted to body — so once
 *     the fragment exists, it wins.
 *
 * Presence is checked with `doc.share.has(fragmentKey)` — a NON-creating lookup.
 * We must never probe presence via `getXmlFragment(fragmentKey)` (nor
 * `fragmentToMarkdown` → `yDocToProsemirrorJSON`, which calls it): Yjs creates
 * the top-level type on read, resurrecting a cleared-but-removed fragment so the
 * next keystroke echoes into a dead slot. `MilkdownEditor.attachCrdt` documents
 * the same footgun. We only call `fragmentToMarkdown` AFTER `share.has` confirms
 * the type already exists.
 *
 * Pure read: no fetch, no Y.Doc write, no layout mutation. Reactivity (paint on
 * fragment change) is the caller's job — see `useDisplaySectionMarkdown`.
 */

import type * as Y from "yjs";
import { fragmentToMarkdown } from "./fragment-to-markdown";

export interface DisplaySection {
  content: string;
  fragment_key: string;
}

export interface DisplayStore {
  readonly doc: Y.Doc;
}

export function displaySectionMarkdown(
  section: DisplaySection,
  store: DisplayStore | null,
): string {
  const seed = typeof section.content === "string" ? section.content : "";
  if (!store) return seed;
  const share = store.doc.share;
  // Non-creating presence check: only read the fragment once it demonstrably
  // exists in the shared doc. Do NOT fall through to getXmlFragment.
  if (!share || !share.has(section.fragment_key)) return seed;
  const md = fragmentToMarkdown(store.doc, section.fragment_key);
  // A present-but-empty fragment serializes to null; the cold seed is the best
  // available text until real content arrives.
  return md ?? seed;
}
