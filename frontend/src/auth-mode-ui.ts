import type { LoginProvider } from "./types/shared.js";

export const AUTH_MODE_ORDER: readonly LoginProvider[] = ["single_user", "credentials", "oidc"];

/** Short badge copy and explainer text for the current `KS_AUTH_MODE`. */
export const AUTH_MODE_UI: Record<
  LoginProvider,
  {
    label: string;
    description: string;
    detail: string;
    env: string;
    modifier: "open" | "password" | "sso";
  }
> = {
  single_user: {
    label: "Open",
    description: "No login. Anyone who can open this URL is admin.",
    detail: "No login, localhost only. Anyone who can open the URL is admin.",
    env: "KS_AUTH_MODE=single_user",
    modifier: "open",
  },
  credentials: {
    label: "Password",
    description: "Humans sign in with a shared password.",
    detail: "One shared password. Allowed on a public hostname.",
    env: "KS_AUTH_MODE=credentials",
    modifier: "password",
  },
  oidc: {
    label: "SSO",
    description: "Humans sign in through the configured OIDC provider.",
    detail: "SSO only. No local password.",
    env: "KS_AUTH_MODE=oidc",
    modifier: "sso",
  },
};
