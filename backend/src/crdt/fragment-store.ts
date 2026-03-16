/**
 * FragmentStore — Y.Doc ↔ Disk Content Boundary
 *
 * Single owner of fragment content format knowledge. Fragments store
 * heading+body content (the heading is the first node in the Y.XmlFragment,
 * editable inline). Root sections (level=0, heading="") store body only.
 *
 * Pairs a Y.Doc with a DocumentSkeleton — operations that must touch
 * both (construct, flush, assemble) are methods here.
 */

import * as Y from "yjs";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { markdownToJSON, jsonToMarkdown } from "@ks/milkdown-serializer";
import { yDocToProsemirrorJSON, prosemirrorJSONToYDoc } from "y-prosemirror";
import { getContentRoot, getSessionDocsRoot } from "../storage/data-root.js";
import { DocumentSkeleton, type FlatEntry } from "../storage/document-skeleton.js";
import { parseDocumentMarkdown } from "../storage/markdown-sections.js";
import { SectionRef } from "../domain/section-ref.js";
import {
  ROOT_FRAGMENT_KEY,
  fragmentKeyFromSectionFile,
  sectionFileFromFragmentKey,
  getBackendSchema,
} from "./ydoc-fragments.js";

// ─── Flush result ────────────────────────────────────────────────

export interface FlushResult {
  /** Fragment keys whose content was written to disk during this flush. */
  writtenKeys: string[];
  /** Fragment keys that were deleted (due to heading renames/removals). */
  deletedKeys: string[];
}

// ─── Normalization result ─────────────────────────────────────────

export interface NormalizeResult {
  /** Whether the fragment was structurally changed (split, rename, level change, etc.). */
  changed: boolean;
  /** New fragment keys created by the normalization (if any). */
  createdKeys: string[];
  /** Fragment keys removed by the normalization (if any). */
  removedKeys: string[];
}

// ─── FragmentStore ───────────────────────────────────────────────

export class FragmentStore {
  /** The Y.Doc instance. Callers need direct access for WS sync
   *  (Y.applyUpdate, Y.encodeStateVector, Y.encodeStateAsUpdate).
   *  Content reads/writes MUST go through FragmentStore methods. */
  readonly ydoc: Y.Doc;

  /** The skeleton. Callers need access for structural queries
   *  (flat, resolve, structure) and for focus→fragmentKey mapping.
   *  Structural mutations during flush are internal to FragmentStore. */
  readonly skeleton: DocumentSkeleton;

  readonly docPath: string;

  /** Fragment keys modified since last flush. Updated on Y.Doc changes,
   *  cleared after successful flush. Separate from perUserDirty which
   *  tracks per-user attribution for the Mirror panel. */
  readonly dirtyKeys = new Set<string>();

  private constructor(ydoc: Y.Doc, skeleton: DocumentSkeleton, docPath: string) {
    this.ydoc = ydoc;
    this.skeleton = skeleton;
    this.docPath = docPath;
  }

  // ─── Construction ──────────────────────────────────────────────

