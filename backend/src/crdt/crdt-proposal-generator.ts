/**
 * CRDTProposalGenerator — the boundary component owning live↔canonical traffic
 * for one live `DocSession` / document Y.Doc (spec 01-data-primitives §3 Named
 * components "CRDTProposalGenerator"; spec 10 §One active proposal per
 * DocSession; spec 05 §Proposal Publication, §Structural Normalization).
 *
 * One instance per active `DocSession`. It is instantiated and torn down by the
 * DocSession actor / YDocLifecycleManager. It does NOT subscribe to the Y.Doc
 * directly here — the DocSession actor feeds it ordered commands (first-edit /
 * subsequent-edit materialization, per-section quiescence, publish-trigger
 * evaluation, publish) so that all Y.Doc/proposal-boundary work is serialized
 * through the actor's single command lane (spec 10 §DocSession actor ownership).
 *
 * State ownership: the latent-proposal model. The generator keeps NO parallel
 * durable snapshot. The current `inprogress` proposal content tree carries the
 * in-flight live CRDT activity; on restart/remount the Y.Doc is reconstructable
 * from it. Durability flows through `ProposalEditor` over `DocumentSkeleton`,
 * never `sessions/` and never a raw-fragment sidecar (spec 05 §Session
 * Persistence).
 *
 * Y.transact discipline (both directions): every structural mutation of the
 * Y.Doc — live→canonical normalization and canonical→live deltas — runs inside
 * a single `Y.transact(...)` so peers/observers see pre- or post-state, never an
 * intermediate. The expensive compute happens outside the transaction against a
 * snapshot; only the precomputed delta application runs inside, with a pre-flight
 * clock check (optimistic concurrency: abort + retry on Y.Doc movement). There
 * is exactly ONE primitive used in both directions; there is no `reinjection`
 * path.
 */

import * as Y from "yjs";
import type { WriterIdentity, ProposalAdoptionId, ProposalId, PublishTriggerDecision, PublishBlocker } from "../types/shared.js";
import type {
  ProposalSection,
  InProgressProposal,
  HumanInvolvementCommittedProposalMetadata,
} from "../types/shared.js";
import { ProposalEditor } from "../storage/proposal-editor.js";
import {
  getOrCreateInProgressProposalForAdoptionId,
  findInProgressProposalByAdoptionId,
  updateCurrentProposalSections,
  unionCurrentProposalSections,
  rollbackCommittingProposal,
} from "../storage/proposal-repository.js";
import { commitProposalToCanonicalDetailed } from "../storage/commit-pipeline.js";
import type { AbsorbResult } from "../storage/canonical-store.js";
import type { UpsertSectionFromMarkdownDetailedResult } from "../storage/content-layer.js";
import type { FlatEntry } from "../storage/document-skeleton.js";
import { SectionRef } from "../domain/section-ref.js";
import { EMPTY_BODY, type SectionBody } from "../storage/section-formatting.js";
import { synthesizeCommitDescription } from "../storage/commit-description.js";
import type { DocPath } from "../types/shared.js";

/**
 * One materialized section of the live document, as observed from the live Y.Doc
 * at materialization time. The DocSession actor produces these from the live
 * fragment store (Y.Doc → fragment string roundtrip); the generator does not
 * reach into the Y.Doc fragment layout itself.
 */
export interface LiveSectionSnapshot {
  /** Heading path of this section (empty for the before-first-heading root). */
  headingPath: string[];
  /** Leaf heading text (empty string for the before-first-heading root). */
  heading: string;
  /** Heading level (0 for the before-first-heading root). */
  level: number;
  /** Effective body markdown for the section (no embedded heading line). */
  body: SectionBody;
  /**
   * The live Y.Doc fragment key backing this section. Lets the generator scope a
   * per-edit materialization to ONLY the touched fragments (C4) without
   * re-resolving the layout.
   */
  fragmentKey: string;
}

/**
 * Per-edit materialization scope (C4). When present, the materialization write
 * loop + manifest narrow to ONLY the touched live fragments (plus whatever
 * ancestors the engine must auto-create), instead of the whole document — so the
 * live `inprogress` proposal's lock claim grows section-by-section as edited,
 * rather than locking every section against agents on the first keystroke. Absent
 * = whole-document materialization (finalize/publish, cross-section move).
 */
export interface MaterializeScope {
  touchedFragmentKeys: string[];
}

/**
 * The authoritative structural delta of a materialization, aggregated from each
 * `ProposalEditor.writeSection`'s `UpsertSectionFromMarkdownDetailedResult` (C4).
 * It is the SINGLE source of truth for which sections were written/removed and
 * how live fragment identity remapped — consumed by the manifest sync (and, for
 * the live Y.Doc reconcile, by the actor) instead of re-deriving via layout
 * set-diff.
 */
