import * as Y from "yjs";
import { markdownToJSON, jsonToMarkdown } from "@ks/milkdown-serializer";
import { yDocToProsemirrorJSON, prosemirrorJSONToYDoc } from "y-prosemirror";
import { getBackendSchema } from "./ydoc-fragments.js";
import { fragmentFromRemark, EMPTY_FRAGMENT, type FragmentContent } from "../storage/section-formatting.js";
import type { DocPath } from "../types/shared.js";

function isXmlFragmentShareEntry(doc: Y.Doc, shareKey: string): boolean {
  const shared = doc.share.get(shareKey);
  if (shared === undefined) return false;
  return shared instanceof Y.XmlFragment || shared.constructor === Y.AbstractType;
}

function fragmentToMarkdown(doc: Y.Doc, fragmentKey: string): FragmentContent {
  const pmJson: Record<string, unknown> = yDocToProsemirrorJSON(doc, fragmentKey);
  return fragmentFromRemark(jsonToMarkdown(pmJson));
}

export class LiveFragmentStringsStore {
  readonly ydoc: Y.Doc;
  readonly docPath: DocPath;

  private orderedKeys: string[];
  private readonly fragmentWriterIds = new Map<string, Set<string>>();

  private readonly touchedByObserverThisApply = new Set<string>();
  private readonly touchedKeyObserverByFragmentKey = new Map<string, () => void>();
  private touchedKeyObserversAttached = false;
  private shareSizeAtLastNewKeyScan = 0;

  constructor(ydoc: Y.Doc, orderedKeys: string[], docPath: DocPath) {
    this.ydoc = ydoc;
    this.orderedKeys = [...orderedKeys];
    this.docPath = docPath;
  }

  private attachTouchedKeyObserversAfterSeed(): void {
    if (this.touchedKeyObserversAttached) return;
    this.touchedKeyObserversAttached = true;
    for (const fragmentKey of this.orderedKeys) this.attachTouchedKeyObserver(fragmentKey);
    for (const shareKey of this.ydoc.share.keys()) {
      if (isXmlFragmentShareEntry(this.ydoc, shareKey)) this.attachTouchedKeyObserver(shareKey);
    }
    this.shareSizeAtLastNewKeyScan = this.ydoc.share.size;
  }

  private attachTouchedKeyObserver(fragmentKey: string): void {
    if (!this.touchedKeyObserversAttached) return;
    if (this.touchedKeyObserverByFragmentKey.has(fragmentKey)) return;
    const recordThisKeyAsTouched = (): void => {
      this.touchedByObserverThisApply.add(fragmentKey);
    };
    this.ydoc.getXmlFragment(fragmentKey).observeDeep(recordThisKeyAsTouched);
    this.touchedKeyObserverByFragmentKey.set(fragmentKey, recordThisKeyAsTouched);
  }

  private detachTouchedKeyObserver(fragmentKey: string): void {
    const observer = this.touchedKeyObserverByFragmentKey.get(fragmentKey);
    if (!observer) return;
    this.ydoc.getXmlFragment(fragmentKey).unobserveDeep(observer);
    this.touchedKeyObserverByFragmentKey.delete(fragmentKey);
  }

  private attachObserversToKeysThatJustArrived(): string[] {
    if (this.ydoc.share.size === this.shareSizeAtLastNewKeyScan) return [];
    const arrived: string[] = [];
    for (const shareKey of this.ydoc.share.keys()) {
      if (this.touchedKeyObserverByFragmentKey.has(shareKey)) continue;
      if (!isXmlFragmentShareEntry(this.ydoc, shareKey)) continue;
      this.attachTouchedKeyObserver(shareKey);
      arrived.push(shareKey);
    }
    this.shareSizeAtLastNewKeyScan = this.ydoc.share.size;
    return arrived;
  }

  getFragmentKeys(): string[] {
    return [...this.orderedKeys];
  }

  hasFragmentKey(fragmentKey: string): boolean {
    return this.orderedKeys.includes(fragmentKey);
  }

  registerFragmentKey(fragmentKey: string): void {
    if (!this.orderedKeys.includes(fragmentKey)) {
      this.orderedKeys.push(fragmentKey);
    }
    this.attachTouchedKeyObserver(fragmentKey);
  }

  unregisterFragmentKey(fragmentKey: string): void {
    const idx = this.orderedKeys.indexOf(fragmentKey);
    if (idx !== -1) this.orderedKeys.splice(idx, 1);
    this.fragmentWriterIds.delete(fragmentKey);
    this.detachTouchedKeyObserver(fragmentKey);
  }

  getWriterIdsForFragment(fragmentKey: string): string[] {
    return [...(this.fragmentWriterIds.get(fragmentKey) ?? new Set())].sort();
  }

  getWriterIdsForFragments(fragmentKeys: Iterable<string>): string[] {
    const writerIds = new Set<string>();
    for (const fragmentKey of fragmentKeys) {
      for (const writerId of this.fragmentWriterIds.get(fragmentKey) ?? []) {
        writerIds.add(writerId);
      }
    }
    return [...writerIds].sort();
  }

