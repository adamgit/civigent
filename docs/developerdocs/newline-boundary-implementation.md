# Newline Boundary Implementation Plan

Implementation plan for the boundary transform system described in internal-data-formats.md. All work is in `backend/src/`.

---

## Branded types

Two branded types in `storage/section-formatting.ts`. The `as` constructors are module-private — no other file can mint these types.

```typescript
export type SectionBody = string & { readonly __brand: "SectionBody" };
export type FragmentContent = string & { readonly __brand: "FragmentContent" };
```

`SectionBody` — body-only, no heading prefix, no trailing `\n`. Used by disk body files, API responses, parser output, `prependHeading` input.

`FragmentContent` — heading+body (or body-only for BFH), no trailing `\n`. Used by Y.Doc fragments, raw fragment files, `populateFragment` input.

---

## New functions in section-formatting.ts

### Boundary functions

| # | Function | Signature | Purpose |
|---|----------|-----------|---------|
| 1 | `bodyFromDisk` | `(raw: string): SectionBody` | disk body file -> memory |
| 2 | `bodyToDisk` | `(body: SectionBody): string` | memory -> disk body file. `body ? body + "\n" : ""` |
| 3 | `bodyFromGit` | `(raw: string): SectionBody` | git show stdout -> memory |
| 4 | `bodyFromRemark` | `(raw: string): SectionBody` | remark-stringify output -> memory (body context) |
| 5 | `bodyFromParser` | `(raw: string): SectionBody` | parser-stripped output -> memory |
| 6 | `bodyFromRecoveryAssembly` | `(raw: string): SectionBody` | recovery section assembly -> memory |
| 7 | `bodyFromOrphanFragment` | `(raw: string): { body: SectionBody; originalHeading?: string }` | orphan raw fragment -> body + heading metadata |
| 8 | `fragmentFromRemark` | `(raw: string): FragmentContent` | remark-stringify output -> memory (fragment context) |
| 9 | `fragmentFromDisk` | `(raw: string): FragmentContent` | disk raw fragment file -> memory |
| 10 | `fragmentToDisk` | `(content: FragmentContent): string` | memory -> disk raw fragment file |
| 11 | `fragmentFromParser` | `(raw: string): FragmentContent` | parser-stripped fullContent -> memory |

Functions 1-4, 8-9 all strip trailing `\n`. Implementations identical today but remain separate — each boundary has independent failure modes (see spec).

### Conversion / combining functions

| # | Function | Signature | Purpose |
|---|----------|-----------|---------|
| 12 | `buildFragmentContent` | `(body: SectionBody, level: number, heading: string): FragmentContent` | body -> heading+body. BFH case (level=0, heading="") rebrands without prepending |
| 13 | `stripHeadingFromFragment` | `(content: FragmentContent, level: number): SectionBody` | heading+body -> body. Strips ATX heading line + blank separator |
| 14 | `mergeOrphanIntoFragment` | `(existing: FragmentContent, orphan: SectionBody): FragmentContent` | append orphan body to existing fragment content |
| 15 | `joinBodies` | `(bodies: SectionBody[], separator: string): SectionBody` | combine multiple body parts |
| 16 | `appendToBody` | `(existing: SectionBody, addition: SectionBody): SectionBody` | append body to body with `\n\n` separator, handles empties |
| 17 | `prependHeading` | `(body: SectionBody, level: number, heading: string): string` | assembly output — transient, never stored. Returns plain string |

---

## Moves

- `FragmentStore.buildFragmentContent` -> `section-formatting.ts` as #12
- `FragmentStore.stripHeadingFromContent` -> `section-formatting.ts` as #13 (renamed `stripHeadingFromFragment`)

---

## Interface type changes

```
ParsedSection.body:        string -> SectionBody
ParsedSection.fullContent: string -> FragmentContent
OrphanedBody.content:      string -> SectionBody
```

---

## Signature changes

### content-layer.ts

- `readSection()` returns `SectionBody` (wrap `readFile` in `bodyFromDisk`)
- `readAllSections()` returns `Map<string, SectionBody>` (wrap `readFile` in `bodyFromDisk`)
- `writeSection()` body param: `SectionBody`
- `writeBodyFile()` — add doc comment only (remark round-trip output is already disk-format)
- `importMarkdownDocument` — parser `.body` is now `SectionBody`, use `bodyToDisk`

### fragment-store.ts

