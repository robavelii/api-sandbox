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
      className="panel"
      id="password-recovery"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Forgot password?</summary>
      {open && (
        <>
          <p>
            Recovery is available for verified email addresses. Request a code,
            then enter it below within 30 minutes.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(false);
            }}
          >
            <label>
              Recovery email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                maxLength={254}
                autoComplete="email"
              />
            </label>
            <button className="button light" disabled={busy}>
              Send recovery code
            </button>
          </form>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(true);
            }}
          >
            <label>
              Recovery code
              <input
                value={code}
                onChange={(event) => setCode(event.target.value.trim())}
                required
                minLength={64}
                maxLength={64}
                autoComplete="one-time-code"
              />
            </label>
            <label>
              Replacement password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </label>
            <button className="button light" disabled={busy}>
              Reset password
            </button>
          </form>
          {message && <p role="status">{message}</p>}
        </>
      )}
    </details>
  );
}