  setFragmentWriterIds(fragmentKey: string, writerIds: Iterable<string>): void {
    const normalized = new Set<string>();
    for (const writerId of writerIds) {
      const trimmed = writerId.trim();
      if (trimmed.length > 0) {
        normalized.add(trimmed);
      }
    }
    if (normalized.size === 0) {
      this.fragmentWriterIds.delete(fragmentKey);
      return;
    }
    this.fragmentWriterIds.set(fragmentKey, normalized);
  }

  readFragmentString(fragmentKey: string): FragmentContent {
    return fragmentToMarkdown(this.ydoc, fragmentKey);
  }

  captureState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc);
  }

  snapshotFragmentContentFromState(
    state: Uint8Array,
    fragmentKeys: Iterable<string>,
  ): Map<string, FragmentContent> {
    const result = new Map<string, FragmentContent>();
    const keys = [...fragmentKeys];
    if (keys.length === 0) return result;
    const tmp = new Y.Doc();
    Y.applyUpdate(tmp, state);
    try {
      for (const fragmentKey of keys) {
        result.set(fragmentKey, fragmentToMarkdown(tmp, fragmentKey));
      }
    } finally {
      tmp.destroy();
    }
    return result;
  }

  replaceFragmentString(fragmentKey: string, content: FragmentContent, origin: unknown = undefined): void {
    this.registerFragmentKey(fragmentKey);
    this.ydoc.transact(() => {
      const fragment = this.ydoc.getXmlFragment(fragmentKey);
      while (fragment.length > 0) fragment.delete(0, 1);
    }, origin);

    const pmJson = markdownToJSON(content);
    const tempDoc = prosemirrorJSONToYDoc(getBackendSchema(), pmJson, fragmentKey);
    Y.applyUpdate(this.ydoc, Y.encodeStateAsUpdate(tempDoc), origin);
    tempDoc.destroy();
  }

  replaceFragmentStrings(map: Map<string, FragmentContent>, origin: unknown = undefined): void {
    this.replaceAndClearFragmentStrings(map, [], origin);
  }

  restoreFragmentsFromSnapshot(
    state: Uint8Array,
    fragmentKeys: Iterable<string>,
    origin: unknown = undefined,
  ): void {
    const keys = [...fragmentKeys];
    if (keys.length === 0) return;
    const priorContent = this.snapshotFragmentContentFromState(state, keys);
    const revertMap = new Map<string, FragmentContent>();
    for (const key of keys) {
      revertMap.set(key, priorContent.get(key) ?? EMPTY_FRAGMENT);
    }
    this.replaceFragmentStrings(revertMap, origin);
  }

  replaceAndClearFragmentStrings(
    writeMap: Map<string, FragmentContent>,
    clearKeys: Iterable<string>,
    origin: unknown = undefined,
  ): void {
    const keysToClear = new Set<string>();
    for (const key of clearKeys) keysToClear.add(key);
    for (const key of writeMap.keys()) {
      keysToClear.add(key);
      this.registerFragmentKey(key);
    }
    if (keysToClear.size === 0) return;

    this.ydoc.transact(() => {
      for (const fragmentKey of keysToClear) {
        const fragment = this.ydoc.getXmlFragment(fragmentKey);
        while (fragment.length > 0) fragment.delete(0, 1);
      }
    }, origin);

    const pendingUpdates: Uint8Array[] = [];
    for (const [fragmentKey, content] of writeMap) {
      const pmJson = markdownToJSON(content);
      const tempDoc = prosemirrorJSONToYDoc(getBackendSchema(), pmJson, fragmentKey);
      pendingUpdates.push(Y.encodeStateAsUpdate(tempDoc));
      tempDoc.destroy();
    }
    if (pendingUpdates.length > 0) {
      Y.applyUpdate(this.ydoc, Y.mergeUpdates(pendingUpdates), origin);
    }
  }

  applyClientUpdate(writerId: string, update: Uint8Array, origin: unknown): ReadonlySet<string> {
    this.attachTouchedKeyObserversAfterSeed();
    this.touchedByObserverThisApply.clear();
    Y.applyUpdate(this.ydoc, update, origin);
    const touched = new Set(this.touchedByObserverThisApply);
    for (const arrivedKey of this.attachObserversToKeysThatJustArrived()) touched.add(arrivedKey);
    this.touchedByObserverThisApply.clear();
    for (const fragmentKey of touched) {
      this.noteWriterForFragment(fragmentKey, writerId);
    }
    return touched;
  }

  private noteWriterForFragment(fragmentKey: string, writerId: string): void {
    const trimmed = writerId.trim();
    if (trimmed.length === 0) return;
    let writerIds = this.fragmentWriterIds.get(fragmentKey);
    if (!writerIds) {
      writerIds = new Set<string>();
      this.fragmentWriterIds.set(fragmentKey, writerIds);
    }
    writerIds.add(trimmed);
  }
}
