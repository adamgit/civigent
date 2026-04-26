/**
 * Manual Publish via Transient Proposals
 *
 * Manual publish cherry-picks a scoped subset of the canonical-ready session
 * overlay into a transient proposal overlay, then commits that proposal to
 * canonical while the session stays alive.
 */

import {
  getAllSessions,
  pauseSessionOverlayImport,
  settleFragmentKeysFromLive,
  type DocSession,
} from "../crdt/ydoc-lifecycle.js";

import { getContentRoot } from "./data-root.js";
import { type AbsorbResult, type SectionRefReceipt } from "./canonical-store.js";
import { commitProposalToCanonicalDetailed } from "./commit-pipeline.js";
import { createTransientProposal, transitionToWithdrawn, updateProposalSections } from "./proposal-repository.js";
import { OverlayContentLayer } from "./content-layer.js";
import { SectionRef } from "../domain/section-ref.js";
import type { WriterIdentity, SectionTargetRef } from "../types/shared.js";
import { bodyAsFragment, buildFragmentContent } from "./section-formatting.js";

export interface AutoCommitDocCommit {
  docPath: string;
  commitSha: string;
  sectionsPublished: SectionTargetRef[];
  contributorIds: string[];
  publisherClearedHeadingPaths: string[][];
}

export interface AutoCommitResult {
  committed: boolean;
  commitSha?: string;
  sectionsPublished: SectionTargetRef[];
  docCommits: AutoCommitDocCommit[];
}

function getDirtyFragmentKeysForWriter(
  session: DocSession,
  writerId: string,
): Set<string> {
  return new Set(session.perUserDirty.get(writerId) ?? []);
}

/**
 * Publish a writer's unpublished session content from canonical-ready session
 * files while the session stays alive.
 */
export async function publishUnpublishedSections(
  writer: WriterIdentity,
  docPath?: string,
  headingPaths?: string[][],
): Promise<AutoCommitResult> {
  void headingPaths;
  const sessions = getAllSessions();
  const activeSessions: Array<{
    session: DocSession;
    selectedFragmentKeys: Set<string>;
  }> = [];
  for (const session of sessions.values()) {
    if (!session.holders.has(writer.id)) continue;
    if (docPath && session.docPath !== docPath) continue;
    const selectedFragmentKeys = getDirtyFragmentKeysForWriter(session, writer.id);
    if (selectedFragmentKeys.size === 0) continue;
    activeSessions.push({ session, selectedFragmentKeys });
  }

  if (activeSessions.length === 0) {
    return { committed: false, sectionsPublished: [], docCommits: [] };
  }

  const allSectionsPublished: SectionTargetRef[] = [];
  const docCommits: AutoCommitDocCommit[] = [];
  let lastCommitSha: string | undefined;

  for (const active of activeSessions) {
    const { session, selectedFragmentKeys } = active;
    await pauseSessionOverlayImport(session.docPath);

    const normalizeResult = await settleFragmentKeysUntilStable(session, selectedFragmentKeys);
    const currentSectionRefs = dedupeSectionRefs(normalizeResult.writtenSectionRefs);
    const deletedOriginalSectionRefs = dedupeSectionRefs(normalizeResult.deletedSectionRefs);
    const absorbedSectionRefs = dedupeSectionRefs([
      ...currentSectionRefs,
      ...deletedOriginalSectionRefs,
    ]);
    const committedContributorIds = collectCommittedContributorIds(session, [
      ...selectedFragmentKeys,
      ...normalizeResult.writtenKeys,
      ...normalizeResult.deletedKeys,
    ]);
    const commitCoAuthors = resolveCommitContributorIdentities(session, committedContributorIds)
      .filter((contributor) => contributor.id !== writer.id);

    const absorbResult = await commitScopedPublishProposal(
      writer,
      session,
      currentSectionRefs,
      deletedOriginalSectionRefs,
      absorbedSectionRefs,
      commitCoAuthors,
    );

    lastCommitSha = absorbResult.commitSha;
    session.baseHead = absorbResult.commitSha;

    const cleanupFragmentKeys = new Set<string>([
      ...selectedFragmentKeys,
      ...normalizeResult.writtenKeys,
      ...normalizeResult.deletedKeys,
    ]);
    const committedCleanupFragmentKeys = filterCommittedCleanupFragmentKeys(
      session,
      cleanupFragmentKeys,
    );
    await session.liveFragments.applyAbsorbedFragmentCleanup(
      session.stagedSections,
      committedCleanupFragmentKeys,
    );
    clearWriterDirtyKeys(
      session,
      writer.id,
      [...selectedFragmentKeys].filter((fragmentKey) => committedCleanupFragmentKeys.has(fragmentKey)),
    );

    const sectionsPublished = absorbResult.changedSections.map(toSectionTargetRef);
    const normalizedSessionDocPath = normalizeDocPath(session.docPath);
    const publisherClearedHeadingPaths = absorbResult.absorbedSectionRefs
      .filter((ref) => ref.docPath === normalizedSessionDocPath)
      .map((ref) => [...ref.headingPath]);

    allSectionsPublished.push(...sectionsPublished);
    docCommits.push({
      docPath: session.docPath,
      commitSha: absorbResult.commitSha,
      sectionsPublished,
      contributorIds: committedContributorIds,
      publisherClearedHeadingPaths,
    });
  }

  if (docCommits.length === 0) {
    return { committed: false, sectionsPublished: [], docCommits: [] };
  }

  return {
    committed: true,
    commitSha: lastCommitSha,
    sectionsPublished: allSectionsPublished,
    docCommits,
  };
}

