# SSO Setup (OIDC Providers)

How to configure Civigent to authenticate humans via an external identity provider.

Civigent supports any identity provider that publishes a standard OIDC discovery document. You configure it with four env vars — no rebuild needed:

```env
KS_OIDC_PUBLIC_URL=https://your-civigent-domain  # public URL of YOUR Civigent server (required)
KS_OIDC_ISSUER=https://your-provider.com          # provider's base URL
KS_OIDC_CLIENT_ID=your-client-id
KS_OIDC_CLIENT_SECRET=your-client-secret
KS_OIDC_DISPLAY_NAME=Sign in with Acme SSO        # optional — controls the button label
```

`KS_OIDC_PUBLIC_URL` is the URL users type into their browser to reach Civigent (e.g. `https://collab.example.com`). It is used to construct the OAuth callback URL. No trailing slash.

The redirect URI you register with your provider is always:
```
https://<your-civigent-domain>/api/auth/oidc/callback
```

---

## Providers

- [Google Workspace](#google-workspace)
- [Microsoft Entra ID (Azure AD)](#microsoft-entra-id-azure-ad)
- [Keycloak](#keycloak)
- [Authentik](#authentik)
- [Okta](#okta)
- [Auth0](#auth0)

---

## Google Workspace

**Issuer:** `https://accounts.google.com`

### Step 1 — Create an OAuth client

1. Open [Google Cloud Console](https://console.cloud.google.com) and select your project (or create one).
2. Go to **APIs & Services → Credentials**.
3. Click **Create Credentials → OAuth 2.0 Client ID**.
4. Application type: **Web application**.
5. Give it a name (e.g., `Civigent`).
6. Under **Authorized redirect URIs**, add:
   ```
   https://<your-civigent-domain>/api/auth/oidc/callback
   ```
7. Click **Create**.
8. Copy the **Client ID** and **Client secret** from the confirmation dialog.

### Step 2 — Configure the consent screen (Workspace orgs)

1. Go to **APIs & Services → OAuth consent screen**.
2. Set User type to **Internal** — this restricts login to your Google Workspace domain only. If you want to allow personal Google accounts, choose External and add test users.
3. Fill in the required fields (App name, support email). Scopes `openid`, `email`, and `profile` are requested by Civigent automatically.

### Step 3 — Set env vars

```env
KS_AUTH_MODE=oidc
KS_OIDC_PUBLIC_URL=https://your-civigent-domain
KS_OIDC_ISSUER=https://accounts.google.com
KS_OIDC_CLIENT_ID=123456789-abc.apps.googleusercontent.com
KS_OIDC_CLIENT_SECRET=GOCSPX-...
KS_OIDC_DISPLAY_NAME=Sign in with Google
```

### Admin bootstrap

The first time a Google account logs in, Civigent assigns it a stable UUID derived from the Google `sub` claim. To grant someone admin access, you need their Civigent UUID, then add it to `data/auth/roles.json`:

```json
{ "human-<uuid>": ["admin"] }
```

A user can find their UUID on the Login page (`/login`) after authenticating.

---

## Microsoft Entra ID (Azure AD)

The issuer URL includes your tenant ID — this is the main difference from other providers.

**Issuer:** `https://login.microsoftonline.com/<tenant-id>/v2.0`

### Step 1 — Register an application

1. Open the [Azure Portal](https://portal.azure.com) and go to **Microsoft Entra ID → App registrations**.
2. Click **New registration**.
3. Name: `Civigent`. Supported account types: **Accounts in this organizational directory only** (single-tenant).
4. Under **Redirect URI**, select **Web** and enter:
   ```
   https://<your-civigent-domain>/api/auth/oidc/callback
   ```
5. Click **Register**.
6. On the app overview page, note the **Application (client) ID** and **Directory (tenant) ID**.

### Step 2 — Create a client secret

1. Go to **Certificates & secrets → Client secrets → New client secret**.
2. Add a description and set an expiry period.
3. Copy the **Value** immediately — it's only shown once.

### Step 3 — Set env vars

Replace `<tenant-id>` with your Directory (tenant) ID from Step 1.

```env
KS_AUTH_MODE=oidc
KS_OIDC_PUBLIC_URL=https://your-civigent-domain
KS_OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
KS_OIDC_CLIENT_ID=<application-client-id>
KS_OIDC_CLIENT_SECRET=<client-secret-value>
KS_OIDC_DISPLAY_NAME=Sign in with Microsoft
```

> **Note:** Do not use `https://login.microsoftonline.com/common/v2.0` as the issuer. The `common` endpoint's discovery document does not include a concrete issuer, which breaks OIDC token validation. Use your specific tenant ID.

---

## Keycloak

Replace `<keycloak-host>` with your Keycloak base URL and `<realm>` with your realm name.

**Issuer:** `https://<keycloak-host>/realms/<realm>`

### Step 1 — Create a client

1. Log in to the Keycloak Admin Console and select your realm.
2. Go to **Clients → Create client**.
3. Client ID: `civigent`. Client type: **OpenID Connect**.
4. Enable **Client authentication** (makes this a confidential client).
5. Under **Valid redirect URIs**, add:
   ```
   https://<your-civigent-domain>/api/auth/oidc/callback
   ```
6. Save.
7. Go to the **Credentials** tab and copy the **Client secret**.

### Step 2 — Set env vars

```env
KS_AUTH_MODE=oidc
KS_OIDC_PUBLIC_URL=https://your-civigent-domain
KS_OIDC_ISSUER=https://<keycloak-host>/realms/<realm>
KS_OIDC_CLIENT_ID=civigent
KS_OIDC_CLIENT_SECRET=<client-secret>
KS_OIDC_DISPLAY_NAME=Sign in with Keycloak
```

---

## Authentik

Replace `<authentik-host>` with your Authentik base URL.

**Issuer:** `https://<authentik-host>/application/o/<application-slug>/`

### Step 1 — Create a provider

1. Log in to the Authentik Admin interface.
2. Go to **Applications → Providers → Create**.
3. Choose **OAuth2/OpenID Provider**.
4. Name it `Civigent`. Set **Authorization flow** to your preferred flow (e.g., `default-authorization-flow`).
5. Under **Redirect URIs/Origins**, add:
   ```
   https://<your-civigent-domain>/api/auth/oidc/callback
   ```
6. Copy the **Client ID** and **Client Secret** from the provider's detail page.

### Step 2 — Create an application

1. Go to **Applications → Applications → Create**.
2. Name: `Civigent`. Slug: `civigent`. Link the provider you just created.
3. Note the slug — it forms part of the issuer URL.

### Step 3 — Set env vars

```env
KS_AUTH_MODE=oidc
KS_OIDC_PUBLIC_URL=https://your-civigent-domain
KS_OIDC_ISSUER=https://<authentik-host>/application/o/civigent/
KS_OIDC_CLIENT_ID=<client-id>
KS_OIDC_CLIENT_SECRET=<client-secret>
KS_OIDC_DISPLAY_NAME=Sign in with Authentik
```

> **Note:** The trailing slash in the issuer URL is required for Authentik. It must exactly match the `iss` claim in the issued tokens.

---

## Okta

**Issuer:** `https://<your-okta-domain>/oauth2/default`

### Step 1 — Create an application

1. In the Okta Admin Console, go to **Applications → Applications → Create App Integration**.
2. Sign-in method: **OIDC - OpenID Connect**. Application type: **Web Application**.
3. Under **Sign-in redirect URIs**, add:
   ```
   https://<your-civigent-domain>/api/auth/oidc/callback
   ```
4. Under **Sign-out redirect URIs**, add your Civigent root URL (optional).
5. **Assignments**: restrict to the groups or users who should have access.
6. Copy the **Client ID** and **Client secret**.

### Step 2 — Set env vars

```env
KS_AUTH_MODE=oidc
KS_OIDC_PUBLIC_URL=https://your-civigent-domain
KS_OIDC_ISSUER=https://<your-okta-domain>/oauth2/default
KS_OIDC_CLIENT_ID=<client-id>
KS_OIDC_CLIENT_SECRET=<client-secret>
KS_OIDC_DISPLAY_NAME=Sign in with Okta
```

---

## Auth0

**Issuer:** `https://<your-auth0-domain>/`

### Step 1 — Create an application

1. In the Auth0 Dashboard, go to **Applications → Applications → Create Application**.
2. Name: `Civigent`. Type: **Regular Web Application**.
3. Go to **Settings** and under **Allowed Callback URLs**, add:
   ```
   https://<your-civigent-domain>/api/auth/oidc/callback
   ```
4. Copy the **Domain**, **Client ID**, and **Client Secret**.

### Step 2 — Set env vars

```env
KS_AUTH_MODE=oidc
KS_OIDC_PUBLIC_URL=https://your-civigent-domain
KS_OIDC_ISSUER=https://<your-auth0-domain>/
KS_OIDC_CLIENT_ID=<client-id>
KS_OIDC_CLIENT_SECRET=<client-secret>
KS_OIDC_DISPLAY_NAME=Sign in with Auth0
```

> **Note:** The trailing slash in the issuer URL is required for Auth0. The `iss` claim in Auth0 tokens includes the trailing slash, so the issuer URL must match exactly.

---

## Hybrid mode

Hybrid mode is the same as OIDC mode but is the expected mode for initial setup. Set:

```env
KS_AUTH_MODE=hybrid
KS_OIDC_PUBLIC_URL=https://your-civigent-domain
KS_OIDC_ISSUER=...
KS_OIDC_CLIENT_ID=...
KS_OIDC_CLIENT_SECRET=...
```

### Admin bootstrap

When the server starts with OIDC configured but no admin users in `data/auth/roles.json`, it prints a one-time bootstrap code to stdout. After logging in via OIDC, enter this code on the login page to claim admin. The code is single-use and a new one is generated on each restart (until an admin exists).

---

## Troubleshooting

**"KS_OIDC_ISSUER is not set" at startup**
You are running in `oidc` or `hybrid` auth mode but forgot to set the OIDC env vars. Either set them or switch to `single_user` mode.

**Callback URL mismatch error from provider**
The redirect URI registered with your provider must exactly match `https://<your-civigent-domain>/api/auth/oidc/callback`. Check `KS_OIDC_PUBLIC_URL` — it must reflect the URL users actually see in their browser (not an internal Docker port).

**"issuer mismatch" error after login**
The `KS_OIDC_ISSUER` you configured does not match the `iss` claim in the provider's tokens. For Auth0 and Authentik this is typically a missing trailing slash. Check the provider's discovery document at `<issuer>/.well-known/openid-configuration` to confirm the exact issuer value.

**User logs in but has no admin access**
Admin access is granted via `data/auth/roles.json`. The user's Civigent UUID must be added there. See [Admin bootstrap](#admin-bootstrap) under Google Workspace (the process is identical for all providers).

---

## What's next

- [Authentication](authentication.md) — how human and agent auth work conceptually
- [Deployment Guide](deployment.md) — full deployment scenarios and env var reference
