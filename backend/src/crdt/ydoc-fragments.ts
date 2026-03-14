/**
 * Y.Doc Fragment Helpers — Fragment key utilities and schema.
 *
 * Fragment key = "section::" + sectionFileId (filename stem, e.g. "sec_abc123def").
 * Root section uses the synthetic constant "section::__root__".
 *
 * Content operations (read, write, restructure, assemble) are in FragmentStore.
 * This module provides key derivation, schema, and session-level helpers.
 */

import { getSchemaSpec } from "@ks/milkdown-serializer";
import { Schema } from "prosemirror-model";
import type { DocSession } from "./ydoc-lifecycle.js";
import { SectionRef } from "../domain/section-ref.js";

// ─── Fragment key helpers ────────────────────────────────────────

/** Synthetic fragment key for the root section (level=0, heading=""). */
export const ROOT_FRAGMENT_KEY = "section::__root__";

/**
 * Derive a stable fragment key from a section filename.
 * e.g. "sec_abc123def.md" → "section::sec_abc123def"
 * Root sections (level=0, heading="") use ROOT_FRAGMENT_KEY.
 */
export function fragmentKeyFromSectionFile(sectionFile: string, isRoot: boolean): string {
  if (isRoot) return ROOT_FRAGMENT_KEY;
  const stem = sectionFile.replace(/\.md$/, "");
  return "section::" + stem;
}

/**
 * Extract the section file stem from a fragment key.
 * e.g. "section::sec_abc123def" → "sec_abc123def"
 * Returns "__root__" for the root fragment.
 */
export function sectionFileFromFragmentKey(key: string): string {
  const prefix = "section::";
  if (!key.startsWith(prefix)) return "";
  return key.slice(prefix.length);
}

/** @deprecated Use fragmentKeyFromSectionFile() instead. Kept for test compatibility. */
export function fragmentKeyFromHeadingPath(headingPath: string[]): string {
  return SectionRef.fragmentKeyFromHeadingPath(headingPath);
}

/** @deprecated Use skeleton.resolveByFileId() instead. Kept for test compatibility. */
export function headingPathFromFragmentKey(key: string): string[] {
  const prefix = "section::";
  if (!key.startsWith(prefix)) return [];
  const rest = key.slice(prefix.length);
  if (rest === "") return [];
  return rest.split(">>");
}

// ─── Schema ──────────────────────────────────────────────────────

let _backendSchema: Schema | null = null;
export function getBackendSchema(): Schema {
  if (!_backendSchema) {
    _backendSchema = new Schema(getSchemaSpec() as any);
  }
  return _backendSchema;
}

// ─── Session-level helpers ───────────────────────────────────────

/**
 * @deprecated Use session.fragments.assembleMarkdown() instead.
 * Kept for backwards compatibility during migration.
 */
export async function assembleMarkdownFromDoc(session: DocSession): Promise<string> {
  return session.fragments.assembleMarkdown();
}

