import type { Editor } from "@milkdown/core";
import type { Attrs, Mark } from "@milkdown/prose/model";
import { linkSchema } from "@milkdown/preset-commonmark";

import { rewriteMarkdownContentHref, storedContentHrefFromRendered } from "../app/docs-location";

export function installLinkHrefBridge(editor: Editor): void {
  editor.config((ctx) => {
    ctx.update(linkSchema.key, (prevFactory) => (factoryCtx) => {
      const spec = prevFactory(factoryCtx);
      const stockToDOM = spec.toDOM;
      return {
        ...spec,
        toDOM: stockToDOM
          ? (mark: Mark, inline: boolean) => {
              const storedHref = mark.attrs.href;
              const renderedHref =
                typeof storedHref === "string" ? rewriteMarkdownContentHref(storedHref) : null;
              const target =
                renderedHref == null ? mark : mark.type.create({ ...mark.attrs, href: renderedHref });
              return stockToDOM(target, inline);
            }
          : undefined,
        parseDOM: spec.parseDOM?.map((rule) => {
          const stockGetAttrs = rule.getAttrs as ((value: unknown) => Attrs | false | null) | undefined;
          if (!stockGetAttrs) return rule;
          return {
            ...rule,
            getAttrs: (value: unknown) => {
              const attrs = stockGetAttrs(value);
              if (!attrs || typeof attrs !== "object") return attrs;
              const href = (attrs as Record<string, unknown>).href;
              if (typeof href !== "string") return attrs;
              return { ...attrs, href: storedContentHrefFromRendered(href) };
            },
          } as typeof rule;
        }),
      };
    });
  });
}
