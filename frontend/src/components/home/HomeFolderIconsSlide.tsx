import { Link } from "react-router-dom";
import type { DocumentTreeEntry } from "../../types/shared.js";
import { FolderTreeRadialDots } from "../folder-details/FolderTreeRadialDots";

function file(path: string, bytes: number): DocumentTreeEntry {
  return { type: "file", name: path.slice(path.lastIndexOf("/") + 1), path, size_bytes: bytes };
}

function dir(path: string, children: DocumentTreeEntry[]): DocumentTreeEntry {
  return { type: "directory", name: path.slice(path.lastIndexOf("/") + 1), path, children };
}

function nest(base: string, count: number, fileBytes: number): DocumentTreeEntry[] {
  return Array.from({ length: count }, (_, i) =>
    dir(`${base}/f${i}`, [file(`${base}/f${i}/doc.md`, fileBytes)]),
  );
}

/** A made-up tree with mixed sizes and nesting so the icon shows every mark. */
const EXAMPLE_FOLDER_TREE: DocumentTreeEntry = dir("/example", [
  dir("/example/docs", [
    file("/example/docs/guide.md", 18000),
    file("/example/docs/api.md", 14000),
    file("/example/docs/faq.md", 9000),
  ]),
  dir("/example/notes", [file("/example/notes/scratch.md", 800)]),
  dir("/example/projects", [...nest("/example/projects", 3, 4000), file("/example/projects/readme.md", 2000)]),
  dir("/example/research", nest("/example/research", 8, 2500)),
  dir("/example/library", nest("/example/library", 20, 3000)),
  dir("/example/inbox", [file("/example/inbox/todo.md", 400)]),
  dir("/example/archive", [
    file("/example/archive/old.md", 22000),
    file("/example/archive/older.md", 16000),
    ...nest("/example/archive", 2, 5000),
  ]),
]);

export function HomeFolderIconsSlide() {
  return (
    <div className="home-slide__icon-row">
      <FolderTreeRadialDots
        entry={EXAMPLE_FOLDER_TREE}
        className="home-slide__folder-icon"
      />
      <div className="home-slide__icon-copy">
        <p className="home-slide__body">
          Each folder gets a little map of what's inside. Bigger dots hold more documents. Rings mean nested folders.
        </p>
        <div className="home-slide__links">
          <Link to="/docs">Browse folders {"\u2192"}</Link>
        </div>
      </div>
    </div>
  );
}