- `extractMarkdown()` returns `FragmentContent` (via `fragmentFromRemark`)
- `populateFragment()` takes `FragmentContent`
- `setFragmentContent()` takes `FragmentContent`
- `writeBodyToDisk()` takes `SectionBody` (uses `bodyToDisk` internally)
- `writeDualFormat()` takes `rawMarkdown: FragmentContent, body: SectionBody`
- `readBodyForDisk()` returns `SectionBody`
- `readFullContent()` returns `FragmentContent`
- `readLiveBody()` rename to `readLiveFragment()`, returns `FragmentContent | null`
- `readAllLiveContent()` returns `Map<string, FragmentContent>`
- `assembleMarkdown()` returns `string` (transient assembly)
- `reconstructFullMarkdown()` returns `FragmentContent`
- `isStructurallyClean()` takes `FragmentContent`

### git-repo.ts

- `assembleSkeletonFromGit` — wrap `gitShowFileOrNull` results in `bodyFromGit`
- `extractHistoricalTree` — `bodyToDisk(bodyFromGit(content))` for all body files

### session-store.ts

- `writeRawFragment()` content param: `FragmentContent`
- `readRawFragment()` stays `string | null` — callers wrap in `fragmentFromDisk`

### markdown-parser.ts

- `flushSection` calls `bodyFromParser` and `fragmentFromParser` instead of inline `.replace(/\n+$/, "")`

### crash-recovery.ts

- `buildRecoverySectionMarkdown()` returns `SectionBody` (wraps final output in `bodyFromRecoveryAssembly`)

---

## Callsite changes (inline transform replacement)

### Read-side: disk -> memory

| File:line | Current | Replacement |
|-----------|---------|-------------|
| content-layer.ts:222 `readSection` | raw `readFile` | `bodyFromDisk(await readFile(...))` |
| content-layer.ts:362 `readAllSections` | raw `readFile` | `bodyFromDisk(await readFile(...))` |
| content-layer.ts:403 `readAssembledDocument` | raw `readFile` | `bodyFromDisk(await readFile(...))` |
| content-layer.ts:419 BFH path | `.replace(/^\n+/, "").replace(/\n+$/, "")` | remove — `bodyFromDisk` already applied, just `if (content) parts.push(content)` |
| markdown-sections.ts:185 canonical read | `.replace(/\n+$/, "")` | `bodyFromDisk(await readFile(...))` |

### Read-side: git -> memory

| File:line | Current | Replacement |
|-----------|---------|-------------|
| git-repo.ts:275 `assembleSkeletonFromGit` | raw `gitShowFileOrNull` | `bodyFromGit(content)` applied once at read, both BFH and headed paths receive `SectionBody` |
| git-repo.ts:291 BFH path | `.replace(/^\n+/, "").replace(/\n+$/, "")` | remove — `bodyFromGit` already applied |
| git-repo.ts:224 `extractHistoricalTree` | raw `writeFile(path, content)` | `writeFile(path, bodyToDisk(bodyFromGit(content)))` |

### Read-side: remark -> memory

| File:line | Current | Replacement |
|-----------|---------|-------------|
| fragment-store.ts:837-839 `extractMarkdown` | raw `jsonToMarkdown()` | `fragmentFromRemark(jsonToMarkdown(...))` |

### Read-side: parser -> memory

| File:line | Current | Replacement |
|-----------|---------|-------------|
| markdown-parser.ts:96 body | `.replace(/\n+$/, "")` | `bodyFromParser(body)` |
| markdown-parser.ts:97 fullContent | `.replace(/\n+$/, "")` | `fragmentFromParser(fullContent)` |

### Write-side: memory -> disk

| File:line | Current | Replacement |
|-----------|---------|-------------|
| fragment-store.ts:920-921 `writeBodyToDisk` | `.replace(/\n+$/, "")` then `+ "\n"` | `bodyToDisk(body)` |
| markdown-sections.ts:196 | `sectionBody + "\n"` | `bodyToDisk(sectionBody)` |
| recovery-layers.ts:610 | `content + "\n"` | `bodyToDisk(content)` |
| content-layer.ts:727-728 `importMarkdownDocument` | `.replace(/\n+$/, "")` then ternary `+ "\n"` | `bodyToDisk(parsed.sections[i].body)` |

### Write-side: remark -> disk (composite, no change)

