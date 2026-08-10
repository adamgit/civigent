import { describe, it, expect } from "vitest";
import { FolderPath, InvalidFolderPathError, DocPath } from "../../types/shared.js";

const LAWFUL = [
  "/",
  "/team",
  "/team/sub",
  "/a-b_c.d/e",
  "/notes.mdx",
  "/x.sections2/y",
];

const UNLAWFUL = [
  "",
  "team",
  "//",
  "//a",
  "/a//b",
  "/a/",
  "/a\\b",
  "/./a",
  "/a/.",
  "/a/..",
  "/..",
  "/a.md",
  "/x/a.md",
  "/a.md/b",
  "/a.sections",
  "/x/y.sections",
  "/x.sections/y",
];

describe("FolderPath law", () => {
  it.each(LAWFUL)("accepts %j", (raw) => {
    expect(FolderPath.parse(raw)).toBe(raw);
    expect(FolderPath.tryParse(raw)).toBe(raw);
    expect(FolderPath.isFolderPath(raw)).toBe(true);
  });

  it.each(UNLAWFUL)("rejects %j", (raw) => {
    let caught: unknown = null;
    try {
      FolderPath.parse(raw);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidFolderPathError);
    expect(FolderPath.tryParse(raw)).toBeNull();
    expect(FolderPath.isFolderPath(raw)).toBe(false);
  });

  it("exposes the root constant", () => {
    expect(FolderPath.root).toBe("/");
  });
});

describe("FolderPath.normalize", () => {
  const NORMALIZED: Array<[string | null | undefined, string]> = [
    ["team", "/team"],
    ["team/", "/team"],
    ["/team/", "/team"],
    ["  /team  ", "/team"],
    ["\\team\\sub", "/team/sub"],
    ["/team//sub", "/team/sub"],
    ["/team/./sub", "/team/sub"],
    ["/", "/"],
    ["", "/"],
    [null, "/"],
    [undefined, "/"],
  ];

  it.each(NORMALIZED)("normalize(%j) -> %j", (raw, expected) => {
    expect(FolderPath.normalize(raw)).toBe(expected);
  });

  const NORMALIZE_THROWS = ["/a/../b", "/..", "/a.md", "/a.sections/b"];

  it.each(NORMALIZE_THROWS)("normalize(%j) throws", (raw) => {
    let caught: unknown = null;
    try {
      FolderPath.normalize(raw);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidFolderPathError);
  });

  it("fromSlashStrippedUrlSegment prepends the leading slash", () => {
    expect(FolderPath.fromSlashStrippedUrlSegment("team/sub")).toBe("/team/sub");
    expect(FolderPath.fromSlashStrippedUrlSegment("team/")).toBe("/team");
  });
});

describe("FolderPath algebra", () => {
  it("parentOf walks one segment up and is idempotent at root", () => {
    expect(FolderPath.parentOf(FolderPath.parse("/a/b"))).toBe("/a");
    expect(FolderPath.parentOf(FolderPath.parse("/a"))).toBe("/");
    expect(FolderPath.parentOf(FolderPath.root)).toBe("/");
  });

  const CONTAINS: Array<[string, string, boolean]> = [
    ["/", "/a/b", true],
    ["/a", "/a", true],
    ["/a", "/a/b/c", true],
    ["/a", "/ab", false],
    ["/a/b", "/a", false],
  ];

  it.each(CONTAINS)("contains(%j, %j) === %j", (outer, inner, expected) => {
    expect(FolderPath.contains(FolderPath.parse(outer), FolderPath.parse(inner))).toBe(expected);
  });

  const CONTAINS_DOC: Array<[string, string, boolean]> = [
    ["/", "/x.md", true],
    ["/a", "/a/x.md", true],
    ["/a", "/a/b/x.md", true],
    ["/a", "/ab/x.md", false],
    ["/a", "/a.md", false],
  ];

  it.each(CONTAINS_DOC)("containsDoc(%j, %j) === %j", (folder, doc, expected) => {
    expect(FolderPath.containsDoc(FolderPath.parse(folder), doc)).toBe(expected);
  });
});

describe("FolderPath.rebaseDocPath", () => {
  const REBASES: Array<[string, string, string, string]> = [
    ["/team/sub/c.md", "/team", "/squad", "/squad/sub/c.md"],
    ["/team/c.md", "/team", "/a/b", "/a/b/c.md"],
    ["/a/b/c.md", "/a/b", "/a", "/a/c.md"],
  ];

  it.each(REBASES)("rebase(%j, %j -> %j) === %j", (doc, from, to, expected) => {
    const result = FolderPath.rebaseDocPath(
      DocPath.parse(doc),
      FolderPath.parse(from),
      FolderPath.parse(to),
    );
    expect(result).toBe(expected);
    expect(DocPath.isDocPath(result)).toBe(true);
  });

  it("throws when the document is not under the from-folder", () => {
    let caught: unknown = null;
    try {
      FolderPath.rebaseDocPath(
        DocPath.parse("/other/c.md"),
        FolderPath.parse("/team"),
        FolderPath.parse("/squad"),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
  });
});
