/**
 * Proposal-overlay ownership — the pre-publish claim check.
 *
 * A proposal is a manifest-scoped sparse overlay (spec `01` §Proposal Overlay
 * Model): commit may touch only the documents in `targets[]` and the sections in
 * `sections`. Ownership is therefore not "what the manifest says" — it is what
 * the overlay actually holds against current canonical, keyed by section-file
 * identity, exactly as `resolveEffectiveSkeletonNodes` resolves it:
 *
 *   - created — an effective section whose `sectionFile` id is absent from canonical;
 *   - moved / renamed — an id canonical also carries, now at a different heading
 *     path (owned at the new address; the old one travels as the delete/claim the
 *     mutation already records);
 *   - edited — an id whose body file exists under the proposal's own content root;
 *   - deleted — an id in the proposal's `deleted_section_files` for that document.
 *
 * Extra manifest claims are not ownership. Owned content that the manifest does
 * NOT claim is an illegal write-path state: absorb would either drop it or
 * commit it outside the proposal's declared scope, so publish refuses.
 */

import path from "node:path";

import {
  DocPath,
  HeadingLevel,
  proposalSectionClaimsWithParsedDocPaths,
  type ProposalId,
  type ProposalStatus,
} from "../types/shared.js";
import { getContentRoot } from "./data-root.js";
import {
  DocumentSkeletonInternal,
  TOMBSTONE_SUFFIX,
  resolveEffectiveSkeletonNodes,
  tombstoneFileExists,
  type SkeletonNode,
} from "./document-skeleton.js";
import { directoryExists, readDirentsIfExists, readFileIfExists } from "./fs-primitives.js";
import { docPathFromContentRelativeFsPath } from "./path-utils.js";
import {
  loadDeletedSectionFiles,
  proposalContentRoot,
  readProposal,
} from "./proposal-repository.js";

export interface OwnedHeadingAddress {
  docPath: DocPath;
  headingPath: string[];
}

export class UnclaimedProposalOverlayError extends Error {
  readonly proposalId: ProposalId;
  readonly unclaimed: OwnedHeadingAddress[];

  constructor(proposalId: ProposalId, unclaimed: OwnedHeadingAddress[]) {
    super(
      `Proposal ${proposalId} cannot be published: its overlay owns content at ` +
        unclaimed.map((a) => `${a.docPath} [${a.headingPath.join(" > ")}]`).join(", ") +
        `, which its manifest does not claim. Overlay-owned content missing from the ` +
        `manifest cannot be published — commit may touch only the documents in ` +
        `targets[] and the sections in sections[].`,
    );
    this.name = "UnclaimedProposalOverlayError";
    this.proposalId = proposalId;
    this.unclaimed = unclaimed;
  }
}

function headingKeyFoldingCase(headingPath: string[]): string {
  return headingPath.map((segment) => segment.toLowerCase()).join(" >> ");
}

interface DocumentIdentityView {
  headingPathByHeadingNodeFile: Map<string, string[]>;
  headingPathByAnyFile: Map<string, string[]>;
  headingNodeFileByHeadingKey: Map<string, string>;
  bodyPathByHeadingKey: Map<string, string>;
  headingPathByHeadingKey: Map<string, string[]>;
}

/**
 * Index one skeleton tree by the two identities ownership is judged on: the
 * HEADING node's own `sectionFile` (stable across a leaf→parent conversion, so
 * it is the heading's identity) and the body file that heading's content lives
 * in (its own file when a leaf, its body holder when a parent).
 */
function indexDocumentIdentities(
  docPath: DocPath,
  nodes: SkeletonNode[],
  root: string,
): DocumentIdentityView {
  const skeleton = DocumentSkeletonInternal.fromNodes(docPath, nodes, root);
  const view: DocumentIdentityView = {
    headingPathByHeadingNodeFile: new Map(),
    headingPathByAnyFile: new Map(),
    headingNodeFileByHeadingKey: new Map(),
    bodyPathByHeadingKey: new Map(),
    headingPathByHeadingKey: new Map(),
  };
  for (const entry of skeleton.allStructuralEntries()) {
    const key = headingKeyFoldingCase(entry.headingPath);
    view.headingPathByAnyFile.set(entry.sectionFile, entry.headingPath);
    view.headingPathByHeadingKey.set(key, entry.headingPath);
    if (entry.headingLevel === HeadingLevel.beforeFirstHeading) {
      view.bodyPathByHeadingKey.set(key, entry.absolutePath);
      continue;
    }
    view.headingPathByHeadingNodeFile.set(entry.sectionFile, entry.headingPath);
    view.headingNodeFileByHeadingKey.set(key, entry.sectionFile);
    if (!entry.isSubSkeleton) view.bodyPathByHeadingKey.set(key, entry.absolutePath);
  }
  return view;
}

/**
 * Heading paths this proposal owns on `docPath`, by section-file identity
 * against current canonical. A tombstoned document owns nothing: the overlay
 * model reads it as empty and the deletion travels as a document target.
 */
