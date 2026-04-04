/**
 * SectionRef — Value object identifying a section within a document.
 *
 * Encapsulates the (docPath, headingPath) pair and provides all derived
 * key formats used throughout the codebase:
 *
 *   key          — headingPath.join(">>")               (heading-only key)
 *   fragmentKey  — "section::" + sectionFileId           (Y.Doc fragment key)
 *   globalKey    — docPath + "::" + key                  (globally unique key)
 *   label        — "docPath :: heading > path"           (human-readable)
 *
 * Also provides equality checks and heading-path matching.
 */

import { sectionHeadingKey, sectionGlobalKey, type SectionTargetRef } from "../types/shared.js";
import { normalizeDocPath } from "../storage/path-utils.js";

function normalizeHeadingPath(headingPath: string[]): string[] {
  return headingPath.map((segment) => segment.trim());
}

export class SectionRef {
  readonly docPath: string;
  readonly headingPath: string[];

  constructor(docPath: string, headingPath: string[]) {
    this.docPath = normalizeDocPath(docPath);
    this.headingPath = normalizeHeadingPath(headingPath);
  }

  /** Heading-only key: headingPath.join(">>"). Used as map key within a single document. */
  get key(): string {
    return sectionHeadingKey(this.headingPath);
  }

  /** Globally unique key: "docPath::headingPath.join(">>")". */
  get globalKey(): string {
    return sectionGlobalKey(this.docPath, this.headingPath);
  }

  /** Human-readable label: "docPath :: heading > path". */
  get label(): string {
    const heading = this.headingPath.length > 0
      ? this.headingPath.join(" > ")
      : "(before first heading)";
    return `${this.docPath} :: ${heading}`;
  }

  /** Whether this ref points to the before-first-heading section (empty heading path). */
  get isBeforeFirstHeading(): boolean {
    return this.headingPath.length === 0;
  }

  /** Deep equality: same docPath and headingPath. */
  equals(other: SectionRef): boolean {
    return this.globalKey === other.globalKey;
  }

  /** Check if a raw headingPath array matches this ref's heading path. */
  matchesHeadingPath(headingPath: string[]): boolean {
    if (headingPath.length !== this.headingPath.length) return false;
    return headingPath.every((seg, i) => seg === this.headingPath[i]);
  }

  /** Create from a SectionTargetRef (API-facing type). */
  static fromTarget(target: SectionTargetRef): SectionRef {
    return new SectionRef(target.doc_path, target.heading_path);
  }

  /** Convert to SectionTargetRef for API responses. */
  toTarget(): SectionTargetRef {
    return {
      doc_path: this.docPath,
      heading_path: [...this.headingPath],
    };
  }

  /**
   * Compute the heading-only key from a raw headingPath without creating
   * a full SectionRef. Useful in contexts where docPath isn't available.
   */
  static headingKey(headingPath: string[]): string {
    return sectionHeadingKey(headingPath);
  }

  /**
   * Compare two raw heading path arrays for equality without creating
   * a full SectionRef. Useful in hot paths (focus matching, pulse lookups).
   */
  static headingPathsEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((seg, i) => seg === b[i]);
  }

}