  /**
   * Build a FragmentStore from disk: loads skeleton, bulk-reads section
   * content, populates Y.Doc fragments.
   *
   * Prefers raw fragments (sessions/fragments/) when available — these are
   * the freshest content (heading + body). Falls back to the overlay
   * (sessions/docs/) + canonical path for sections without raw fragments.
   */
  static async fromDisk(docPath: string): Promise<FragmentStore> {
    // Lazy import to avoid circular dependency (session-store imports from ydoc-lifecycle)
    const {
      listRawFragments,
      readRawFragment,
    } = await import("../storage/session-store.js");
    const { ContentLayer } = await import("../storage/content-layer.js");

    const ydoc = new Y.Doc();
    const overlayRoot = path.join(getSessionDocsRoot(), "content");
    const canonicalRoot = getContentRoot();

    const skeleton = await DocumentSkeleton.fromDisk(docPath, overlayRoot, canonicalRoot);

    if (skeleton.isEmpty) {
      return new FragmentStore(ydoc, skeleton, docPath);
    }

    // Check for raw fragment files (crash-safe format, freshest content)
    const rawFiles = await listRawFragments(docPath);
    const rawFileSet = new Set(rawFiles);

    // Build a map of sectionFile → raw content for quick lookup
    const rawContentMap = new Map<string, string>();
    for (const rawFile of rawFiles) {
      const content = await readRawFragment(docPath, rawFile);
      if (content !== null) {
        rawContentMap.set(rawFile, content);
      }
    }

    // Bulk-read overlay content as fallback via ContentLayer
    const canonical = new ContentLayer(canonicalRoot);
    const overlay = new ContentLayer(overlayRoot, canonical);
    const bulkContent = await overlay.readAllSectionsOverlaid(docPath);

    // Pass 1: collect encoded updates and raw fragment keys via forEachSection
    const pendingUpdates: Uint8Array[] = [];
    const rawFragmentKeys: string[] = [];

    skeleton.forEachSection((heading, level, sectionFile, headingPath, _absolutePath, _isSubSkeleton) => {
      const isRoot = level === 0 && heading === "";
      const fragmentKey = fragmentKeyFromSectionFile(sectionFile, isRoot);

      let sectionContent: string;

      if (rawFileSet.has(sectionFile)) {
        // Raw fragment contains heading + body — use as-is (heading is first node)
        sectionContent = (rawContentMap.get(sectionFile) ?? "").replace(/\n+$/, "");
        rawFragmentKeys.push(fragmentKey);
      } else {
        // Fallback: read from overlay/canonical (body-only files)
        const headingKey = SectionRef.headingKey([...headingPath]);
        const bodyContent = (bulkContent?.get(headingKey) ?? "").replace(/\n+$/, "");
        if (isRoot) {
          sectionContent = bodyContent;
        } else {
          // Prepend heading to body-only content to match fragment format
          const headingLine = `${"#".repeat(level)} ${heading}`;
          sectionContent = bodyContent.trim()
            ? `${headingLine}\n\n${bodyContent}`
            : headingLine;
        }
      }

      const pmJson = markdownToJSON(sectionContent || "");
      const tempDoc = prosemirrorJSONToYDoc(getBackendSchema(), pmJson, fragmentKey);
      pendingUpdates.push(Y.encodeStateAsUpdate(tempDoc));
      tempDoc.destroy();
    });

    if (pendingUpdates.length > 0) {
      const merged = Y.mergeUpdates(pendingUpdates);
      Y.applyUpdate(ydoc, merged);
    }

    const store = new FragmentStore(ydoc, skeleton, docPath);

    // Pass 2: normalize any sections that had raw fragments
    for (const fragmentKey of rawFragmentKeys) {
      await store.normalizeStructure(fragmentKey);
    }

    return store;
  }

  /**
   * Strip the leading heading line from markdown content to get body-only.
   * Fragments store "## Heading\n\nBody..." — this extracts just "Body...".
   * Used when writing canonical-ready (body-only) files to sessions/docs/.
   */
  static stripHeadingFromContent(markdown: string, level: number): string {
    const headingPrefix = "#".repeat(level) + " ";
    const lines = markdown.split("\n");
    if (lines.length > 0 && lines[0].startsWith(headingPrefix)) {
      // Remove heading line and any blank line after it
      let startIdx = 1;
      while (startIdx < lines.length && lines[startIdx].trim() === "") {
        startIdx++;
      }
      return lines.slice(startIdx).join("\n").replace(/\n+$/, "");
    }
    return markdown.replace(/\n+$/, "");
  }

  // ─── Fragment key derivation ───────────────────────────────────

  /** Derive the fragment key for a skeleton flat entry. */
  static fragmentKeyFor(entry: FlatEntry): string {
    const isRoot = entry.level === 0 && entry.heading === "";
    return fragmentKeyFromSectionFile(entry.sectionFile, isRoot);
  }

  /** Derive the fragment key for a section file ID. */
  static fragmentKeyForFileId(sectionFileId: string, isRoot: boolean): string {
    return fragmentKeyFromSectionFile(sectionFileId, isRoot);
  }

  // ─── Dirty tracking ────────────────────────────────────────────

  /** Mark a fragment key as dirty (modified since last flush). */
  markDirty(fragmentKey: string): void {
    this.dirtyKeys.add(fragmentKey);
  }

  // ─── Content reads ─────────────────────────────────────────────

  /**
   * Read body-only content from a fragment, suitable for canonical disk writing.
   * Strips the leading heading line (fragments store heading+body).
   */
  readBodyForDisk(fragmentKey: string): string {
    const full = this.extractMarkdown(fragmentKey);
    // Find the skeleton entry to get the level for heading stripping
    const sectionFileId = sectionFileFromFragmentKey(fragmentKey);
    try {
      const entry = this.skeleton.resolveByFileId(sectionFileId);
      const isRoot = entry.level === 0 && entry.heading === "";
      if (isRoot) return full;
      return FragmentStore.stripHeadingFromContent(full, entry.level);
    } catch {
      // If we can't resolve the entry, return as-is
      return full;
    }
  }

