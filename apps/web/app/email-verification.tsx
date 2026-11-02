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
    <section>
      <h3>Email verification</h3>
      <button
        type="button"
        className="button light"
        disabled={busy}
        onClick={() => void submit(false)}
      >
        Send verification code
      </button>
      <form
        className="scenario-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(true);
        }}
      >
        <label>
          Verification code
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.trim())}
            required
            minLength={64}
            maxLength={64}
            autoComplete="one-time-code"
          />
        </label>
        <button className="button light" disabled={busy}>
          Verify email
        </button>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
