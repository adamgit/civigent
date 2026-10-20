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
  legacyAdminEnv: readonly string[];
}

const CurrentUserContext = createContext<CurrentUserContextValue>({
  currentUser: null,
  legacyAdminEnv: [],
});

export function CurrentUserProvider({
  currentUser,
  legacyAdminEnv = [],
  children,
}: {
  currentUser: AuthUser | null;
  legacyAdminEnv?: readonly string[];
  children: ReactNode;
}) {
  return (
    <CurrentUserContext.Provider value={{ currentUser, legacyAdminEnv }}>
      {children}
    </CurrentUserContext.Provider>
  );
}

export function useCurrentUser(): AuthUser | null {
  return useContext(CurrentUserContext).currentUser;
}

export function useLegacyAdminEnv(): readonly string[] {
  return useContext(CurrentUserContext).legacyAdminEnv;
}
