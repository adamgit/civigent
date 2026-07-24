/**
 * CurrentUserContext — provides the authenticated user identity app-wide.
 *
 * Placed in AppLayout around the full layout (sidebar + main) so sidebar
 * identity and page consumers can access the current user.
 */

import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { AuthUser } from "../types/shared.js";

interface CurrentUserContextValue {
  currentUser: AuthUser | null;
}

const CurrentUserContext = createContext<CurrentUserContextValue>({ currentUser: null });

export function CurrentUserProvider({ currentUser, children }: { currentUser: AuthUser | null; children: ReactNode }) {
  return (
    <CurrentUserContext.Provider value={{ currentUser }}>
      {children}
    </CurrentUserContext.Provider>
  );
}

export function useCurrentUser(): AuthUser | null {
  return useContext(CurrentUserContext).currentUser;
}
