/**
 * Y.Doc Fragment Helpers — Fragment key utilities and schema.
 *
 * Fragment key = "section::" + sectionFileId (filename stem, e.g. "sec_abc123def").
 * Before-first-heading section uses the synthetic constant "section::__beforeFirstHeading__".
 *
 * Content operations (read, write, restructure, assemble) are in FragmentStore.
 * This module provides key derivation, schema, and session-level helpers.
 */

import { getSchemaSpec } from "@ks/milkdown-serializer";
import { Schema } from "prosemirror-model";

// ─── Fragment key helpers ────────────────────────────────────────

/** Synthetic fragment key for the before-first-heading section (level=0, heading=""). */
export const BEFORE_FIRST_HEADING_KEY = "section::__beforeFirstHeading__";

/**
 * Derive a stable fragment key from a section filename.
 * e.g. "sec_abc123def.md" → "section::sec_abc123def"
 * Before-first-heading sections (level=0, heading="") use BEFORE_FIRST_HEADING_KEY.
 */
export function fragmentKeyFromSectionFile(sectionFile: string, isBeforeFirstHeading: boolean): string {
  if (isBeforeFirstHeading) return BEFORE_FIRST_HEADING_KEY;
  const stem = sectionFile.replace(/\.md$/, "");
  return "section::" + stem;
}

/**
 * Extract the section file stem from a fragment key.
 * e.g. "section::sec_abc123def" → "sec_abc123def"
 * Returns "__beforeFirstHeading__" for the before-first-heading fragment.
 */
export function sectionFileFromFragmentKey(key: string): string {
  const prefix = "section::";
  if (!key.startsWith(prefix)) return "";
  return key.slice(prefix.length);
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