export interface MaterializeDelta {
  writtenEntries: FlatEntry[];
  removedEntries: FlatEntry[];
  fragmentKeyRemaps: Array<{ from: string; to: string | null }>;
  structureChanges: Array<{ oldEntry: FlatEntry; newEntries: FlatEntry[] }>;
  liveReloadEntries: FlatEntry[];
}

export interface AwaitingStructuralReconciliationSection {
  fragmentKey: string;
  headingPath: string[];
  heading: string;
  level: number;
}

export interface LiveSectionsSnapshotResult {
  sections: LiveSectionSnapshot[];
  awaitingStructuralReconciliation: AwaitingStructuralReconciliationSection[];
}

export class LiveSnapshotIdentityInvariantError extends Error {
  readonly dirtyFragmentKeys: readonly string[];

  constructor(docPath: DocPath, dirtyFragmentKeys: readonly string[]) {
    super(
      `Live snapshot identity invariant failed for ${docPath}: fragment(s) ` +
        `${dirtyFragmentKeys.join(", ")} still disagree with their layout address; ` +
        `refusing to mint SectionBody or publish.`,
    );
    this.name = "LiveSnapshotIdentityInvariantError";
    this.dirtyFragmentKeys = dirtyFragmentKeys;
  }
}

/**
 * The live-document view the generator materializes from. Supplied by the
 * DocSession actor so the generator stays decoupled from the Y.Doc fragment
 * adapter. `snapshotSections` must reflect the *current, settled* live tree.
 */
export interface LiveDocumentSource {
  snapshotSections(): Promise<LiveSectionsSnapshotResult> | LiveSectionsSnapshotResult;
  /** Writer ids that have contributed live edits, for co-author attribution. */
  contributingWriterIds?(): Iterable<string>;
}

export interface CRDTProposalGeneratorOptions {
  docPath: DocPath;
  proposalAdoptionId: ProposalAdoptionId;
  /** Identity recorded as the proposal writer (the DocSession owner). */
  writer: WriterIdentity;
  /** The live-document materialization source owned by the DocSession actor. */
  source: LiveDocumentSource;
  /**
   * Committed-metadata builder for the proposal commit. Defaults to a minimal
   * DocSession metadata stub; the actor may supply richer authorship/HI data.
   */
  buildCommittedMetadata?: (proposal: InProgressProposal) => HumanInvolvementCommittedProposalMetadata;
  /** Override the default publish-trigger policy (e.g. demand-gated tuning). */
  publishTriggerPolicy?: PublishTriggerPolicy;
  /**
   * Adopt an existing `inprogress` proposal at construction time (spec 10 §One
   * active proposal per DocSession; C1 recovery path). When a DocSession is
   * reconstructed for a document that already has a durable `inprogress`
   * proposal, the actor passes that proposal's id here so the generator's first
   * materialization resolves to the SAME proposal instead of forking a second
   * one via `ensureCurrentProposal`.
   */
  initialProposalId?: ProposalId;
}

/**
 * Inputs the DocSession actor provides for a publish-trigger decision. These are
 * the actor-observed session boundaries from spec 10 §Default publish-trigger
 * policy — the policy itself is pure (no timers, no Y.Doc access).
 */
export interface PublishTriggerSignals {
  /**
   * Rule 1: a forced canonical operation (restore, admin rebuild, shutdown)
   * requires the live document to be preserved into canonical before
   * proceeding. Publish-or-abort.
   */
  forcedCanonicalOperation: boolean;
  /** Rule 2: the last editor socket for the DocSession has disconnected. */
  lastEditorLeft: boolean;
  /**
   * There is a bound `inprogress` proposal to publish — adopted on reconstruction
   * OR created by an edit. This is "is there anything to publish", NOT "did this
   * attachment author it": the autonomous-publish caller applies the stricter
   * authored-edit gate itself before consulting the policy.
   */
  hasCurrentProposal: boolean;
  /**
   * Rule 3 prerequisites (settled dirty frontier). ALL must hold:
   *  - the actor has processed every inbound Yjs update already received
   *  - no paste/drop/undo-redo burst/IME composition/programmatic command or
   *    structural normalization is in progress
   *  - no section topology change from the current proposal is still being
   *    normalized or followed by adjacent structural edits
   *  - users have moved out of the changed section-set (or are only viewing)
   *  - collaborators are not actively mutating the changed/adjacent section-set
   */
  allInboundUpdatesProcessed: boolean;
  noBurstOrCompositionInProgress: boolean;
  noTopologyChangeInFlight: boolean;
  usersLeftChangedSections: boolean;
  noCollaboratorMutatingChangedSet: boolean;
}

/**
 * The publish-trigger decision — the single evaluation output. Defined in shared
 * so the frontend prose can consume the exact object the backend runtime decides on.
 * Re-exported here because this module owns the evaluator that produces it.
 */
export type { PublishTriggerDecision, PublishBlocker } from "../types/shared.js";