| File:line | Current | Replacement |
|-----------|---------|-------------|
| content-layer.ts:50 `writeBodyFile` | `jsonToMarkdown(markdownToJSON(content))` | add doc comment only — remark round-trip output matches disk convention |

---

## Simplifications enabled

| File:line | Current | Replacement |
|-----------|---------|-------------|
| section-formatting.ts:8 `prependHeading` | `.replace(/^\n+/, "").replace(/\n+$/, "")` | remove — input is `SectionBody`, guaranteed clean |
| fragment-store.ts:902 `buildFragmentContent` | `body.trim()` truthiness check | `body` truthiness check — `SectionBody` has no whitespace to trim |
| fragment-store.ts:235,237 `stripHeadingFromContent` | `.replace(/\n+$/, "")` at both returns | remove — input is `FragmentContent`, already in-memory form |
| fragment-store.ts:778 orphan merge | `.trim()` truthiness check | `existing` truthiness check — `FragmentContent` has no trailing whitespace |
| fragment-store.ts:323 `assembleMarkdown` | `content.trim()` truthiness check | `content` truthiness check |

---

## Combining operations in normalization handlers

Three places in fragment-store.ts that join/concatenate `SectionBody` values — must use typed combining functions, not raw string concat.

| File:line | Current | Replacement |
|-----------|---------|-------------|
| fragment-store.ts:645-648 `normalizeHeadingRelocated` preamble | `parsed.filter(...).map(s => s.body).join("\n")` | `joinBodies(parsed.filter(...).map(s => s.body), "\n")` |
| fragment-store.ts:651-653 `normalizeHeadingRelocated` combine | `section.body + "\n\n" + preamble` ternary | `appendToBody(section.body, preamble)` |
| fragment-store.ts:722-725 `normalizeHeadingDeletion` orphan | `parsed.filter(...).map(s => s.body).join("\n")` | `joinBodies(parsed.filter(...).map(s => s.body), "\n")` |

---

## Orphan collection fix (pre-existing issue exposed by types)

### Problem

fragment-store.ts:208-214 collects orphans from raw fragment files. Raw fragments contain `FragmentContent` (heading+body), but `OrphanedBody.content` is `SectionBody`. Current code uses `.trim()` which masks this mismatch.

### Fix

Use `bodyFromOrphanFragment` which:
1. Reads the raw content
2. Detects ATX heading on first line (`/^(#{1,6})\s+(.+)$/`)
3. If heading found: strips heading line + blank separator, prepends `(inferred section title: '<heading text>')\n\n` to remaining body
4. Returns `{ body: SectionBody, originalHeading: string | undefined }`

The annotation preserves heading information in the body content for user review. `originalHeading` is set on the `OrphanedBody` for display in recovery section headings.

Overlay body-file orphans (fragment-store.ts:200-202) use `bodyFromDisk` — these are body-only files, no heading to strip.

---

## ydoc-lifecycle.ts:237 recovery fragment construction

### Problem

Currently builds fragment content inline with string interpolation: `` `${headingLine}\n\n${recoveryBody}` ``

### Fix

`buildRecoverySectionMarkdown` now returns `SectionBody`. Use `buildFragmentContent(recoveryBody, level, heading)` — types flow directly, no inline construction needed.

---

## Bugfix: extractHistoricalTree missing trailing newline

### Problem

git-repo.ts:224 writes `gitShowFile` output (already `trimEnd()`-ed by `gitExec`) directly to disk via `writeFile`. Restored files are missing their POSIX trailing newline.

### Fix

`writeFile(path, bodyToDisk(bodyFromGit(content)))` — git -> memory -> disk, two explicit boundary crossings.

---

## gitExec stays as-is

git-repo.ts:34 `gitExec` does `stdout.trimEnd()`. This is a blanket operation for all git output (status, log, file content). Leave it — `bodyFromGit` handles content-specific normalisation on top. Add a doc comment explaining why it stays.

---

## Notes

- `prependHeading` returns plain `string` — assembly output is transient (used in `.join("\n")`), never stored or passed to typed functions
- `assembleMarkdown` and `readAssembledDocument` return plain `string` — transient assembled documents
- `writeBodyFile` relies on remark round-trip output matching disk convention (trailing `\n`) — document this reliance, do not add a transform
- All boundary functions with identical implementations today MUST remain separate — future changes to git config, remark version, or deployment platform affect boundaries independently
