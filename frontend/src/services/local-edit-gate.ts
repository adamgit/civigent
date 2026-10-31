import { Plugin, PluginKey, type EditorState, type Transaction } from "@milkdown/prose/state";
import { ySyncPluginKey } from "y-prosemirror";

interface YSyncBindingLike {
  _prosemirrorChanged: (doc: unknown) => void;
}

interface YSyncPluginStateLike {
  binding?: YSyncBindingLike | null;
}

const localEditCountKey = new PluginKey<number>("localEditCount");

/**
 * A document change is local unless its root transaction is a y-sync render
 * (`isChangeOrigin`: attach render, remote update, undo/redo). Plugins append
 * normalization to those renders (trailing paragraph, list order) without
 * y-sync meta, so the root decides, not the appended transaction.
 */
function isLocalEdit(tr: Transaction): boolean {
  if (!tr.docChanged) return false;
  const root = (tr.getMeta("appendedTransaction") as Transaction | undefined) ?? tr;
  return root.getMeta(ySyncPluginKey)?.isChangeOrigin !== true;
}

function localEditCount(state: EditorState): number {
  const count = localEditCountKey.getState(state);
  if (count === undefined) {
    throw new Error("localEditTrackerPlugin is not installed in this editor state");
  }
  return count;
}

/**
 * Counts local edits in editor state and calls `onLocalEdit` for each.
 * Install it before `ySyncPlugin`, so `onLocalEdit` runs before the Yjs write.
 */
export function localEditTrackerPlugin(onLocalEdit: () => void): Plugin<number> {
  return new Plugin<number>({
    key: localEditCountKey,
    state: {
      init: () => 0,
      apply: (tr, count) => (isLocalEdit(tr) ? count + 1 : count),
    },
    view: () => ({
      update: (view, prevState) => {
        if (localEditCount(view.state) !== localEditCount(prevState)) onLocalEdit();
      },
    }),
  });
}

/**
 * y-prosemirror writes the whole editor document into the fragment on every
 * view update, including updates that only re-render the fragment. Forward a
 * write only when a local edit has happened since the last forwarded write.
 */
export function writeOnlyLocalEditsToFragment(
  syncPluginState: unknown,
  getState: () => EditorState,
): void {
  const binding = (syncPluginState as YSyncPluginStateLike | null | undefined)?.binding;
  if (!binding || typeof binding._prosemirrorChanged !== "function") {
    return;
  }
  const original = binding._prosemirrorChanged.bind(binding);
  let forwardedCount = 0;

  binding._prosemirrorChanged = (doc: unknown): void => {
    const count = localEditCount(getState());
    if (count === forwardedCount) return;
    forwardedCount = count;
    original(doc);
  };
}
