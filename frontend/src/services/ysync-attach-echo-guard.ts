interface YSyncBindingLike {
  _prosemirrorChanged: (doc: unknown) => void;
}

interface YSyncPluginStateLike {
  binding?: YSyncBindingLike | null;
}

export function installAttachEchoGuard(
  syncPluginState: unknown,
): () => void {
  const binding = (syncPluginState as YSyncPluginStateLike | null | undefined)?.binding;
  if (!binding || typeof binding._prosemirrorChanged !== "function") {
    return () => {};
  }
  const original = binding._prosemirrorChanged.bind(binding);
  let disarmed = false;

  binding._prosemirrorChanged = (doc: unknown): void => {
    if (!disarmed) return;
    original(doc);
  };

  return () => {
    disarmed = true;
  };
}
