"use client";
import { useState } from "react";
export default function EmailVerification() {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(confirm: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/auth/email-verification${confirm ? "/confirm" : ""}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(confirm ? { code } : {}),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Verification failed.");
      setMessage(
        confirm
          ? "Email verified."
          : "Verification code sent. Check your email.",
      );
      setCode("");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Verification failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="panel form-panel">
      <h3>Email verification</h3>
      <p className="muted">
        Verified addresses can create and accept invitations and recover a lost
        password.
      </p>
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void submit(false)}
        >
          Send verification code
        </button>
      </div>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(true);
        }}
      >
        <div className="field">
          <label htmlFor="verification-code">Verification code</label>
          <input
            id="verification-code"
            className="measured"
            value={code}
            onChange={(event) => setCode(event.target.value.trim())}
            required
            minLength={64}
            maxLength={64}
            autoComplete="one-time-code"
          />
        </div>
        <div className="actions">
          <button className="btn" disabled={busy}>
            Verify email
          </button>
        </div>
      </form>
      {message && (
        <p role="status" className="callout">
          {message}
        </p>
      )}
    </div>
  );
}