export async function proposalOwnedHeadingKeys(
  proposalId: ProposalId,
  docPath: DocPath,
  status: ProposalStatus,
): Promise<string[][]> {
  const overlayRoot = proposalContentRoot(proposalId, status);
  const canonicalRoot = getContentRoot();
  if (overlayRoot === canonicalRoot) return [];
  if (!(await directoryExists(overlayRoot))) return [];
  if (await tombstoneFileExists(docPath, overlayRoot)) return [];

  const deletedSectionFiles = await loadDeletedSectionFiles(proposalId, docPath);
  const canonical = indexDocumentIdentities(
    docPath,
    await resolveEffectiveSkeletonNodes(docPath, canonicalRoot, canonicalRoot),
    canonicalRoot,
  );
  const effective = indexDocumentIdentities(
    docPath,
    await resolveEffectiveSkeletonNodes(docPath, overlayRoot, canonicalRoot, deletedSectionFiles),
    overlayRoot,
  );

  const owned: string[][] = [];
  const seen = new Set<string>();
  const own = (headingPath: string[]): void => {
    const key = headingKeyFoldingCase(headingPath);
    if (seen.has(key)) return;
    seen.add(key);
    owned.push(headingPath);
  };

  for (const [headingKey, headingNodeFile] of effective.headingNodeFileByHeadingKey) {
    const headingPath = effective.headingPathByHeadingKey.get(headingKey)!;
    const canonicalHeadingPath = canonical.headingPathByHeadingNodeFile.get(headingNodeFile);
    if (canonicalHeadingPath === undefined) {
      own(headingPath);
      continue;
    }
    if (headingKeyFoldingCase(canonicalHeadingPath) !== headingKey) own(headingPath);
  }

  for (const [headingKey, bodyPath] of effective.bodyPathByHeadingKey) {
    if (seen.has(headingKey)) continue;
    const overlayBody = await readFileIfExists(bodyPath);
    if (overlayBody === null) continue;
    const canonicalBodyPath = canonical.bodyPathByHeadingKey.get(headingKey);
    const canonicalBody = canonicalBodyPath === undefined
      ? null
      : await readFileIfExists(canonicalBodyPath);
    if (overlayBody !== canonicalBody) {
      own(effective.headingPathByHeadingKey.get(headingKey)!);
    }
  }

  for (const sectionFile of deletedSectionFiles) {
    const canonicalHeadingPath = canonical.headingPathByAnyFile.get(sectionFile);
    if (canonicalHeadingPath !== undefined) own(canonicalHeadingPath);
  }

  return owned;
}

/**
 * Doc paths this proposal's overlay carries on disk — top-level skeletons and
 * tombstone markers, never a file inside a `.sections/` directory. Used only to
 * decide which documents the claim check must inspect; absorb keeps deriving its
 * scope from the manifest and never gains a leftover-overlay walk.
 */
export async function listProposalOverlayDocumentPaths(
  proposalId: ProposalId,
  status: ProposalStatus,
): Promise<DocPath[]> {
  const overlayRoot = proposalContentRoot(proposalId, status);
  const docPaths: DocPath[] = [];
  for (const entry of await readDirentsIfExists(overlayRoot, { recursive: true })) {
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith(".md") && !entry.name.endsWith(TOMBSTONE_SUFFIX)) continue;
    const relPath = path
      .relative(overlayRoot, path.join(entry.parentPath, entry.name))
      .replace(/\\/g, "/");
    const segments = relPath.split("/");
    if (segments.slice(0, -1).some((segment) => segment.endsWith(".sections"))) continue;
    const contentRelativeFsPath = relPath.endsWith(TOMBSTONE_SUFFIX)
      ? relPath.slice(0, -TOMBSTONE_SUFFIX.length)
      : relPath;
    docPaths.push(docPathFromContentRelativeFsPath(contentRelativeFsPath));
  }
  return [...new Set(docPaths)];
}

/**
 * Every overlay-owned heading this proposal's manifest does not claim. Extra
 * claims are ignored — the manifest may name more than the overlay owns.
 */
export async function unclaimedOwnedHeadings(
  proposalId: ProposalId,
  status: ProposalStatus,
): Promise<OwnedHeadingAddress[]> {
  const claims = proposalSectionClaimsWithParsedDocPaths(await readProposal(proposalId));
  const claimedKeys = new Set(
    claims.map((claim) => `${claim.doc_path} ${headingKeyFoldingCase(claim.heading_path)}`),
  );
  const docPaths = new Set<DocPath>([
    ...(await listProposalOverlayDocumentPaths(proposalId, status)),
    ...claims.map((claim) => DocPath.parse(claim.doc_path)),
  ]);

  const unclaimed: OwnedHeadingAddress[] = [];
  for (const docPath of docPaths) {
    for (const headingPath of await proposalOwnedHeadingKeys(proposalId, docPath, status)) {
      if (claimedKeys.has(`${docPath} ${headingKeyFoldingCase(headingPath)}`)) continue;
      unclaimed.push({ docPath, headingPath });
    }
  }
  return unclaimed;
}
