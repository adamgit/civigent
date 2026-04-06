/**
 * CurrentUserContext — provides the authenticated user identity app-wide.
 *
 * Placed in AppLayout so every page (including SharedPageHeader) can access
 * the current user without depending on router outlet context.
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
