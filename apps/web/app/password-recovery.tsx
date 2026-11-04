"use client";
import { useState } from "react";
export default function PasswordRecovery() {
  const [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [password, setPassword] = useState("");
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  async function submit(confirm: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/auth/recovery/${confirm ? "confirm" : "request"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            confirm ? { code, newPassword: password } : { email },
          ),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Recovery failed.");
      setMessage(
        confirm
          ? "Password reset. Sign in using your new password."
          : result.message,
      );
      if (confirm) {
        setCode("");
        setPassword("");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Recovery failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="disclosure"
      id="password-recovery"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Forgot password?</summary>
      {open && (
        <div className="disclosure-body">
          <p className="muted">
            Recovery is available for verified email addresses. Request a code,
            then enter it below within 30 minutes.
          </p>
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(false);
            }}
          >
            <div className="field">
              <label htmlFor="recovery-email">Recovery email</label>
              <input
                id="recovery-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                maxLength={254}
                autoComplete="email"
              />
            </div>
            <div className="actions">
              <button className="btn" disabled={busy}>
                Send recovery code
              </button>
            </div>
          </form>
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(true);
            }}
          >
            <div className="field">
              <label htmlFor="recovery-code">Recovery code</label>
              <input
                id="recovery-code"
                className="measured"
                value={code}
                onChange={(event) => setCode(event.target.value.trim())}
                required
                minLength={64}
                maxLength={64}
                autoComplete="one-time-code"
              />
            </div>
            <div className="field">
              <label htmlFor="replacement-password">Replacement password</label>
              <input
                id="replacement-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </div>
            <div className="actions">
              <button className="btn" disabled={busy}>
                Reset password
              </button>
            </div>
          </form>
          {message && (
            <p role="status" className="callout">
              {message}
            </p>
          )}
        </div>
      )}
    </details>
  );
}
