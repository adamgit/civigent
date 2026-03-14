import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ContentPanel } from "../components/ContentPanel";
import { StatusPill } from "../components/StatusPill";
import { PageStatusBar } from "../components/PageStatusBar";
import { apiClient, resolveWriterId } from "../services/api-client";

function resolveReturnToTarget(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [methods, setMethods] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const currentWriterId = resolveWriterId();
  const returnToTarget = useMemo(
    () => resolveReturnToTarget(searchParams.get("returnTo")),
    [searchParams],
  );
  const supportsSingleUser = methods.includes("single_user") || methods.length === 0;
  const supportsOidc = methods.includes("oidc");
  const supportsCredentials = methods.includes("credentials");

  useEffect(() => {
    apiClient.getAuthMethods()
      .then((response) => setMethods(Array.isArray(response.methods) ? response.methods : []))
      .catch(() => setMethods([]));
  }, []);

  const handleSingleUserLogin = async () => {
    setWorking(true);
    setMessage(null);
    setError(null);
    try {
      const login = await apiClient.loginSingleUser();
      setMessage(`Authenticated as ${login.identity.displayName}.`);
      navigate(returnToTarget);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const handleLogout = async () => {
    setWorking(true);
    try {
      await apiClient.logout();
      setMessage("Session cleared.");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const authMode = supportsSingleUser ? "single_user" : supportsCredentials ? "credentials" : supportsOidc ? "oidc" : "unknown";

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto flex justify-center" style={{ fontFamily: "var(--font-ui)" }}>
        <div style={{ maxWidth: 420, width: "100%", margin: "40px auto" }}>
          <ContentPanel>
            <ContentPanel.Header className="border-b-0 pb-0">
              <div>
                <div style={{ fontSize: 18, fontWeight: 600, color: "var(--color-text-primary)" }}>Sign in</div>
                <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>
                  Authenticate to access the Knowledge Store
                </div>
              </div>
            </ContentPanel.Header>
            <ContentPanel.Body>
              {/* Current session */}
              <div className="mb-5">
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>
                  Current session
                </div>
                <div
                  className="flex items-center gap-2"
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 13,
                    color: "var(--color-text-primary)",
                    background: "#f7f5f1",
                    padding: "10px 12px",
                    borderRadius: 6,
                  }}
                >
                  <span
                    className="flex items-center justify-center rounded-full text-[9px] font-semibold"
                    style={{ width: 20, height: 20, background: "#e8f4f6", color: "#1d5a66" }}
                  >
                    {currentWriterId.slice(0, 2).toUpperCase()}
                  </span>
                  <span>{currentWriterId}</span>
                  <span className="ml-auto">
                    <StatusPill variant="green" showDot>Active</StatusPill>
                  </span>
                </div>
              </div>

              {/* Authentication methods */}
              <div className="mb-5">
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>
                  Authentication methods
                </div>

                {/* Single-user session */}
                <button
                  onClick={() => void handleSingleUserLogin()}
                  disabled={working || !supportsSingleUser}
                  className="w-full flex items-center gap-2.5 mb-2"
                  style={{
                    padding: "12px 16px",
                    border: "1px solid #eae7e2",
                    borderRadius: 8,
                    background: "white",
                    cursor: supportsSingleUser ? "pointer" : "default",
                    opacity: supportsSingleUser ? 1 : 0.5,
                    textAlign: "left",
                  }}
                >
                  <span style={{ fontSize: 18, width: 24, textAlign: "center" }}>&#128100;</span>
                  <div className="flex-1">
                    <div style={{ fontWeight: 500, fontSize: 13 }}>Single-user session</div>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                    {supportsSingleUser ? "auto-configured" : "not available"}
                  </span>
                </button>

                {/* OIDC */}
                <button
                  disabled
                  className="w-full flex items-center gap-2.5 mb-2"
                  style={{
                    padding: "12px 16px",
                    border: "1px solid #eae7e2",
                    borderRadius: 8,
                    background: "white",
                    cursor: "default",
                    opacity: 0.5,
                    textAlign: "left",
                  }}
                >
                  <span style={{ fontSize: 18, width: 24, textAlign: "center" }}>&#128274;</span>
                  <div className="flex-1">
                    <div style={{ fontWeight: 500, fontSize: 13 }}>OIDC Provider</div>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                    {supportsOidc ? "configured" : "not configured"}
                  </span>
                </button>

                {/* Email & password */}
                <button
                  disabled
                  className="w-full flex items-center gap-2.5 mb-2"
                  style={{
                    padding: "12px 16px",
                    border: "1px solid #eae7e2",
                    borderRadius: 8,
                    background: "white",
                    cursor: "default",
                    opacity: 0.5,
                    textAlign: "left",
                  }}
                >
                  <span style={{ fontSize: 18, width: 24, textAlign: "center" }}>&#9993;</span>
                  <div className="flex-1">
                    <div style={{ fontWeight: 500, fontSize: 13 }}>Email & password</div>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                    {supportsCredentials ? "configured" : "not configured"}
                  </span>
                </button>
              </div>

              {message && <p className="text-xs text-green-700 mb-3">{message}</p>}
              {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

              {/* Primary action */}
              <button
                onClick={() => navigate(returnToTarget)}
                className="w-full mb-2"
                style={{
                  background: "#2d7a8a",
                  color: "white",
                  padding: "7px 14px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                Continue to documents
              </button>

              {/* Secondary action */}
              <button
                onClick={() => void handleLogout()}
                disabled={working}
                className="w-full"
                style={{
                  background: "#f7f5f1",
                  color: "var(--color-text-primary)",
                  padding: "7px 14px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                Clear session
              </button>
            </ContentPanel.Body>
          </ContentPanel>
        </div>
      </div>
      <PageStatusBar items={["Login", `Mode: ${authMode}`]} />
    </div>
  );
}
