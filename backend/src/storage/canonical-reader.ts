/**
 * CanonicalReader — non-mutating canonical-scoped read facade over the live
 * canonical content tree, exposed through `DocumentSkeleton` via the low-level
 * `ContentLayer` engine.
 *
 * This is the canonical-only mirror of `ProposalReader`: where `ProposalReader`
 * shadows a proposal overlay over canonical, `CanonicalReader` reads ONLY the
 * canonical content root with no overlay/session/proposal shadow. It is the
 * single facade that document/section GET application queries and
 * `restore-service.ts` route their canonical reads through, so no
 * application/service file constructs `ContentLayer` ad hoc for canonical reads.
 *
 * `ContentLayer` remains the low-level engine — this facade wraps one and
 * forwards the read surface. Writes are deliberately NOT exposed here; canonical
 * mutation goes through the proposal/commit pipeline.
 *
 * Spec source of truth: `04-decisions-and-apis.md` §5 (document/section reads
 * are canonical-only); proposal-content reads go through `ProposalReader`.
 */

import { ContentLayer, type SectionDiscoveryEntry } from "./content-layer.js";
import { getContentRoot } from "./data-root.js";
import { SectionRef } from "../domain/section-ref.js";
import type { DocStructureNode } from "../types/shared.js";
import type { SectionBody } from "./section-formatting.js";
import type { DocPath, HeadingLevel } from "../types/shared.js";

export class CanonicalReader {
  protected readonly canonicalRoot: string;
  protected readonly layer: ContentLayer;

  protected constructor(canonicalRoot: string) {
    this.canonicalRoot = canonicalRoot;
    this.layer = new ContentLayer(canonicalRoot);
  }

  /**
   * Open a reader rooted at the canonical content root (default) or an
   * explicit canonical root (tests / non-default deployments).
   */
  static open(canonicalRoot: string = getContentRoot()): CanonicalReader {
    return new CanonicalReader(canonicalRoot);
  }

  /** Absolute canonical content root this reader is bound to. */
  get contentRoot(): string {
    return this.canonicalRoot;
  }

  // ─── Document structure ─────────────────────────────────────────────

  /**
   * Canonical structural outline of a document as `DocStructureNode[]`.
   * Throws `DocumentNotFoundError` when no canonical skeleton exists.
   */
  async getDocumentStructure(docPath: DocPath): Promise<DocStructureNode[]> {
    return this.layer.getDocumentStructure(docPath);
  }

  /**
   * Flat ordered list of canonical sections (heading, level, sectionFile,
   * headingPath) with no body content.
   */
  async getSectionList(
    docPath: DocPath,
  ): Promise<Array<{ heading: string; headingLevel: HeadingLevel; sectionFile: string; headingPath: string[] }>> {
    return this.layer.getSectionList(docPath);
  }

  /** All canonical heading paths in document order. */
  async listHeadingPaths(docPath: DocPath): Promise<string[][]> {
    return this.layer.listHeadingPaths(docPath);
  }

  /** Discovery rows for real canonical sections (heading, heading path, body size). */
  async getSectionDiscoveryList(docPath: DocPath): Promise<SectionDiscoveryEntry[]> {
    return this.layer.getSectionDiscoveryList(docPath);
  }

  // ─── Section content ────────────────────────────────────────────────

  /** Read a single canonical section body. */
  async readSection(docPath: DocPath, headingPath: string[]): Promise<SectionBody> {
    return this.layer.readSection(new SectionRef(docPath, headingPath));
  }

  /**
   * Read every canonical section body for a document, keyed by heading key
   * (e.g. "Heading A>>Sub B").
   */
  async readAllSections(docPath: DocPath): Promise<Map<string, SectionBody>> {
    return this.layer.readAllSections(docPath);
  }

  /** Assemble the full canonical document markdown from skeleton + bodies. */
  async readAssembledDocument(docPath: DocPath): Promise<string> {
    return this.layer.readAssembledDocument(docPath);
  }

  async listCanonicalEntries(docPath: DocPath): ReturnType<ContentLayer["listCanonicalEntries"]> {
    return this.layer.listCanonicalEntries(docPath);
  }

  async resolveSectionFileId(docPath: DocPath, sectionFileId: string): ReturnType<ContentLayer["resolveSectionFileId"]> {
    return this.layer.resolveSectionFileId(docPath, sectionFileId);
  }
}
