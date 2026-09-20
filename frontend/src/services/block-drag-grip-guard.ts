/**
 * The host owns the grip gesture, so Crepe's BlockEdit handle must never start an HTML5
 * drag. `BlockProvider` sets `draggable = true` on the handle in its own `#init()`, which
 * runs inside a `requestAnimationFrame` after the plugin view is constructed — and the
 * plugin view is constructed again (new handle element, freshly armed) every time the
 * editor's plugins are reconfigured, which the CRDT attach/detach does. A one-shot
 * `draggable = false` at mount would therefore be undone by the very next rAF or by the
 * next reconfigure, so this guard watches the editor root instead of writing once.
 */

export const BLOCK_HANDLE_SELECTOR = ".milkdown-block-handle";

function disarmHandles(root: HTMLElement): void {
  for (const handle of root.querySelectorAll(BLOCK_HANDLE_SELECTOR)) {
    if (handle instanceof HTMLElement && handle.draggable) handle.draggable = false;
  }
}

/**
 * Keeps every BlockEdit handle under `root` non-draggable for as long as the returned
 * teardown has not been called. Writes only when a handle is actually draggable, so the
 * observer cannot drive itself in a loop off its own attribute write.
 */
export function installGripDraggableGuard(root: HTMLElement): () => void {
  disarmHandles(root);
  const observer = new MutationObserver(() => { disarmHandles(root); });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["draggable"],
  });
  return () => { observer.disconnect(); };
}
