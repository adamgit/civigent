# Internal Data Formats

Low-level reference for how content is represented, stored, and transformed at each layer boundary. This document is the authoritative source for format decisions — if the code disagrees with this document, the code has a bug.

---

## Skeleton format

A **skeleton file** is the indirection layer between a document's heading structure and its section body files on disk.

### On-disk representation

```
{{section: --before-first-heading--abc12.md}}

## Overview
{{section: sec_overview_x8f3k2.md}}

## Timeline
{{section: sec_timeline_p2m9w1.md}}
```

Rules:

- **Heading lines** follow CommonMark ATX syntax: `^(#{1,6})\s+(.+)$`.
- **Section markers** follow the heading on the next non-blank line: `{{section: <filename>}}`. Optional pipe metadata is ignored: `{{section: file.md | extra}}`.
- **Before-first-heading (BFH)** sections have a section marker with no preceding heading. They have `level=0, heading=""`.
- **Sub-skeletons**: a section body file may itself contain `{{section:}}` markers, making it a skeleton for a deeper heading level. Its children live in a `.sections/` directory named after the sub-skeleton file.
- **File naming**: regular sections use `sec_<slug>_<randomId>.md`. BFH sections use `--before-first-heading--<id>.md`. Sub-skeleton internal bodies use `--section-body--<id>.md`.

### Directory layout

```
content/
  ops/strategy.md                          <- skeleton
  ops/strategy.md.sections/
    --before-first-heading--abc12.md       <- BFH body
    sec_overview_x8f3k2.md                 <- section body
    sec_timeline_p2m9w1.md                 <- section body
    sec_timeline_p2m9w1.md.sections/       <- sub-skeleton children
      sec_early_history_k3f8.md
```

### Serialisation contract

`DocumentSkeleton` owns parsing and serialisation. No other code reads or writes skeleton files directly. The serialised form:
- Strips leading blank lines.
- Ends with exactly one `\n`.
- Separates entries with one blank line (except BFH, which has no preceding blank line).

---

## Section body content: the newline policy

### The problem this solves

Section body content crosses multiple system boundaries — filesystem, git, remark serialiser, parser, Y.Doc fragments. Each boundary can silently add or remove trailing newlines. Without an explicit policy, every callsite invents its own defensive stripping or appending, leading to scattered, fragile, and inconsistent transforms.

### Design decision

We define two canonical in-memory forms, enforced by branded types, and explicit transform functions at every boundary crossing:

| Form | Trailing newline | Type | Definition |
|------|-----------------|------|------------|
| **SectionBody** | None | `string & { __brand: "SectionBody" }` | Body-only section content. No heading prefix. All business logic, comparisons, API responses, body-file I/O, and `prependHeading` input use this form. |
| **FragmentContent** | None | `string & { __brand: "FragmentContent" }` | Full fragment content: heading+body for headed sections, body-only for BFH. This is the in-memory form used for all Y.Doc per-section fragment operations — converting a section body into the markdown a `Y.XmlFragment` holds, and converting fragment markdown back to a body. There is no parallel fragment sidecar on disk; live in-flight edits are durably represented by the relevant `inprogress` proposal content tree (see `05-ydoc-lifecycle.md` "Disk Persistence Layout"), and proposal/canonical bodies are stored in the SectionBody on-disk form below. |
| **On-disk** | Exactly one `\n` for non-empty; empty string for empty | `string` | POSIX convention. Every `.md` section body file on the filesystem (canonical `content/` and proposal content trees) follows this. |

The branded types are defined in `section-formatting.ts`. The `as` constructor functions are **module-private** — no other file can mint `SectionBody` or `FragmentContent` except through the boundary and conversion functions listed below. Casts are forbidden at callsites. This means a junior engineer cannot bypass the boundary system without writing code that will immediately fail code review.

### Boundary functions

Every I/O boundary has a named transform function. Functions with identical implementations today MUST remain separate — each boundary has independent failure modes (git config changes must not require remark changes, etc).

All boundary functions live in `storage/section-formatting.ts`.

#### SectionBody boundaries

```
bodyFromDisk(raw: string): SectionBody            — strip trailing \n
bodyToDisk(body: SectionBody): string              — append trailing \n (or empty)
bodyFromGit(raw: string): SectionBody              — normalise git stdout to in-memory form
bodyFromRemark(raw: string): SectionBody           — normalise remark-stringify output (body context)
bodyFromParser(raw: string): SectionBody           — normalise parser-stripped output
bodyFromRecoveryAssembly(raw: string): SectionBody — normalise recovery section assembly output
bodyFromOrphanFragment(raw: string): SectionBody
                                                   — extract body from an orphaned in-memory
                                                     fragment string (heading+body that no
                                                     longer matches a skeleton entry),
                                                     preserving the heading as an inline
                                                     annotation in the recovered body
```

#### FragmentContent boundaries

