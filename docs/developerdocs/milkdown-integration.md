# Milkdown / Crepe Integration Notes

The editor uses `@milkdown/crepe`, a batteries-included wrapper around Milkdown.
Crepe bundles several "features" that replace standard HTML elements with custom
components. This is a problem because the spec requires that editor and static
(read-only) sections render identically.

## Crepe Feature Inventory

| Feature | Native HTML | What Crepe does instead | Impact on rendering parity |
|---|---|---|---|
| **ListItem** | `<li>` with `list-style` | Flex row: `.milkdown-list-item-block > .list-item > .label-wrapper` (24px SVG bullet) + `.children` (10px gap) | **Breaks parity** — completely different DOM and visual output |
| **ImageBlock** | `<img>` | Custom `.image-block` wrapper with caption, resize handles | Breaks parity if images used |
| **Table** | `<table>/<tr>/<td>` | Wraps table in `.milkdown-table-block` with drag handles, column controls. Inner `<table>` structure preserved | **OK** — adds interactive chrome but content DOM is still standard |
| **CodeMirror** | `<pre><code>` | Replaces with CodeMirror editor instance | Breaks parity if code blocks used |
| **BlockEdit** | _(none)_ | Adds floating drag handle + slash menu overlay | **OK** — overlay only, no content DOM change |
| **Toolbar** | _(none)_ | Floating selection toolbar | **OK** — overlay only |
| **LinkTooltip** | `<a>` | Adds floating tooltip/edit popup on hover | **OK** — overlay only, `<a>` preserved |
| **Placeholder** | _(none)_ | Placeholder text in empty paragraphs | **OK** — overlay only |
| **Cursor** | _(none)_ | Custom cursor/caret styling | **OK** — cosmetic only |
| **Latex** | _(none)_ | KaTeX rendering for math blocks | N/A unless math used |

## Current Feature Flags

Set in `frontend/src/components/MilkdownEditor.tsx`:

| Feature | Enabled | Rationale |
|---|---|---|
| CodeMirror | **false** | Not needed; would break rendering parity |
| ImageBlock | **false** | Not needed; would break rendering parity |
| Latex | **false** | Not needed |
| ListItem | **true → should be false** | Breaks bullet list rendering parity (see below) |
| Placeholder | true | Overlay only, harmless |
| Toolbar | true | Overlay only, harmless |
| LinkTooltip | true | Overlay only, harmless |
| BlockEdit | true | Overlay only, harmless |
| Cursor | true | Cosmetic only, harmless |
| Table | true | Content DOM preserved, interactive chrome is editor-only |

## ListItem Bug

Crepe's ListItem feature replaces native `<li>` bullet rendering with:
- A custom web component (`.milkdown-list-item-block`)
- Each list item becomes a flex row
- Bullet is a 24x24 SVG (`<circle cx="12" cy="12" r="3"/>`) inside a 24px-wide, 32px-tall `.label-wrapper`
- 10px flex gap between bullet and text content
- Native `list-style` is removed by Crepe's global `* { margin: 0; padding: 0; }` reset

Static sections render standard `<ul>/<li>` via ReactMarkdown with browser-default disc bullets
and `padding-left: 22px`. The result is visually different bullets, different spacing, and
different indentation.

**Fix**: disable the feature (`[CrepeFeature.ListItem]: false`). ProseMirror's commonmark preset
still provides `bulletListSchema`, `orderedListSchema`, and `listItemSchema` which render as
native `<ul>`, `<ol>`, `<li>`. The existing matched CSS rules for `.milkdown .ProseMirror ul/li`
and `.doc-prose ul/li` then apply to identical DOM structures.

**Trade-off**: task list checkboxes (`- [x]`) lose their SVG rendering and fall back to plain
text markers. Acceptable since task lists are not a primary feature.

## Crepe Global Reset Warning

Crepe applies `.milkdown * { margin: 0; padding: 0; box-sizing: border-box; }` which nukes
all spacing on every element inside the editor. Our `styles.css` overrides must have equal or
higher specificity to restore correct spacing. When adding new element styles, always use the
`.milkdown .ProseMirror <element>` selector pattern and mirror values in `.doc-prose <element>`.