  /**
   * Read the full fragment content (heading + body) from the Y.Doc.
   * Non-root fragments include their heading as the first node.
   */
  readFullContent(fragmentKey: string): string {
    return this.extractMarkdown(fragmentKey);
  }

  /**
   * Read the current heading text from a fragment's content.
   * Fragments include their heading as the first node.
   */
  readFragmentHeading(fragmentKey: string): string | null {
    try {
      const pmJson = yDocToProsemirrorJSON(this.ydoc, fragmentKey) as any;
      if (!pmJson?.content) return null;
      for (const node of pmJson.content) {
        if (node.type === "heading" && node.content) {
          return node.content
            .filter((child: any) => child.type === "text")
            .map((child: any) => child.text ?? "")
            .join("");
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Read the live full content (heading+body) from the Y.Doc for a fragment.
   * Returns the current in-memory content (no disk staleness).
   * Returns null if the fragment key does not exist or has no content.
   */
  readLiveBody(fragmentKey: string): string | null {
    try {
      const body = this.extractMarkdown(fragmentKey);
      return body || null;
    } catch {
      return null;
    }
  }

  /**
   * Bulk-read all live content from the Y.Doc for every section in the skeleton.
   * Returns Map<headingKey, string> with the same key shape as readAllSectionsWithOverlay.
   * Only includes entries that have live Y.Doc content (non-null readLiveBody).
   */
  readAllLiveContent(): Map<string, string> {
    const result = new Map<string, string>();
    this.skeleton.forEachSection((heading, level, sectionFile, headingPath, _absolutePath, isSubSkeleton) => {
      if (isSubSkeleton) return;
      const isRoot = level === 0 && heading === "";
      const fragmentKey = fragmentKeyFromSectionFile(sectionFile, isRoot);
      const live = this.readLiveBody(fragmentKey);
      if (live != null) {
        result.set(SectionRef.headingKey([...headingPath]), live);
      }
    });
    return result;
  }

  /**
   * Assemble the complete document markdown from all fragments.
   * Fragments store heading+body, so just concatenate them.
   */
  assembleMarkdown(): string {
    if (this.skeleton.isEmpty) return "";

    const parts: string[] = [];
    this.skeleton.forEachSection((heading, level, sectionFile, _headingPath, _absolutePath, _isSubSkeleton) => {
      const isRoot = level === 0 && heading === "";
      const fragmentKey = fragmentKeyFromSectionFile(sectionFile, isRoot);

      try {
        const content = this.extractMarkdown(fragmentKey);
        if (content.trim()) {
          parts.push(content);
        }
      } catch {
        // Fragment missing — skip
      }
    });

    return parts.join("\n\n");
  }

  // ─── Flush ─────────────────────────────────────────────────────

  /**
   * Flush dirty fragments to disk (dual-format).
   *
   * For every dirty fragment:
   * 1. Write raw fragment file to sessions/fragments/ (always — crash-safe)
   * 2. Check structural cleanness (no embedded headings beyond what skeleton expects)
   * 3. Write canonical-ready to sessions/docs/ only when structurally clean
   *
   * Flush never performs structural analysis or Y.Doc restructuring —
   * that is normalizeStructure()'s job.
   */
  async flush(): Promise<FlushResult> {
    if (this.dirtyKeys.size === 0) {
      return { writtenKeys: [], deletedKeys: [] };
    }

    // Snapshot and clear dirtyKeys at start of flush
    const keysToFlush = new Set(this.dirtyKeys);
    this.dirtyKeys.clear();

    // Lazy import to avoid circular dependency (session-store imports from fragment-store)
    const { writeRawFragment } = await import("../storage/session-store.js");

    const writtenKeys: string[] = [];

    // Ensure overlay skeleton exists before writing body files
    await this.skeleton.ensureOverlayExists();

    for (const fragmentKey of keysToFlush) {
      const sectionFileId = sectionFileFromFragmentKey(fragmentKey);

      let entry: FlatEntry;
      try {
        entry = this.skeleton.resolveByFileId(sectionFileId);
      } catch {
        continue;
      }
      const isRoot = entry.level === 0 && entry.heading === "";

      // 1. Always write raw fragment (heading + body) for crash safety
      const rawMarkdown = this.reconstructFullMarkdown(fragmentKey, entry.level, entry.heading);
      await writeRawFragment(this.docPath, entry.sectionFile, rawMarkdown);

      // 2. Check structural cleanness
      const clean = this.isStructurallyClean(rawMarkdown, entry, isRoot);

      // 3. Write canonical-ready (body-only) to sessions/docs/ only when clean
      if (clean) {
        const body = isRoot
          ? this.extractMarkdown(fragmentKey)
          : FragmentStore.stripHeadingFromContent(this.extractMarkdown(fragmentKey), entry.level);
        await mkdir(path.dirname(entry.absolutePath), { recursive: true });
        await writeFile(entry.absolutePath, body.replace(/\n+$/, "") + "\n", "utf8");
      }

      writtenKeys.push(fragmentKey);
    }

    // Persist skeleton if modified
    if (this.skeleton.dirty) {
      await this.skeleton.persist();
    }

    return { writtenKeys, deletedKeys: [] };
  }

  // ─── Normalization ─────────────────────────────────────────────

  /**
   * Normalize a fragment's structure after edits.
   *
   * Reads the fragment content from in-memory Y.Doc, parses full markdown
   * (heading + body), and detects structural changes (splits, renames,
   * level changes, deletions). Applies the appropriate skeleton + Y.Doc
   * mutations, writes updated raw fragments + canonical-ready files, and
   * broadcasts STRUCTURE_WILL_CHANGE as a one-phase notification.
   *
   * Cases handled (each implemented in separate checklist items):
   * - Root body edit (no-op)
   * - Root split (headings typed in root section)
   * - Simple body edit (no-op)
   * - Heading rename
   * - Heading level change
   * - Section split (additional headings in non-root section)
   * - Heading deletion / empty section
   *
   * @param fragmentKey The fragment key to normalize
   * @param opts.broadcastStructureChange Callback to send STRUCTURE_WILL_CHANGE to clients
   */
  async normalizeStructure(
    fragmentKey: string,
    opts?: {
      broadcastStructureChange?: (info: Array<{ oldKey: string; newKeys: string[] }>) => void;
    },
  ): Promise<NormalizeResult> {
    const entry = this.resolveEntryForKey(fragmentKey);
    if (!entry) return { changed: false, createdKeys: [], removedKeys: [] };

    const isRoot = entry.level === 0 && entry.heading === "";
    const fullMarkdown = this.reconstructFullMarkdown(fragmentKey, entry.level, entry.heading);
    const parsed = parseDocumentMarkdown(fullMarkdown);
    const realSections = parsed.filter(s => s.headingPath.length > 0);

    // Check if structurally clean — no normalization needed
    if (this.isStructurallyClean(fullMarkdown, entry, isRoot)) {
      return { changed: false, createdKeys: [], removedKeys: [] };
    }

    // Structural change detected — dispatch to appropriate handler.
    // Individual case implementations are added by subsequent checklist items.

    if (isRoot && realSections.length > 0) {
      // Root split: user typed heading(s) inside root section
      return this.normalizeRootSplit(fragmentKey, entry, parsed, realSections, opts);
    }

    if (!isRoot && realSections.length === 1) {
      if (realSections[0].heading !== entry.heading && realSections[0].level === entry.level) {
        // Heading rename
        return this.normalizeHeadingRename(fragmentKey, entry, realSections[0], opts);
      }
      if (realSections[0].level !== entry.level) {
        // Heading level change (may also include rename)
        return this.normalizeHeadingLevelChange(fragmentKey, entry, realSections[0], opts);
      }
      if (parsed.length > 1) {
        // Heading relocated: matching heading found but orphan content before it.
        // Rewrite fragment with heading at start, appending orphan content to body.
        return this.normalizeHeadingRelocated(fragmentKey, entry, parsed, realSections[0], opts);
      }
    }

    if (!isRoot && realSections.length >= 2) {
      // Section split
      return this.normalizeSectionSplit(fragmentKey, entry, realSections, opts);
    }

    if (!isRoot && realSections.length === 0) {
      // Heading deletion / empty section
      return this.normalizeHeadingDeletion(fragmentKey, entry, parsed, opts);
    }

    // Fallback: unrecognized structural change pattern — no-op for safety
    return { changed: false, createdKeys: [], removedKeys: [] };
  }

  // ─── Normalization case handlers (stubs — implemented by subsequent tasks) ──

  private async normalizeRootSplit(
    fragmentKey: string,
    entry: FlatEntry,
    parsed: ReturnType<typeof parseDocumentMarkdown>,
    realSections: ReturnType<typeof parseDocumentMarkdown>,
    opts?: { broadcastStructureChange?: (info: Array<{ oldKey: string; newKeys: string[] }>) => void },
  ): Promise<NormalizeResult> {
    const { writeRawFragment } = await import("../storage/session-store.js");

    // Trim root body to content before first heading
    const rootParsed = parsed.find(s => s.headingPath.length === 0);
    const rootBody = (rootParsed?.body ?? "").replace(/\n+$/, "");

    // Update root fragment in Y.Doc with trimmed body
    this.populateFragment(fragmentKey, rootBody);

    // Write root raw fragment + canonical-ready
    await writeRawFragment(this.docPath, entry.sectionFile, rootBody);
    await mkdir(path.dirname(entry.absolutePath), { recursive: true });
    await writeFile(entry.absolutePath, rootBody + "\n", "utf8");

    // Add new sections to skeleton
    const addedEntries = this.skeleton.addSectionsFromRootSplit(realSections);

    const createdKeys: string[] = [];
    const newKeyMapping: string[] = [];

    for (let i = 0, bodyIdx = 0; i < addedEntries.length; i++) {
      const addedEntry = addedEntries[i];
      if (addedEntry.isSubSkeleton) continue;

      const body = (realSections[bodyIdx]?.body ?? "").replace(/\n+$/, "");
      const addedIsRoot = addedEntry.level === 0 && addedEntry.heading === "";
      const newKey = fragmentKeyFromSectionFile(addedEntry.sectionFile, addedIsRoot);
      const fragmentContent = FragmentStore.buildFragmentContent(body, addedEntry.level, addedEntry.heading);

      // Create Y.Doc fragment for new section (heading+body)
      this.populateFragment(newKey, fragmentContent);

      // Write raw fragment (heading+body) + canonical-ready (body-only)
      await writeRawFragment(this.docPath, addedEntry.sectionFile, fragmentContent);
      await mkdir(path.dirname(addedEntry.absolutePath), { recursive: true });
      await writeFile(addedEntry.absolutePath, body + "\n", "utf8");

      createdKeys.push(newKey);
      newKeyMapping.push(newKey);
      bodyIdx++;
    }

    // Persist skeleton
    if (this.skeleton.dirty) {
      await this.skeleton.persist();
    }

    // Broadcast structure change (one-phase notification)
    if (opts?.broadcastStructureChange) {
      opts.broadcastStructureChange([{
        oldKey: fragmentKey,
        newKeys: [fragmentKey, ...newKeyMapping],
      }]);
    }

    return { changed: true, createdKeys, removedKeys: [] };
  }

  private async normalizeHeadingRename(
    fragmentKey: string,
    entry: FlatEntry,
    section: ReturnType<typeof parseDocumentMarkdown>[0],
    opts?: { broadcastStructureChange?: (info: Array<{ oldKey: string; newKeys: string[] }>) => void },
  ): Promise<NormalizeResult> {
    const { writeRawFragment, deleteRawFragment } = await import("../storage/session-store.js");

    // Update skeleton: replace old heading with new one
    const result = this.skeleton.replace(entry.headingPath, [section]);

    const createdKeys: string[] = [];
    const removedKeys: string[] = [];

    // The old fragment key may change (new sectionFile → new key)
    for (const addedEntry of result.added) {
      if (addedEntry.isSubSkeleton) continue;

      const newKey = fragmentKeyFromSectionFile(addedEntry.sectionFile, false);
      const body = section.body.replace(/\n+$/, "");
      const fragmentContent = FragmentStore.buildFragmentContent(body, addedEntry.level, addedEntry.heading);

      // Populate new Y.Doc fragment with heading+body
      this.populateFragment(newKey, fragmentContent);

      // Write raw fragment (heading+body) + canonical-ready (body-only)
      await writeRawFragment(this.docPath, addedEntry.sectionFile, fragmentContent);
      await mkdir(path.dirname(addedEntry.absolutePath), { recursive: true });
      await writeFile(addedEntry.absolutePath, body + "\n", "utf8");

      if (newKey !== fragmentKey) {
        createdKeys.push(newKey);
      }
    }

    // Clean up old fragment if key changed
    if (createdKeys.length > 0) {
      // Clear old Y.Doc fragment
      this.clearFragment(fragmentKey);
      await deleteRawFragment(this.docPath, entry.sectionFile);
      removedKeys.push(fragmentKey);
    }

    // Persist skeleton
    if (this.skeleton.dirty) {
      await this.skeleton.persist();
    }

    // Broadcast structure change
    if (opts?.broadcastStructureChange && (createdKeys.length > 0 || removedKeys.length > 0)) {
      opts.broadcastStructureChange([{
        oldKey: fragmentKey,
        newKeys: createdKeys.length > 0 ? createdKeys : [fragmentKey],
      }]);
    }

    return { changed: true, createdKeys, removedKeys };
  }

  private async normalizeHeadingLevelChange(
    fragmentKey: string,
    entry: FlatEntry,
    section: ReturnType<typeof parseDocumentMarkdown>[0],
    opts?: { broadcastStructureChange?: (info: Array<{ oldKey: string; newKeys: string[] }>) => void },
  ): Promise<NormalizeResult> {
    const { writeRawFragment, deleteRawFragment } = await import("../storage/session-store.js");

    // Update skeleton: replace with new level (nesting relationships may change)
    const result = this.skeleton.replace(entry.headingPath, [section]);

    const createdKeys: string[] = [];
    const removedKeys: string[] = [];

    for (const addedEntry of result.added) {
      if (addedEntry.isSubSkeleton) continue;

      const newKey = fragmentKeyFromSectionFile(addedEntry.sectionFile, false);
      const body = section.body.replace(/\n+$/, "");
      const fragmentContent = FragmentStore.buildFragmentContent(body, addedEntry.level, addedEntry.heading);

      // Populate new Y.Doc fragment (heading+body)
      this.populateFragment(newKey, fragmentContent);

      // Write raw fragment (heading+body) + canonical-ready (body-only)
      await writeRawFragment(this.docPath, addedEntry.sectionFile, fragmentContent);
      await mkdir(path.dirname(addedEntry.absolutePath), { recursive: true });
      await writeFile(addedEntry.absolutePath, body + "\n", "utf8");

      if (newKey !== fragmentKey) {
        createdKeys.push(newKey);
      }
    }

    // Clean up old fragment if key changed
    if (createdKeys.length > 0) {
      this.clearFragment(fragmentKey);
      await deleteRawFragment(this.docPath, entry.sectionFile);
      removedKeys.push(fragmentKey);
    }

    // Persist skeleton
    if (this.skeleton.dirty) {
      await this.skeleton.persist();
    }

    // Broadcast structure change
    if (opts?.broadcastStructureChange) {
      opts.broadcastStructureChange([{
        oldKey: fragmentKey,
        newKeys: createdKeys.length > 0 ? createdKeys : [fragmentKey],
      }]);
    }

    return { changed: true, createdKeys, removedKeys };
  }

  private async normalizeHeadingRelocated(
    fragmentKey: string,
    entry: FlatEntry,
    parsed: ReturnType<typeof parseDocumentMarkdown>,
    section: ReturnType<typeof parseDocumentMarkdown>[0],
    _opts?: { broadcastStructureChange?: (info: Array<{ oldKey: string; newKeys: string[] }>) => void },
  ): Promise<NormalizeResult> {
    const { writeRawFragment } = await import("../storage/session-store.js");

    // Collect orphan content that appeared before the heading
    const preamble = parsed
      .filter(s => s.headingPath.length === 0)
      .map(s => s.body)
      .join("\n")
      .replace(/\n+$/, "");

    // Combine: heading body first, then orphan preamble (preserves all content)
    const sectionBody = section.body.replace(/\n+$/, "");
    const combinedBody = sectionBody
      ? (preamble ? sectionBody + "\n\n" + preamble : sectionBody)
      : preamble;

    const fragmentContent = FragmentStore.buildFragmentContent(
      combinedBody.replace(/\n+$/, ""),
      entry.level,
      entry.heading,
    );

    // Rewrite Y.Doc fragment with heading at start
    this.populateFragment(fragmentKey, fragmentContent);

    // Write raw fragment (heading+body) + canonical-ready (body-only)
    await writeRawFragment(this.docPath, entry.sectionFile, fragmentContent);
    const canonicalBody = combinedBody.replace(/\n+$/, "");
    await mkdir(path.dirname(entry.absolutePath), { recursive: true });
    await writeFile(entry.absolutePath, canonicalBody + "\n", "utf8");

    return { changed: true, createdKeys: [], removedKeys: [] };
  }

  private async normalizeSectionSplit(
    fragmentKey: string,
    entry: FlatEntry,
    realSections: ReturnType<typeof parseDocumentMarkdown>,
    opts?: { broadcastStructureChange?: (info: Array<{ oldKey: string; newKeys: string[] }>) => void },
  ): Promise<NormalizeResult> {
    const { writeRawFragment, deleteRawFragment } = await import("../storage/session-store.js");

    // Replace old section with multiple new sections in skeleton
    const result = this.skeleton.replace(entry.headingPath, realSections);

    const createdKeys: string[] = [];

    // Clear old Y.Doc fragment
    this.clearFragment(fragmentKey);
    await deleteRawFragment(this.docPath, entry.sectionFile);

    // Create new Y.Doc fragments for each resulting section
    let bodyIdx = 0;
    for (const addedEntry of result.added) {
      if (addedEntry.isSubSkeleton) continue;

      const addedIsRoot = addedEntry.level === 0 && addedEntry.heading === "";
      const newKey = fragmentKeyFromSectionFile(addedEntry.sectionFile, addedIsRoot);
      const body = (realSections[bodyIdx]?.body ?? "").replace(/\n+$/, "");
      const fragmentContent = FragmentStore.buildFragmentContent(body, addedEntry.level, addedEntry.heading);

      // Populate new Y.Doc fragment (heading+body)
      this.populateFragment(newKey, fragmentContent);

      // Write raw fragment (heading+body) + canonical-ready (body-only)
      await writeRawFragment(this.docPath, addedEntry.sectionFile, fragmentContent);
      await mkdir(path.dirname(addedEntry.absolutePath), { recursive: true });
      await writeFile(addedEntry.absolutePath, body + "\n", "utf8");

      createdKeys.push(newKey);
      bodyIdx++;
    }

    // Persist skeleton
    if (this.skeleton.dirty) {
      await this.skeleton.persist();
    }

    // Broadcast structure change
    if (opts?.broadcastStructureChange) {
      opts.broadcastStructureChange([{
        oldKey: fragmentKey,
        newKeys: createdKeys,
      }]);
    }

    return { changed: true, createdKeys, removedKeys: [fragmentKey] };
  }

  private async normalizeHeadingDeletion(
    fragmentKey: string,
    entry: FlatEntry,
    parsed: ReturnType<typeof parseDocumentMarkdown>,
    opts?: { broadcastStructureChange?: (info: Array<{ oldKey: string; newKeys: string[] }>) => void },
  ): Promise<NormalizeResult> {
    const { writeRawFragment, deleteRawFragment } = await import("../storage/session-store.js");

    // Collect orphaned body text (content remaining after heading was deleted)
    const orphanedBody = parsed
      .filter(s => s.headingPath.length === 0)
      .map(s => s.body)
      .join("\n")
      .replace(/\n+$/, "");

    // Find the preceding body-holding section in document order.
    // Walk all sections, track the last non-sub-skeleton entry before the deleted one.
    const deletedSectionFile = entry.sectionFile;
    let prevEntry: FlatEntry | null = null;
    let prevKey: string = ROOT_FRAGMENT_KEY;
    let found = false;

    this.skeleton.forEachSection((heading, level, sectionFile, headingPath, absolutePath, isSubSkeleton) => {
      if (found || isSubSkeleton) return;
      if (sectionFile === deletedSectionFile) {
        found = true;
        return;
      }
      const isRoot = level === 0 && heading === "";
      prevEntry = {
        headingPath: [...headingPath],
        heading,
        level,
        sectionFile,
        absolutePath,
        isSubSkeleton: false,
      };
      prevKey = fragmentKeyFromSectionFile(sectionFile, isRoot);
    });

    // prevEntry is now the section just before the deleted one in document order.
    // If null (deleted section was the very first), fall back to root.
    let mergeTarget: FlatEntry | null = prevEntry;
    let mergeKey: string = prevKey;
    if (!mergeTarget) {
      try { mergeTarget = this.skeleton.resolveRoot(); } catch { mergeTarget = null; }
      mergeKey = ROOT_FRAGMENT_KEY;
    }
    const parentEntry = mergeTarget;
    const parentKey = mergeKey;

    // Append orphaned content to parent fragment (if any content exists)
    if (orphanedBody && parentEntry) {
      const existingContent = this.extractMarkdown(parentKey);
      const mergedContent = existingContent.trim()
        ? existingContent.replace(/\n+$/, "") + "\n\n" + orphanedBody
        : orphanedBody;
      this.populateFragment(parentKey, mergedContent);

      // Write updated parent raw fragment (heading+body) + canonical-ready (body-only)
      const parentRawMd = this.extractMarkdown(parentKey);
      await writeRawFragment(this.docPath, parentEntry.sectionFile, parentRawMd);
      const parentIsRoot = parentEntry.level === 0 && parentEntry.heading === "";
      const canonicalBody = parentIsRoot
        ? parentRawMd
        : FragmentStore.stripHeadingFromContent(parentRawMd, parentEntry.level);
      await mkdir(path.dirname(parentEntry.absolutePath), { recursive: true });
      await writeFile(parentEntry.absolutePath, canonicalBody.replace(/\n+$/, "") + "\n", "utf8");
    }

    // Remove old section from skeleton
    this.skeleton.replace(entry.headingPath, []);

    // Clear old Y.Doc fragment and delete raw file
    this.clearFragment(fragmentKey);
    await deleteRawFragment(this.docPath, entry.sectionFile);

    // Persist skeleton
    if (this.skeleton.dirty) {
      await this.skeleton.persist();
    }

    // Broadcast structure change
    if (opts?.broadcastStructureChange) {
      opts.broadcastStructureChange([{
        oldKey: fragmentKey,
        newKeys: [],
      }]);
    }

    return { changed: true, createdKeys: [], removedKeys: [fragmentKey] };
  }

  // ─── Private helpers ───────────────────────────────────────────

  /**
   * Check whether a fragment's content is structurally clean (no embedded
   * headings beyond what the skeleton expects). Clean fragments can be
   * written to canonical-ready; dirty ones need normalizeStructure().
   */
  private isStructurallyClean(fullMarkdown: string, entry: FlatEntry, isRoot: boolean): boolean {
    const parsed = parseDocumentMarkdown(fullMarkdown);
    const realSections = parsed.filter(s => s.headingPath.length > 0);

    if (isRoot) {
      // Root is clean if no real headings were typed inside it
      return realSections.length === 0;
    }

    // Non-root is clean if exactly 1 total parsed section (no orphan preamble
    // before the heading) with matching heading and level.
    if (parsed.length !== 1 || realSections.length !== 1) return false;
    return realSections[0].heading === entry.heading && realSections[0].level === entry.level;
  }

  /** Resolve a FlatEntry for a fragment key, or null if not found. */
  private resolveEntryForKey(fragmentKey: string): FlatEntry | null {
    const sectionFileId = sectionFileFromFragmentKey(fragmentKey);
    try {
      return this.skeleton.resolveByFileId(sectionFileId);
    } catch {
      return null;
    }
  }

  /** Extract markdown from a Y.Doc fragment. */
  private extractMarkdown(fragmentKey: string): string {
    const pmJson = yDocToProsemirrorJSON(this.ydoc, fragmentKey);
    return jsonToMarkdown(pmJson as Record<string, unknown>);
  }

  /** Clear all content from a Y.Doc fragment. */
  private clearFragment(fragmentKey: string): void {
    this.ydoc.transact(() => {
      const fragment = this.ydoc.getXmlFragment(fragmentKey);
      while (fragment.length > 0) {
        fragment.delete(0, 1);
      }
    });
  }

  /** Populate a Y.Doc fragment from markdown content (heading+body for non-root, body for root). */
  private populateFragment(fragmentKey: string, markdown: string): void {
    const pmJson = markdownToJSON(markdown);
    const tempDoc = prosemirrorJSONToYDoc(getBackendSchema(), pmJson, fragmentKey);
    Y.applyUpdate(this.ydoc, Y.encodeStateAsUpdate(tempDoc));
    tempDoc.destroy();
  }

  /**
   * Build full fragment content (heading+body) for populating a non-root Y.Doc fragment.
   * Root fragments pass body directly (no heading to prepend).
   */
  private static buildFragmentContent(body: string, level: number, heading: string): string {
    if (level === 0 && heading === "") return body;
    const headingLine = `${"#".repeat(level)} ${heading}`;
    return body.trim() ? `${headingLine}\n\n${body}` : headingLine;
  }

  /**
   * Extract full markdown (heading + body) from the Y.Doc fragment.
   * Fragments already store heading+body, so this is just extractMarkdown().
   * Root fragments (level=0, heading="") have body only — returned as-is.
   */
  private reconstructFullMarkdown(fragmentKey: string, _level: number, _heading: string): string {
    return this.extractMarkdown(fragmentKey);
  }

}