// ─── PreemptiveCommitResult ───────────────────────────────────────

export interface PreemptiveCommitResult {
  committedSha: string;
  affectedWriters: Array<{ writerId: string }>;
}

async function settleFragmentKeysUntilStable(
  session: DocSession,
  fragmentKeys: Set<string>,
  maxPasses = 5,
): Promise<{
  writtenKeys: string[];
  deletedKeys: string[];
  writtenSectionRefs: SectionRefReceipt[];
  deletedSectionRefs: SectionRefReceipt[];
}> {
  const pending = new Set(fragmentKeys);
  const writtenKeys = new Set<string>();
  const deletedKeys = new Set<string>();
  const writtenSectionRefs: SectionRefReceipt[] = [];
  const deletedSectionRefs: SectionRefReceipt[] = [];

  for (let pass = 0; pass < maxPasses && pending.size > 0; pass++) {
    const result = await settleFragmentKeysFromLive(session, pending);
    pending.clear();
    for (const key of result.staleKeys) {
      pending.add(key);
    }
    for (const key of result.writtenKeys) {
      writtenKeys.add(key);
    }
    for (const key of result.deletedKeys) {
      deletedKeys.add(key);
    }
    writtenSectionRefs.push(...result.writtenSectionRefs);
    deletedSectionRefs.push(...result.deletedSectionRefs);
  }

  if (pending.size > 0) {
    throw new Error(
      `Publish for "${session.docPath}" could not settle fragment scope after ${maxPasses} passes: ` +
      `${[...pending].join(", ")}`,
    );
  }

  return {
    writtenKeys: [...writtenKeys],
    deletedKeys: [...deletedKeys],
    writtenSectionRefs: dedupeSectionRefs(writtenSectionRefs),
    deletedSectionRefs: dedupeSectionRefs(deletedSectionRefs),
  };
}

async function commitScopedPublishProposal(
  writer: WriterIdentity,
  session: DocSession,
  currentPublishedSectionRefs: SectionRefReceipt[],
  deletedOriginalSectionRefs: SectionRefReceipt[],
  absorbedSectionRefs: SectionRefReceipt[],
  coAuthors: WriterIdentity[],
): Promise<AbsorbResult> {
  const { id: proposalId, contentRoot: proposalContentRoot } = await createTransientProposal(
    writer,
    buildPublishProposalIntent(session),
  );
  let committed = false;

  try {
    const sessionOverlay = new OverlayContentLayer(session.stagedSections.stagingRoot, getContentRoot());
    const proposalOverlay = new OverlayContentLayer(proposalContentRoot, getContentRoot());

    await stageDeletedSectionsForPublish(proposalOverlay, deletedOriginalSectionRefs);
    await stageCurrentPublishedSectionsForPublish(
      sessionOverlay,
      proposalOverlay,
      currentPublishedSectionRefs,
    );
    await updateProposalSections(
      proposalId,
      absorbedSectionRefs.map((ref) => ({
        doc_path: ref.docPath,
        heading_path: [...ref.headingPath],
      })),
    );

    const absorbResult = await commitProposalToCanonicalDetailed(
      proposalId,
      {},
      undefined,
      {
        commitMessageOverride: buildPublishCommitMessage(writer, coAuthors),
        authorOverride: {
          name: writer.displayName,
          email: writer.email ?? "human@knowledge-store.local",
        },
      },
    );
    committed = true;
    return absorbResult;
  } catch (error) {
    if (!committed) {
      await transitionToWithdrawn(
        proposalId,
        `manual publish failed for ${normalizeDocPath(session.docPath)}`,
      ).catch(() => {});
    }
    throw error;
  }
}

function buildPublishCommitMessage(writer: WriterIdentity, coAuthors: WriterIdentity[]): string {
  let commitMessage =
    `human edit: ${writer.displayName}\n\nWriter: ${writer.id}\nWriter-Type: ${writer.type}`;
  if (coAuthors.length > 0) {
    commitMessage += "\n" + coAuthors
      .map((contributor) =>
        `Co-authored-by: ${contributor.displayName} <${contributor.email ?? `${contributor.id}@knowledge-store.local`}>`)
      .join("\n");
  }
  return commitMessage;
}

