/**
 * install-link-picker — wires the document-path link picker into a Crepe/Milkdown
 * editor. Call `installLinkPicker(crepe.editor)` after the Crepe instance is
 * constructed so this config runs AFTER the LinkTooltip feature's
 * `configureLinkTooltip`, overriding it.
 *
 * The override replaces the stock edit-tooltip PluginView with the React popup
 * (LinkEditPopup) and routes the link API's add/edit/remove through it.
 */

import type { Editor } from "@milkdown/core";
import { linkTooltipAPI, linkEditTooltip } from "@milkdown/components/link-tooltip";

import { Option1LinkEditView } from "./option1-edit-view";

export function installLinkPicker(editor: Editor): void {
  editor.config((ctx) => {
    let view: Option1LinkEditView | null = null;

    // Override the edit-tooltip PluginView factory with the React popup view.
    // (Runs after configureLinkTooltip, so this ctx.set wins.)
    ctx.set(linkEditTooltip.key, {
      view: (editorView) => {
        view = new Option1LinkEditView(ctx, editorView);
        return view;
      },
    });

    // Route the link API through our view. Spreading `...api` keeps any other
    // members intact; we override the three entry points.
    ctx.update(linkTooltipAPI.key, (api) => ({
      ...api,
      addLink: (from, to) => view?.addLink(from, to),
      editLink: (mark, from, to) => view?.editLink(mark, from, to),
      removeLink: (from, to) => view?.removeLink(from, to),
    }));
  });
}
