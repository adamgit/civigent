import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ContentPanel } from "../components/ContentPanel";
import { PageStatusBar } from "../components/PageStatusBar";
import { apiClient } from "../services/api-client";

export function ApproveAgentAccessPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [authChecked, setAuthChecked] = useState(false);
  const [denyError, setDenyError] = useState<string | null>(null);

  const clientId = searchParams.get("client_id") ?? "";
  const redirectUri = searchParams.get("redirect_uri") ?? "";
  const codeChallenge = searchParams.get("code_challenge") ?? "";
  const codeChallengeMethod = searchParams.get("code_challenge_method") ?? "S256";
  const state = searchParams.get("state") ?? "";
  const responseType = searchParams.get("response_type") ?? "code";
  const agentName = searchParams.get("agent_name") ?? "";

  const missingParams = !clientId || !redirectUri || !codeChallenge;

  useEffect(() => {
    let cancelled = false;
    const toLogin = () => {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    };
    apiClient.getSessionInfo()
      .then((session) => {
        if (cancelled) return;
        if (session.authenticated) {
          setAuthChecked(true);
        } else {
          toLogin();
        }
      })
      .catch(() => {
        if (!cancelled) toLogin();
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const handleDeny = () => {
    try {
      const target = new URL(redirectUri);
      target.searchParams.set("error", "access_denied");
      if (state) target.searchParams.set("state", state);
      window.location.href = target.toString();
    } catch {
      setDenyError("The redirect URI in this request is not a valid URL.");
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto flex justify-center" style={{ fontFamily: "var(--font-ui)" }}>
        <div style={{ maxWidth: 480, width: "100%", margin: "40px auto" }}>
          <ContentPanel>
            <ContentPanel.Header className="border-b-0 pb-0">
              <div>
                <div style={{ fontSize: 18, fontWeight: 600, color: "var(--color-text-primary)" }}>Approve agent access</div>
                <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>
                  An agent is requesting access to this Knowledge Store
                </div>
              </div>
            </ContentPanel.Header>
            <ContentPanel.Body>
              {missingParams ? (
                <p data-testid="consent-error" className="text-error">
                  This approval request is incomplete (missing client_id, redirect_uri, or code_challenge). Close this page and retry the connection from your agent.
                </p>
              ) : !authChecked ? (
                <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>Checking your session…</p>
              ) : (
                <>
                  <div className="mb-4" style={{ fontSize: 13, color: "var(--color-text-primary)" }}>
                    <p className="mb-2">
                      Approving grants this agent access to act against this server with its own identity. The name below is claimed by the agent itself — it is not verified.
                    </p>
                  </div>
                  <div
                    className="mb-4"
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                      background: "#f7f5f1",
                      padding: "12px 14px",
                      borderRadius: 6,
                      wordBreak: "break-all",
                    }}
                  >
                    <div className="mb-2">
                      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Agent name (self-asserted)</div>
                      <div data-testid="consent-agent-name">{agentName || "(none provided)"}</div>
                    </div>
                    <div className="mb-2">
                      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Client ID</div>
                      <div data-testid="consent-client-id">{clientId}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Redirect URI</div>
                      <div data-testid="consent-redirect-uri">{redirectUri}</div>
                    </div>
                  </div>
                  {denyError && <p className="text-error mb-3">{denyError}</p>}
                  <div className="flex gap-2">
                    <form method="post" action="/oauth/authorize" className="flex-1">
                      <input type="hidden" name="client_id" value={clientId} />
                      <input type="hidden" name="redirect_uri" value={redirectUri} />
                      <input type="hidden" name="code_challenge" value={codeChallenge} />
                      <input type="hidden" name="code_challenge_method" value={codeChallengeMethod} />
                      <input type="hidden" name="state" value={state} />
                      <input type="hidden" name="response_type" value={responseType} />
                      <button type="submit" data-testid="consent-approve" className="btn-primary w-full">
                        Approve
                      </button>
                    </form>
                    <button type="button" data-testid="consent-deny" onClick={handleDeny} className="btn-secondary flex-1">
                      Deny
                    </button>
                  </div>
                </>
              )}
            </ContentPanel.Body>
          </ContentPanel>
        </div>
      </div>
      <PageStatusBar items={["Approve agent access"]} />
    </div>
  );
}