```
fragmentFromRemark(raw: string): FragmentContent   — normalise remark-stringify output (fragment context)
fragmentFromParser(raw: string): FragmentContent    — normalise parser-stripped fullContent
fragmentFromExternalContent(raw: string): FragmentContent
                                                   — normalise arbitrary externally-supplied
                                                     markdown into in-memory FragmentContent
bodyAsFragment(body: SectionBody): FragmentContent  — rebrand a body as fragment content (BFH / body-only)
fragmentAsBody(fragment: FragmentContent): SectionBody — rebrand fragment content as a body
```

#### Disk <-> Memory detail

`bodyFromDisk`/`bodyToDisk` are used when reading/writing `.md` section body files via `readFile`/`writeFile` in `content-layer.ts`, `markdown-sections.ts`, and the proposal/canonical readers. These body files live in canonical `content/` and in proposal content trees; there is no raw-fragment file tier on disk. `fragmentFromDisk`/`fragmentToDisk` remain as branded newline helpers but have no live disk boundary — fragment content is an in-memory Y.Doc form only — and exist mainly so the on-disk newline convention has a single point of change (see "Future convention changes").

#### Git <-> Memory detail

`git show` output passes through `gitExec`, which applies `trimEnd()` to stdout. This already strips trailing newlines, but also strips trailing spaces, and may interact with `core.autocrlf`, smudge filters, or `.gitattributes` in the data repo (whose git config is deployment-dependent, not controlled by us).

`bodyFromGit` is the single place to handle all of this. Today it may look like `bodyFromDisk`, but it must remain separate because the git boundary has different failure modes.

The inverse (memory -> git) is not a direct operation — we write to disk (`bodyToDisk`), then `git add` reads from the working tree. Git's clean filters may transform content before storing it in the object database. This is a two-step boundary (memory -> disk -> git) and does not need its own function.

`gitExec` itself stays as-is — its `trimEnd()` is a blanket operation for all git output (status lines, log output, file content). The `bodyFromGit` function handles content-specific normalisation on top.

**Known bug (pre-existing)**: `extractHistoricalTree` in `git-repo.ts` writes `gitShowFile` output (which has been `trimEnd()`-ed) directly to disk via `writeFile`. This means restored files are missing their trailing newline — a silent format mismatch. The fix is: `writeFile(path, bodyToDisk(bodyFromGit(content)))` — git -> memory -> disk, two explicit boundary crossings.

#### Remark <-> Memory detail

`jsonToMarkdown` (remark-stringify) produces markdown ending with `\n` for non-empty content, and `""` for empty content.

In **body context** (e.g. if remark were used to produce body-only output): `bodyFromRemark` strips the trailing newline to produce `SectionBody`.

In **fragment context** (the live Y.Doc fragment adapter in `crdt/live-fragment-strings-store.ts`, which serialises a per-section `Y.XmlFragment` containing heading+body via `yDocToProsemirrorJSON` + `jsonToMarkdown`): `fragmentFromRemark` strips the trailing newline to produce `FragmentContent`.

The inverse (memory -> remark) is `markdownToJSON`, which is tolerant of any trailing whitespace — no transform needed at input.

#### Remark -> Disk (composite)

`writeBodyFile` in content-layer.ts performs `jsonToMarkdown(markdownToJSON(content))` and writes the result to disk. This is a composite path: memory -> remark -> remark output -> disk. Since remark-stringify already produces disk-compatible output (trailing `\n`), no additional transform is needed — but the code must document that it relies on remark's output format matching disk convention.

#### Parser -> Memory detail

`parseDocumentMarkdown` in `markdown-parser.ts` is the **source** of in-memory form. Its output uses the typed boundary functions:
- `ParsedSection.body: SectionBody` — via `bodyFromParser`
- `ParsedSection.fullContent: FragmentContent` — via `fragmentFromParser`

The parser strips trailing newlines at the boundary crossing. These functions are called in the parser's `flushSection`, replacing the previous inline `.replace(/\n+$/, "")`.

#### Orphan fragment recovery detail

An orphaned fragment is an in-memory `FragmentContent` string (heading+body) that no longer matches any skeleton entry — for example a fragment whose heading was changed or whose section was removed underneath it. There is no raw-fragment file tier; this is a transform over in-memory fragment strings, not session-sidecar file I/O. `bodyFromOrphanFragment(raw: string): SectionBody` recovers a usable body:

1. Detects an ATX heading on the first line (`/^(#{1,6})\s+(.+)$/`).
2. If found: strips the heading line + blank separator and prepends an `(inferred section title: '<heading text>')\n\n` annotation to the remaining body.
3. Returns the annotated `SectionBody`.

The inline annotation preserves the heading information in the body so it remains visible to the user after recovery. `bodyFromRecoveryAssembly` and `mergeOrphanIntoFragment` are the companion in-memory helpers used when assembling recovered content back into a fragment or section body; they are retained mechanics over in-memory forms, not disk readers/writers.

### Conversion functions between SectionBody and FragmentContent

