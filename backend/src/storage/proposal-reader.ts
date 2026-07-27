/**
 * ProposalReader — non-mutating proposal-scoped facade over a proposal
 * content tree, exposed through `DocumentSkeleton`.
 *
 * Construction resolves the proposal content root internally (via
 * `proposalContentRoot`) and resolves reads proposal-content-first with
 * canonical fallback. The proposal-internal storage layout (skeleton / body /
 * `.tombstone` files) is never exposed to callers — they work in terms of doc
 * paths, heading paths, effective document state, and section bodies only.
 *
 * Spec source of truth: `01-data-primitives.md` ("ProposalReader /
 * ProposalEditor API surface") and `04-decisions-and-apis.md`
 * ("Tombstone-file pattern" — state detection checks tombstone first).
 */

import {
  ProposalShadowContentLayer,
  DocumentNotFoundError,
  type SectionDiscoveryEntry,
} from "./content-layer.js";
import { proposalContentRoot, loadDeletedSectionFiles } from "./proposal-repository.js";
import { getContentRoot } from "./data-root.js";
import { SectionRef } from "../domain/section-ref.js";
import type { DocStructureNode } from "../types/shared.js";
import type { ProposalId, ProposalStatus } from "../types/shared.js";
import type { SectionBody } from "./section-formatting.js";
import type { DocPath } from "../types/shared.js";
import type {
  ProposalDocumentState,
  ProposalSectionReadResult,
} from "./proposal-facade-types.js";

export class ProposalReader {
  protected readonly proposalId: ProposalId;
  protected readonly contentRoot: string;
  protected readonly canonicalRoot: string;
  protected readonly shadow: ProposalShadowContentLayer;

  protected constructor(proposalId: ProposalId, contentRoot: string, canonicalRoot: string) {
    this.proposalId = proposalId;
    this.contentRoot = contentRoot;
    this.canonicalRoot = canonicalRoot;
    // Identity-based delete detection (D5): give the shadow layer this proposal's
    // deleted canonical section-file ids so effective-structure reads merge the
    // sparse overlay over current canonical (inherit untouched sections; drop
    // sections whose id is in the deleted set — survives ancestor restructure).
    this.shadow = new ProposalShadowContentLayer(
      contentRoot,
      canonicalRoot,
      (docPath) => loadDeletedSectionFiles(proposalId, docPath),
    );
  }

  /**
   * Open a reader for a proposal whose status (hence content-root location) is
   * already known. The canonical root defaults to the live content root.
   */
  static open(proposalId: ProposalId, status: ProposalStatus, canonicalRoot: string = getContentRoot()): ProposalReader {
    return new ProposalReader(proposalId, proposalContentRoot(proposalId, status), canonicalRoot);
  }

  /** The proposal this facade is bound to. */
  get id(): ProposalId {
    return this.proposalId;
  }

  /**
   * Absolute path to this proposal's content root. Exposed for the narrow set
   * of callers that must walk the proposal's on-disk doc tree for catalog
   * discovery (which has no `DocumentSkeleton`-level equivalent). Prefer the
   * structural read methods for everything else.
   */
  get proposalContentRoot(): string {
    return this.contentRoot;
  }

  // ─── Effective document/section state ─────────────────────────────

  /**
   * Resolve the effective document state inside this proposal: tombstone
   * (pending deletion) is checked first, then live, then missing.
   */
  async getDocumentState(docPath: DocPath): Promise<ProposalDocumentState> {
    return this.shadow.getDocumentState(docPath);
  }

  /** True only when the document is effectively live in this proposal. */
  async documentExists(docPath: DocPath): Promise<boolean> {
    return this.shadow.documentExists(docPath);
  }

  /**
   * Effective state of a single section: tombstoned doc -> "tombstone";
   * missing doc or absent heading path -> "missing"; otherwise "live".
   */
  async getSectionState(docPath: DocPath, headingPath: string[]): Promise<ProposalDocumentState> {
    const docState = await this.getDocumentState(docPath);
    if (docState !== "live") return docState;
    const paths = await this.shadow.listHeadingPaths(docPath);
    const key = SectionRef.headingKey(headingPath);
    return paths.some((hp) => SectionRef.headingKey(hp) === key) ? "live" : "missing";
  }

  // ─── Effective document structure ─────────────────────────────────

  /**
   * Effective structural outline of a document through `DocumentSkeleton`.
   * Throws `DocumentNotFoundError` if the document is missing or tombstoned.
   */
  async getDocumentStructure(docPath: DocPath): Promise<DocStructureNode[]> {
    return this.shadow.getDocumentStructure(docPath);
  }

  /**
   * Effective heading paths for a document, in document order.
   * Throws `DocumentNotFoundError` if the document is missing or tombstoned.
   */
  async listHeadingPaths(docPath: DocPath): Promise<string[][]> {
    return this.shadow.listHeadingPaths(docPath);
  }

  /**
   * Flat ordered list of effective sections with heading text, level, and
   * heading path (no body content). Useful for callers that need a section's
   * level/heading to render a fragment.
   */
  async getSectionList(
    docPath: DocPath,
  ): Promise<Array<{ heading: string; level: number; sectionFile: string; headingPath: string[] }>> {
    return this.shadow.getSectionList(docPath);
  }

  /**
   * Discovery rows for real sections only (heading, heading path, body size).
   * Delegates through the proposal content engine's structure reads.
   */
  async getSectionDiscoveryList(docPath: DocPath): Promise<SectionDiscoveryEntry[]> {
    // The proposal content engine has no discovery-list method; build it from
    // the section list. Body sizes are not part of the facade contract for
    // proposals, so we expose 0 — callers needing sizes read the section.
    const sections = await this.shadow.getSectionList(docPath);
    return sections.map((s) => ({
      heading: s.heading,
      headingPath: s.headingPath,
      absolutePath: "",
      bodySizeBytes: 0,
    }));
  }

  // ─── Effective section content ────────────────────────────────────

  /**
   * Read the effective body content of a section at a heading path.
   * Throws `DocumentNotFoundError` / `SectionNotFoundError` from the engine.
   */
  async readSection(docPath: DocPath, headingPath: string[]): Promise<SectionBody> {
    return this.shadow.readSection(new SectionRef(docPath, headingPath));
  }

  /**
   * Proposal readback for a whole document: every effective section's heading
   * path plus its body content, for APIs / human review / agent verification
   * that previously-written content landed.
   *
   * Throws `DocumentNotFoundError` for a missing or tombstoned document.
   */
  async readDocument(docPath: DocPath): Promise<ProposalSectionReadResult[]> {
    const state = await this.getDocumentState(docPath);
    if (state !== "live") {
      throw new DocumentNotFoundError(
        state === "tombstone"
          ? `Document "${docPath}" is pending deletion in proposal ${this.proposalId}.`
          : `Document "${docPath}" does not exist in proposal ${this.proposalId}.`,
      );
    }
    const headingPaths = await this.shadow.listHeadingPaths(docPath);
    const result: ProposalSectionReadResult[] = [];
    for (const headingPath of headingPaths) {
      const body = await this.shadow.readSection(new SectionRef(docPath, headingPath));
      result.push({ docPath, headingPath, body });
    }
    return result;
  }

  /**
   * Read all effective section bodies for a document, keyed by heading key.
   */
  async readAllSections(docPath: DocPath): Promise<Map<string, SectionBody>> {
    return this.shadow.readAllSections(docPath);
  }
}
