export function routeOwnsItsAuthenticationFlow(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/approve-agent-access" ||
    pathname === "/share" ||
    pathname.startsWith("/share/")
  );
}