These live in `section-formatting.ts` alongside the boundary functions.

```
buildFragmentContent(body: SectionBody, level: number, heading: string): FragmentContent
    — Prepend heading line to body. BFH case (level=0, heading="") rebrands
      the SectionBody as FragmentContent without prepending.

stripHeadingFromFragment(markdown: FragmentContent, level: number): SectionBody
    Remove ATX heading line and blank separator. Input is already in-memory
      form (no trailing \n to strip). This is the body-extraction step of the
      Y.Doc fragment adapter — used when materializing a live `Y.XmlFragment`
      back into a section body (`crdt/ydoc-lifecycle.ts`, `content-layer.ts`).

mergeOrphanIntoFragment(orphanBody: SectionBody, level: number, heading: string): FragmentContent
    — Build fragment content from a recovered orphan body and a target
      heading/level, used during in-memory recovery assembly.
```

### Combining functions for SectionBody

When normalization handlers need to join or concatenate multiple `SectionBody` values, raw string concatenation is forbidden (it produces `string`, not `SectionBody`). Use:

```
joinBodies(bodies: SectionBody[], separator: string): SectionBody
    — Filter empties, join with separator.

appendToBody(existing: SectionBody, addition: SectionBody): SectionBody
    — Combine two bodies with \n\n separator. If either is empty, returns the other.
```

### Interaction table

How boundary and conversion functions compose for common operations:

| Operation | Path | Transforms |
|-----------|------|------------|
| Read section from disk for API response | disk -> memory | `bodyFromDisk(readFile(...))` |
| Write section body to disk | memory -> disk | `writeFile(..., bodyToDisk(body))` |
| Read section from git for assembly | git -> memory | `bodyFromGit(gitShowFile(...))` |
| Restore git content to disk | git -> memory -> disk | `writeFile(..., bodyToDisk(bodyFromGit(content)))` |
| CRDT materialize: extract body from live fragment | Y.Doc -> remark -> fragment -> body | `stripHeadingFromFragment(fragmentFromRemark(jsonToMarkdown(yDocToProsemirrorJSON(...))), level)` |
| CRDT materialize: persist body into the `inprogress` proposal | body -> proposal content tree | `ProposalEditor.writeSection(...)` (writes body via `bodyToDisk` into the proposal content tree; canonical advances only on commit) |
| Seed a live fragment from canonical/proposal body | disk -> memory -> remark | `markdownToJSON(bodyFromDisk(readFile(...)))` |
| Fragment from a section body + heading | body -> fragment | `buildFragmentContent(body, level, heading)` |
| Normalise-on-write (writeBodyFile) | memory -> remark -> disk | `writeFile(..., jsonToMarkdown(markdownToJSON(content)))` — remark output is already disk-format |
| Orphan recovery from an in-memory fragment | fragment -> orphan body | `bodyFromOrphanFragment(fragment)` |

### Assembly format (not a boundary)

`prependHeading(body: SectionBody, level, heading)` takes a `SectionBody` and produces assembled markdown for joining:

```
## Heading\n\nbody text\n
```

The return type is plain `string` — assembly output is transient. `readAssembledDocument` joins parts with `\n`, so each part must end with `\n` to produce the blank line between sections that markdown requires. This is not a storage format — it exists only transiently during document assembly and is never written to disk as-is.

Because `prependHeading` receives `SectionBody` (typed, guaranteed clean), it does not need to strip its input. Passing untyped content is a compile error, not a runtime bug.

### Future convention changes

| Desired change | What to modify |
|----------------|---------------|
| No trailing `\n` on disk | `bodyToDisk` returns content directly, `bodyFromDisk` becomes identity. One-time migration to strip existing files. (`fragmentToDisk`/`fragmentFromDisk` are vestigial newline helpers with no live disk boundary; adjust only if a fragment disk tier is ever reintroduced.) |
| Trailing `\n` in memory too | All `bodyFrom*`/`fragmentFrom*` become identity. Parser stops stripping. Branded types still enforce the body-vs-fragment distinction. |
| CRLF on disk (e.g. Windows deployment) | `bodyToDisk` appends `\r\n`, `bodyFromDisk` strips `\r\n`. Other boundaries unchanged. |
| Data repo gets autocrlf enabled | `bodyFromGit` handles `\r` stripping. Other boundaries unchanged. |
| Swap remark for different serialiser | `bodyFromRemark`/`fragmentFromRemark` adjust to new output format. Other boundaries unchanged. |

Each row touches only the relevant boundary function(s). Never scattered callsites.

---

## What this document does NOT cover

- **CRDT wire protocol** — message types, binary encoding, and sync are transport concerns (see architecture.md Layer 4).
- **Proposal content format** — proposals store section content in the same body-file format, but proposal lifecycle is a separate concern.
- **Auth file formats** — JSON files in `auth/` have their own conventions (trailing `\n` after `JSON.stringify`), unrelated to section body content.