/**
 * The settled-dirty-frontier gates, as blockers. The list IS the decision: publish
 * fires (settled) exactly when it is empty. Derived here, in the evaluator, so the
 * runtime `shouldPublish` and the UI's "what's holding it" cannot disagree.
 */
function settledDirtyFrontierBlockers(signals: PublishTriggerSignals): PublishBlocker[] {
  const blockers: PublishBlocker[] = [];
  if (!signals.allInboundUpdatesProcessed) blockers.push({ kind: "inboundUpdatesPending" });
  if (!signals.noBurstOrCompositionInProgress) blockers.push({ kind: "activeEditingInProgress" });
  if (!signals.noTopologyChangeInFlight) blockers.push({ kind: "structureSettling" });
  if (!signals.usersLeftChangedSections) blockers.push({ kind: "editorInChangedSection" });
  if (!signals.noCollaboratorMutatingChangedSet) blockers.push({ kind: "recentChangesApplying" });
  return blockers;
}

/**
 * Default rule-ordered publish-trigger policy (spec 10 §Default publish-trigger
 * policy). Deterministic, based on observed session boundaries, NOT a freshness
 * timer. Absorbs the idle/quiescence baseline that previously lived in
 * `session-quiescence-policy.ts`: a section is "quiet" when no CRDT activity has
 * touched it for the configured threshold, and that quietness is one of the
 * inputs the actor folds into `noBurstOrCompositionInProgress` /
 * `usersLeftChangedSections`.
 *
 * There is deliberately no maximum-age / freshness cap. A proposal is never
 * published merely because time passed.
 */
export class PublishTriggerPolicy {
  /**
   * The per-section CRDT-activity quiescence threshold (spec 05 §Structural
   * Normalization "1–3 seconds"). A tuning parameter owned by this policy.
   */
  readonly quiescenceThresholdMs: number;

  constructor(opts: { quiescenceThresholdMs?: number } = {}) {
    this.quiescenceThresholdMs = opts.quiescenceThresholdMs ?? 2_000;
  }

  /** True when a fragment has had no CRDT activity for the quiescence threshold. */
  isFragmentQuiescent(lastActivityMs: number, nowMs = Date.now()): boolean {
    return nowMs - lastActivityMs >= this.quiescenceThresholdMs;
  }

  /**
   * Evaluate the rule-ordered policy. The first applicable rule fires.
   *
   * Rule 1 (forced canonical op) fires even with no current proposal: a forced
   * operation must establish the publish pause and publish-or-abort regardless,
   * so the caller can preserve / abort. Rules 2 and 3 require a current proposal
   * (there is nothing to publish otherwise).
   *
   * The settled-dirty-frontier rule is intentionally conservative: it requires
   * the actor to have PROVEN that earlier socket updates have reached it
   * (`allInboundUpdatesProcessed`). The operational proof — freezing editors and
   * collecting ordered `doc_publish_ready` acks — is the publish pause itself;
   * this rule only decides whether it is safe to START that pause.
   */
  evaluate(signals: PublishTriggerSignals): PublishTriggerDecision {
    if (signals.forcedCanonicalOperation) {
      return { shouldPublish: true, rule: "forced-canonical-op", blockers: [] };
    }
    if (!signals.hasCurrentProposal) {
      return { shouldPublish: false, rule: "none", blockers: [] };
    }
    if (signals.lastEditorLeft) {
      return { shouldPublish: true, rule: "last-editor-left", blockers: [] };
    }
    const blockers = settledDirtyFrontierBlockers(signals);
    if (blockers.length === 0) {
      return { shouldPublish: true, rule: "settled-dirty-frontier", blockers: [] };
    }
    return { shouldPublish: false, rule: "none", blockers };
  }
}

/** Result of a publish attempt driven through the DocSession publish pause. */
export interface PublishResult {
  status: "committed" | "failed-returned-to-inprogress" | "noop-no-proposal";
  proposalId?: ProposalId;
  commitSha?: string;
  absorbResult?: AbsorbResult;
  error?: unknown;
}

export class CRDTProposalGenerator {
  readonly docPath: DocPath;
  readonly proposalAdoptionId: ProposalAdoptionId;
  private readonly writer: WriterIdentity;
  private readonly source: LiveDocumentSource;
  private readonly buildCommittedMetadata?: (proposal: InProgressProposal) => HumanInvolvementCommittedProposalMetadata;
  /** Publish-trigger policy owned by this generator (spec 10). */
  readonly publishTriggerPolicy: PublishTriggerPolicy;

  /**
   * The proposal this DocSession is BOUND to: the adopted stranded `inprogress`
   * proposal on reconstruction (set from `initialProposalId`), or the proposal
   * lazily created on the first materialized edit. This is the "which proposal am
   * I working in" reference every consumer needs — live seeding, edit
   * arbitration, lock arbitration, canonical-delta loopback, the last-editor
   * leave-path flush, and finalize. Cleared only by a successful publish (spec 10
   * §One active proposal). NOTE: being bound does NOT imply this attachment
   * authored anything — an adopted-but-untouched session is bound with no
   * authored edit. See `authoredProposalId`.
   */
  private boundProposalId: ProposalId | null = null;