function buildPublishProposalIntent(session: DocSession): string {
  return `Manual publish: ${normalizeDocPath(session.docPath)}`;
}

async function stageDeletedSectionsForPublish(
  proposalOverlay: OverlayContentLayer,
  deletedOriginalSectionRefs: SectionRefReceipt[],
): Promise<void> {
  const deletedByDoc = [...deletedOriginalSectionRefs]
    .sort((a, b) => b.headingPath.length - a.headingPath.length);
  for (const ref of deletedByDoc) {
    await proposalOverlay.deleteSubtree(ref.docPath, ref.headingPath);
  }
}

async function stageCurrentPublishedSectionsForPublish(
  sessionOverlay: OverlayContentLayer,
  proposalOverlay: OverlayContentLayer,
  currentPublishedSectionRefs: SectionRefReceipt[],
): Promise<void> {
  for (const ref of dedupeSectionRefs(currentPublishedSectionRefs)) {
    await stageSectionForPublish(ref.docPath, ref.headingPath, sessionOverlay, proposalOverlay);
  }
}

async function stageSectionForPublish(
  docPath: string,
  headingPath: string[],
  sessionOverlay: OverlayContentLayer,
  proposalOverlay: OverlayContentLayer,
): Promise<void> {
  const ref = new SectionRef(docPath, headingPath);
  const body = await sessionOverlay.readSection(ref);
  const { level } = await sessionOverlay.resolveSectionPathWithLevel(docPath, headingPath);
  const fragmentContent = headingPath.length === 0
    ? bodyAsFragment(body)
    : buildFragmentContent(body, level, headingPath[headingPath.length - 1] ?? "");
  await proposalOverlay.upsertSection(
    ref,
    headingPath[headingPath.length - 1] ?? "",
    fragmentContent,
    { contentIsFullMarkdown: true },
  );
}

function filterCommittedCleanupFragmentKeys(
  session: DocSession,
  fragmentKeys: Iterable<string>,
): Set<string> {
  const committed = new Set<string>();
  for (const fragmentKey of fragmentKeys) {
    if (session.liveFragments.isAheadOfStaged(fragmentKey)) continue;
    committed.add(fragmentKey);
  }
  return committed;
}

function clearWriterDirtyKeys(
  session: DocSession,
  writerId: string,
  fragmentKeys: Iterable<string>,
): void {
  const dirtySet = session.perUserDirty.get(writerId);
  if (!dirtySet) return;
  for (const fragmentKey of fragmentKeys) {
    dirtySet.delete(fragmentKey);
  }
}

function collectCommittedContributorIds(
  session: DocSession,
  fragmentKeys: Iterable<string>,
): string[] {
  return session.liveFragments.getWriterIdsForFragments(fragmentKeys);
}

function resolveCommitContributorIdentities(
  session: DocSession,
  writerIds: Iterable<string>,
): WriterIdentity[] {
  const identities: WriterIdentity[] = [];
  const seen = new Set<string>();
  for (const writerId of writerIds) {
    if (seen.has(writerId)) continue;
    seen.add(writerId);
    const holderIdentity = session.holders.get(writerId)?.identity;
    const contributorIdentity = session.contributors.get(writerId);
    identities.push(
      holderIdentity
      ?? contributorIdentity
      ?? {
        id: writerId,
        type: "human",
        displayName: writerId,
        email: `${writerId}@knowledge-store.local`,
      },
    );
  }
  return identities;
}

function dedupeSectionRefs(sectionRefs: SectionRefReceipt[]): SectionRefReceipt[] {
  const seen = new Set<string>();
  const deduped: SectionRefReceipt[] = [];
  for (const ref of sectionRefs) {
    const key = `${ref.docPath}\0${ref.headingPath.join(">>")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ docPath: ref.docPath, headingPath: [...ref.headingPath] });
  }
  return deduped;
}

function toSectionTargetRef(ref: SectionRefReceipt): SectionTargetRef {
  return {
    doc_path: ref.docPath,
    heading_path: [...ref.headingPath],
  };
}

function normalizeDocPath(docPath: string): string {
  return docPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

// preemptiveImportNormalizeAndCommit was dissolved into the restore and overwrite
// routes (BNATIVE.8c). The inline store boundary pattern replaces the legacy pipeline.

// commitAllDirtySessions was deleted by BNATIVE.8b. Crash recovery at startup
// handles the case where the server dies with dirty sessions — raw fragment
// sidecars + session overlay files survive on disk and are recovered by
// detectAndRecoverCrash. The shutdown handler was best-effort anyway (SIGKILL,
// OOM, power loss all bypass it).
