/**
 * authorized-read.ts — the compile-time proof that a document read was
 * ACL-checked.
 *
 * `AuthorizedDocRead` is a branded value carrying the checked `DocPath`; the
 * user-serving read primitives take the brand INSTEAD of a raw path and derive
 * the path back out of it, so checking one path while reading another is
 * unrepresentable. The only mints are here: `authorizeDocRead` (runs the ACL
 * resolver, throws `PermissionError` on denial; a `null` writer resolves the
 * existing public-read rules) and `systemDocRead` (no check — requires a
 * `SystemAuthority`, the single explicit bypass).
 *
 * Lifetime law: request-scoped only. Never cached, never stored on anything
 * that outlives the request; long-lived consumers (CRDT sessions) re-authorize
 * at their own boundaries.
 */

import type { DocPath } from "../types/shared.js";
import type { AuthenticatedWriter } from "./context.js";
import { checkDocPermission } from "./acl.js";
import type { SystemAuthority } from "./system-authority.js";

declare const __authorizedDocRead: unique symbol;

export class PermissionError extends Error {
  constructor(
    message: string,
    readonly writerWasAnonymous: boolean,
  ) {
    super(message);
  }
}

export type AuthorizedDocRead = {
  readonly docPath: DocPath;
  readonly [__authorizedDocRead]: true;
};

export async function authorizeDocRead(
  writer: AuthenticatedWriter | null,
  docPath: DocPath,
): Promise<AuthorizedDocRead> {
  if (!(await checkDocPermission(writer, docPath, "read"))) {
    throw new PermissionError(`Read permission denied for ${docPath}`, writer === null);
  }
  return { docPath } as AuthorizedDocRead;
}

export function systemDocRead(authority: SystemAuthority, docPath: DocPath): AuthorizedDocRead {
  void authority;
  return { docPath } as AuthorizedDocRead;
}