  /**
   * The proposal THIS attachment has actually authored into: `null` until this
   * generator materializes its own edit (`materializeEdit` /
   * `materializeEditDetailed`), and cleared again by a successful publish. Unlike
   * `boundProposalId` it is NOT set by adoption — so it is the truthful "there is
   * ≥1 materialized edit from this attachment" signal, and the sole basis for the
   * autonomous (quiescence) publish decision. An adopted proposal must never be
   * autonomously published by a session that never wrote into it.
   */
  private authoredProposalId: ProposalId | null = null;

  constructor(opts: CRDTProposalGeneratorOptions) {
    this.docPath = opts.docPath;
    this.proposalAdoptionId = opts.proposalAdoptionId;
    this.writer = opts.writer;
    this.source = opts.source;
    this.buildCommittedMetadata = opts.buildCommittedMetadata;
    this.publishTriggerPolicy = opts.publishTriggerPolicy ?? new PublishTriggerPolicy();
    // Adoption binds the generator to the stranded proposal but does NOT count as
    // an authored edit (authoredProposalId stays null until first materialize).
    this.boundProposalId = opts.initialProposalId ?? null;
  }

  /**
   * Evaluate the rule-ordered publish-trigger policy against actor-observed
   * session signals (spec 10 §Default publish-trigger policy). `hasCurrentProposal`
   * is supplied from this generator's own state so callers cannot disagree with it.
   */
  evaluatePublishTrigger(
    signals: Omit<PublishTriggerSignals, "hasCurrentProposal">,
  ): PublishTriggerDecision {
    return this.publishTriggerPolicy.evaluate({
      ...signals,
      hasCurrentProposal: this.hasCurrentProposal(),
    });
  }

  /**
   * The current `inprogress` proposal id, or null before the first edit / after
   * a successful publish. No side-effects (spec 10: zero-edit session has no
   * proposal).
   */
  getCurrentProposalId(): ProposalId | null {
    return this.boundProposalId;
  }

  /**
   * True once this DocSession is bound to a proposal (adopted on reconstruction
   * OR lazily created by an edit) and it has not yet been published. This is the
   * "is there a proposal to work in / to publish" predicate; it does NOT imply
   * this attachment authored anything — use {@link hasAuthoredEdit} for that.
   */
  hasCurrentProposal(): boolean {
    return this.boundProposalId !== null;
  }

  /**
   * True once THIS attachment has materialized at least one edit of its own. The
   * truthful "≥1 materialized edit" signal (distinct from adoption), and the sole
   * gate for autonomous publish: a session that merely adopted a stranded
   * proposal must never autonomously publish work it never authored.
   */
  hasAuthoredEdit(): boolean {
    return this.authoredProposalId !== null;
  }

  /**
   * The writer identity recorded for this DocSession's proposals (the DocSession
   * owner). Used as the aggregate `writer` for the `content:committed` event on an
   * autonomous publish — DocSession publishes are not HI-scored and may aggregate
   * several human contributors, so a system/aggregate owner identity is acceptable
   * (Claim 1, task 4; spec 06 §7).
   */
  getWriterIdentity(): WriterIdentity {
    return this.writer;
  }

  /**
   * The live writer ids that contributed edits this session, for `contributor_ids`
   * on the `content:committed` event (the same set the generator tracks for
   * co-author attribution in commit metadata). Falls back to the DocSession owner
   * when the source tracks no distinct contributors.
   */
  getContributorIds(): string[] {
    const ids = [...(this.source.contributingWriterIds?.() ?? [])];
    return ids.length > 0 ? ids : [this.writer.id];
  }

  // ─── Lazy first-edit + subsequent-edit materialization ────────────

  /**
   * Materialize the current live document into the DocSession's single
   * `inprogress` proposal content tree.
   *
   * On the FIRST materialized edit (no current proposal), this lazily creates
   * the one `inprogress` proposal for the DocSession via the repository helper,
   * caches its id, and materializes the edit into it. Subsequent calls
   * materialize into the SAME proposal until a successful publish clears the
   * reference (spec 10 §One active proposal per DocSession; spec 01 First-edit
   * and materialization path).
   *
   * Returns the proposal id the edit was materialized into.
   */
  async materializeEdit(scope?: MaterializeScope): Promise<ProposalId> {
    const proposalId = await this.ensureCurrentProposal();
    await this.materializeIntoProposal(proposalId, scope);
    // This attachment has now authored an edit into the bound proposal — the only
    // event that arms the autonomous publish gate (distinct from mere adoption).
    this.authoredProposalId = proposalId;
    return proposalId;
  }

  /**
   * As {@link materializeEdit} but ALSO returns the aggregated engine structural
   * delta (C4), so the DocSession actor can drive the live Y.Doc reconcile from
   * the authoritative remaps/structureChanges rather than re-deriving them.
   */
  async materializeEditDetailed(
    scope?: MaterializeScope,
  ): Promise<{ proposalId: ProposalId; delta: MaterializeDelta }> {
    const proposalId = await this.ensureCurrentProposal();
    const delta = await this.materializeIntoProposal(proposalId, scope);
    // This attachment has now authored an edit into the bound proposal — the only
    // event that arms the autonomous publish gate (distinct from mere adoption).
    this.authoredProposalId = proposalId;
    return { proposalId, delta };
  }

  /**
   * Ensure the DocSession owns its single `inprogress` proposal, creating it
   * lazily if needed. Idempotent and one-active-proposal-safe: a second call
   * (or a concurrent DocSession lookup) returns the same proposal because the
   * repository helper keys on DocSession identity and enforces the invariant.
   */
  /**
   * Release both the bound and authored references after a publish that removed
   * the proposal from `inprogress` (successful commit, or a proposal that vanished
   * under us). The next edit re-binds and re-arms from scratch. Kept as one
   * primitive so the two references can never drift out of a half-cleared state.
   */
  private clearProposalBinding(): void {
    this.boundProposalId = null;
    this.authoredProposalId = null;
  }

  async ensureCurrentProposal(): Promise<ProposalId> {
    if (this.boundProposalId !== null) return this.boundProposalId;

    const created = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId: this.proposalAdoptionId,
      docPath: this.docPath,
      writer: this.writer,
    });
    this.boundProposalId = created.id;
    return created.id;
  }

  async ensureAuthoredProposalClaiming(sections: ProposalSection[]): Promise<ProposalId> {
    const proposalId = await this.ensureCurrentProposal();
    this.authoredProposalId = proposalId;
    if (sections.length > 0) {
      await unionCurrentProposalSections(proposalId, this.dedupSections(sections));
    }
    return proposalId;
  }

  /**
   * Write the live document into the proposal content tree through
   * `ProposalEditor` over `DocumentSkeleton`, then update the proposal's section
   * manifest. When `scope` is present (per-edit path, C4) ONLY the touched
   * fragments are written and the manifest grows MONOTONICALLY by the engine's
   * written/removed entries; when absent (finalize/publish) the WHOLE document is
   * materialized and the manifest is replaced with the full section set. Returns
   * the aggregated engine structural delta.
   */
  private async materializeIntoProposal(
    proposalId: ProposalId,
    scope?: MaterializeScope,
  ): Promise<MaterializeDelta> {
    const snapshot = await this.source.snapshotSections();
    const editor = ProposalEditor.open(proposalId, "inprogress");

    const awaitingByKey = new Map(
      snapshot.awaitingStructuralReconciliation.map((entry) => [entry.fragmentKey, entry]),
    );
    const deferredAsSnapshots: LiveSectionSnapshot[] = snapshot.awaitingStructuralReconciliation.map(
      (entry) => ({
        headingPath: [...entry.headingPath],
        heading: entry.heading,
        level: entry.level,
        body: EMPTY_BODY,
        fragmentKey: entry.fragmentKey,
      }),
    );
    const toWrite = scope
      ? snapshot.sections.filter((s) => scope.touchedFragmentKeys.includes(s.fragmentKey))
      : snapshot.sections;
    const deferredTouched = scope
      ? scope.touchedFragmentKeys
          .map((key) => awaitingByKey.get(key))
          .filter((entry): entry is AwaitingStructuralReconciliationSection => entry !== undefined)
      : snapshot.awaitingStructuralReconciliation;

    if (
      scope &&
      scope.touchedFragmentKeys.length > 0 &&
      toWrite.length === 0 &&
      deferredTouched.length === 0
    ) {
      throw new Error(
        `Scoped materialization for ${this.docPath} touched ${scope.touchedFragmentKeys.length} ` +
          `fragment(s) (${scope.touchedFragmentKeys.join(", ")}) but none map to a live section — ` +
          `refusing to update the proposal with an empty (data-losing) no-op.`,
      );
    }

    const delta: MaterializeDelta = {
      writtenEntries: [],
      removedEntries: [],
      fragmentKeyRemaps: [],
      structureChanges: [],
      liveReloadEntries: [],
    };

    for (const section of toWrite) {
      const result = await editor.materializeSectionBody(
        this.docPath,
        section.headingPath,
        section.body,
      );
      this.accumulateDelta(delta, result);
    }

    if (scope) {
      const claimSections: LiveSectionSnapshot[] = [
        ...toWrite,
        ...deferredTouched.map((entry) => ({
          headingPath: [...entry.headingPath],
          heading: entry.heading,
          level: entry.level,
          body: EMPTY_BODY,
          fragmentKey: entry.fragmentKey,
        })),
      ];
      await this.growProposalManifest(proposalId, delta, claimSections);
    } else {
      await this.replaceProposalManifest(proposalId, [
        ...snapshot.sections,
        ...deferredAsSnapshots,
      ]);
    }
    return delta;
  }

  /** Union one engine write result into the running aggregate delta. */
  private accumulateDelta(delta: MaterializeDelta, result: UpsertSectionFromMarkdownDetailedResult): void {
    delta.writtenEntries.push(...result.writtenEntries);
    delta.removedEntries.push(...result.removedContentEntries);
    delta.fragmentKeyRemaps.push(...result.fragmentKeyRemaps);
    delta.structureChanges.push(...result.structureChanges);
    delta.liveReloadEntries.push(...result.liveReloadEntries);
  }

  /**
   * Per-edit manifest growth (C4 / U1): UNION the heading paths the engine
   * actually WROTE (body-bearing entries only) into the proposal's existing
   * section claim. The manifest only ever GROWS as the live document is edited —
   * a section a live edit REMOVES from the overlay is NOT dropped from the
   * manifest: it stays claimed-but-absent, which is the delete signal the
   * manifest-scoped merge reads (01 §3 "Manifest-scoped overlay (universal)";
   * 10 §15). This keeps the live proposal the same kind of object as every other
   * proposal — one law, no live opt-out — while still locking only the edited
   * section-set.
   *
   * Acceptance-gate invariant: `scopedSections` here is derived from the
   * `touchedFragmentKeys` passed to `materializeEdit(...)`. The CRDT live-edit
   * acceptance gate filters those keys to accepted-only before calling
   * `materializeEdit(...)` (see `processArbitratedClientUpdate(...)` in the
   * WebSocket coordinator), so `growProposalManifest(...)` NEVER receives a
   * rejected fragment. Rejected live edits therefore cannot create proposal
   * manifest claims.
   */
  private async growProposalManifest(
    proposalId: ProposalId,
    delta: MaterializeDelta,
    scopedSections: LiveSectionSnapshot[],
  ): Promise<void> {
    // Claim BOTH the body-bearing entries the engine wrote (incl. auto-created
    // ancestors) AND every explicitly-scoped touched section. The latter matters
    // when a scoped section's verbatim body write is idempotent (no delta) — e.g.
    // a live REORDER flushes source/target whose bodies are unchanged: those
    // sections are still being structurally claimed by this proposal and MUST
    // enter the manifest, or the change is lost on publish (an empty manifest
    // materializes nothing). Grow-only union, so over-claiming is safe.
    const add = this.dedupSections([
      ...delta.writtenEntries
        .filter((e) => !e.isSubSkeleton)
        .map((e) => ({ doc_path: this.docPath, heading_path: [...e.headingPath] })),
      ...scopedSections.map((s) => ({ doc_path: this.docPath, heading_path: [...s.headingPath] })),
    ]);
    await unionCurrentProposalSections(proposalId, add);
  }

  /** Whole-document manifest (finalize/publish): replace with the full section set. */
  private async replaceProposalManifest(proposalId: ProposalId, sections: LiveSectionSnapshot[]): Promise<void> {
    const manifest = this.dedupSections(
      sections.map((section) => ({ doc_path: this.docPath, heading_path: [...section.headingPath] })),
    );
    await updateCurrentProposalSections(proposalId, manifest);
  }

  private dedupSections(sections: ProposalSection[]): ProposalSection[] {
    const seen = new Set<string>();
    const out: ProposalSection[] = [];
    for (const section of sections) {
      const key = SectionRef.headingKey(section.heading_path);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(section);
    }
    return out;
  }

  // ─── Structural normalization (per-section quiescence) ─────────────

  /**
   * Normalize the live Y.Doc structure for a quiesced section: resolve embedded
   * headings, heading deletions, and heading-level changes (spec 05 §Structural
   * Normalization (driven by CRDTProposalGenerator)).
   *
   * The trigger is per-section CRDT-activity quiescence detected by the actor's
   * observation surface — NOT a 60s timer, NOT MSG_SECTION_FOCUS, NOT
   * session-end. The mutation runs inside the shared `Y.transact` primitive with
   * compute-outside / apply-inside discipline and a pre-flight clock check.
   *
   * `computeDelta` runs OUTSIDE the transaction against a fresh snapshot and
   * returns the precomputed structural delta to apply, or null when the section
   * is already normalized (no-op). `applyDelta` runs INSIDE the transaction.
   */
  async normalizeQuiescedSection<TDelta>(
    ydoc: Y.Doc,
    affectedFragmentKeys: readonly string[],
    computeDelta: () => Promise<TDelta | null> | TDelta | null,
    applyDelta: (delta: TDelta) => void,
  ): Promise<{ applied: boolean }> {
    return this.runIdentityPreservingTransaction(
      ydoc,
      affectedFragmentKeys,
      computeDelta,
      applyDelta,
    );
  }

  /**
   * Bootstrap an empty document's live Y.Doc with a synthetic before-first-heading
   * fragment so the first edit has a section to land in (salvaged empty-doc BFH
   * bootstrap, formerly in the session-acquire path). Caller supplies the seed
   * applier; this only enforces the Y.transact discipline.
   */
  bootstrapEmptyDocument(ydoc: Y.Doc, seed: () => void): void {
    ydoc.transact(seed);
  }

  // ─── Shared Y.transact primitive (both directions) ────────────────

  /**
   * The single Y.transact-based mutation primitive used by BOTH directions —
   * live→canonical structural normalization and canonical→live committed deltas
   * (spec 01 "One primitive, both directions"; spec 05 §Structural
   * Normalization). Expensive compute runs outside the transaction; only the
   * precomputed delta application runs inside, guarded by a pre-flight clock
   * check that aborts+retries if the Y.Doc moved between snapshot and apply.
   *
   * @param ydoc the live Y.Doc
   * @param affectedFragmentKeys fragment keys the delta touches (for the
   *   pre-flight clock check)
   * @param computeDelta precompute against a snapshot, OUTSIDE the transaction
   * @param applyDelta apply the precomputed delta, INSIDE the transaction
   * @param maxRetries optimistic-concurrency retry budget
   */
  private async runIdentityPreservingTransaction<TDelta>(
    ydoc: Y.Doc,
    affectedFragmentKeys: readonly string[],
    computeDelta: () => Promise<TDelta | null> | TDelta | null,
    applyDelta: (delta: TDelta) => void,
    maxRetries = 3,
  ): Promise<{ applied: boolean }> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Snapshot the affected fragments' state vector BEFORE computing the delta.
      const preStateVector = this.fragmentClock(ydoc, affectedFragmentKeys);

      const delta = await computeDelta();
      if (delta === null) return { applied: false };

      let applied = false;
      ydoc.transact(() => {
        // Pre-flight clock check: if any affected fragment moved between snapshot
        // and transaction open, abort this attempt and retry with a fresh snapshot.
        const nowVector = this.fragmentClock(ydoc, affectedFragmentKeys);
        if (nowVector !== preStateVector) {
          return; // leaves `applied` false → outer loop retries
        }
        applyDelta(delta);
        applied = true;
      });

      if (applied) return { applied: true };
    }
    // Exhausted retries — the section kept moving; leave it for the next
    // quiescence trigger rather than forcing a non-atomic write.
    return { applied: false };
  }

  /**
   * Compute a cheap fingerprint of the affected fragments' Yjs clocks, used as
   * the optimistic-concurrency pre-flight check. Any client edit to an affected
   * fragment advances its clock, so a mismatch means the Y.Doc moved.
   */
  private fragmentClock(ydoc: Y.Doc, affectedFragmentKeys: readonly string[]): string {
    const sv = Y.encodeStateVector(ydoc);
    // The full state vector is sufficient: any update to any fragment advances
    // it. We keep it scoped-by-key in the signature so a future, finer-grained
    // implementation can narrow the check without changing callers.
    void affectedFragmentKeys;
    return Buffer.from(sv).toString("base64");
  }

  // ─── Final materialization + commit (publish) ─────────────────────

  /**
   * Perform final materialization of the live Y.Doc into the current proposal
   * and commit it to canonical (spec 05 §Proposal Publication; spec 10
   * §DocSession publish pause steps 8–12). This MUST be called by the DocSession
   * actor only after the publish pause is established and every required editor
   * socket has acknowledged readiness — the generator does not own the pause
   * FSM (that is the DocSession actor's responsibility).
   *
   * On success the current-proposal reference is cleared so the next edit
   * lazily creates the next `inprogress` proposal. On failure the proposal is
   * returned to `inprogress` (kept as the DocSession current proposal) and the
   * reference is retained so editing resumes into the same proposal (spec 10
   * §Publish failure handling).
   */
  async finalizeAndPublish(): Promise<PublishResult> {
    if (this.boundProposalId === null) {
      return { status: "noop-no-proposal" };
    }
    const proposalId = this.boundProposalId;

    // The EDITED section-set IS the proposal's manifest (U1–U4: the manifest tracks
    // exactly what this session created / edited / deleted — claimed-but-absent for
    // deletes). The audit-log description reflects what was CHANGED this session
    // (spec 10 §Commit-description synthesis), not every section in the document.
    const editedProposal = await findInProgressProposalByAdoptionId(this.proposalAdoptionId);
    const changedSections = (editedProposal?.sections ?? []).map((s) => ({ headingPath: s.heading_path }));

    // Final materialization is MANIFEST-SCOPED (U4), not whole-document: flush the
    // current live content of exactly the claimed sections into the proposal
    // overlay. Inherited (unclaimed) sections are NOT written — absorb inherits them
    // live from current canonical via the manifest merge; claimed-but-absent deletes
    // are not in the live snapshot, so they stay deleted. By publish time the actor
    // has processed every inbound update (publish-trigger precondition), so every
    // edited section is already claimed — the manifest is the complete change-set.
    const claimedHeadingKeys = new Set(
      (editedProposal?.sections ?? []).map((s) => SectionRef.headingKey(s.heading_path)),
    );
    const liveSnapshot = await this.source.snapshotSections();
    const dirtyClaimedKeys = liveSnapshot.awaitingStructuralReconciliation
      .filter((entry) => claimedHeadingKeys.has(SectionRef.headingKey(entry.headingPath)))
      .map((entry) => entry.fragmentKey);
    if (dirtyClaimedKeys.length > 0) {
      throw new LiveSnapshotIdentityInvariantError(this.docPath, dirtyClaimedKeys);
    }
    const touchedFragmentKeys = liveSnapshot.sections
      .filter((s) => claimedHeadingKeys.has(SectionRef.headingKey(s.headingPath)))
      .map((s) => s.fragmentKey);
    try {
      await this.materializeIntoProposal(proposalId, { touchedFragmentKeys });
    } catch (error) {
      if (error instanceof LiveSnapshotIdentityInvariantError) throw error;
      return { status: "failed-returned-to-inprogress", proposalId, error };
    }

    const proposal = await findInProgressProposalByAdoptionId(this.proposalAdoptionId);
    if (!proposal) {
      // The proposal vanished from under us (e.g. concurrent admin op). Treat as
      // a no-op publish rather than committing stale state.
      this.clearProposalBinding();
      return { status: "noop-no-proposal" };
    }

    const committedMetadata: HumanInvolvementCommittedProposalMetadata =
      this.buildCommittedMetadata ? this.buildCommittedMetadata(proposal) : {};

    // Synthesize the audit-log description from the session's changed section-set
    // at publish time (spec 10 §Commit-description synthesis), not from early raw
    // activity. No preferred-narrative classifier is wired in V1, so this is the
    // honest conservative fallback derived from the changed section-set.
    const descriptionHeadline = synthesizeCommitDescription({ changedSections });

    try {
      const absorbResult = await commitProposalToCanonicalDetailed(
        proposalId,
        committedMetadata,
        undefined,
        // DocSession caller context: a runtime publish failure returns the
        // proposal to `inprogress` (kept as the DocSession current proposal),
        // NOT `draft` (spec 02 › Why `committing`). The pipeline owns this
        // rollback via `ownerKind`; the catch below is a defensive fallback.
        //
        // Manifest-scoped absorb (U4): a DocSession publish is the SAME sparse
        // section merge as every other proposal — current canonical overlaid by
        // this proposal's manifest (edits applied, claimed-but-absent deletes
        // dropped, unclaimed sections inherited). There is NO `wholeDocumentRewrite`
        // opt-out; only true document-target ops (restore/import/delete/rename) take
        // the wholesale path, gated by their document targets in the pipeline.
        { ownerKind: "docsession", descriptionHeadline },
      );
      // Successful commit clears both the bound and authored references; the next
      // edit lazily creates and re-arms the next inprogress proposal.
      this.clearProposalBinding();
      return {
        status: "committed",
        proposalId,
        commitSha: absorbResult.commitSha,
        absorbResult,
      };
    } catch (error) {
      // Runtime commit failure: the pipeline already rolled the proposal back to
      // `inprogress` via `ownerKind: "docsession"`. This is a defensive fallback
      // for the case the pipeline failed BEFORE its own rollback ran (e.g.
      // `transitionToCommitting` itself threw after a partial rename); it is a
      // best-effort no-op when the proposal is already back at `inprogress`.
      try {
        await rollbackCommittingProposal(proposalId, "docsession");
      } catch {
        // Already rolled back (proposal not in `committing`) — expected.
      }
      // Keep both references pointing at the same proposal: editing resumes into
      // it, and an attachment that had authored edits stays armed to retry publish.
      return { status: "failed-returned-to-inprogress", proposalId, error };
    }
  }

  /**
   * Apply a committed canonical delta back into the live Y.Doc through the
   * shared Y.transact primitive (spec 01 "One primitive, both directions"; spec
   * 05 §Proposal Publication: agent/human deltas still apply back into any
   * active live Y.Doc). This is the generator's responsibility, explicitly NOT a
   * `canonical-store` responsibility (Area C boundary): `canonical-store` only
   * produces the `AbsorbResult`; translating it into a live Y.Doc delta lives
   * here.
   *
   * `computeDelta` builds the precomputed delta from the committed canonical
   * state OUTSIDE the transaction; `applyDelta` applies it INSIDE.
   */
  async applyCanonicalDeltaToLive<TDelta>(
    ydoc: Y.Doc,
    affectedFragmentKeys: readonly string[],
    computeDelta: () => Promise<TDelta | null> | TDelta | null,
    applyDelta: (delta: TDelta) => void,
  ): Promise<{ applied: boolean }> {
    return this.runIdentityPreservingTransaction(
      ydoc,
      affectedFragmentKeys,
      computeDelta,
      applyDelta,
    );
  }
}
