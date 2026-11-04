"use client";
import { useState } from "react";
import EmailVerification from "./email-verification";

export default function AccountSecurity({
  onSignedOut,
}: {
  onSignedOut: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function action(path: string, body: unknown = {}) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Request failed.");
      if (path === "logout-all") onSignedOut();
      else
        setMessage(
          path === "password"
            ? "Password updated. Other devices have been signed out."
            : "Other devices have been signed out.",
        );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" id="account-security">
      <h2>Account security</h2>
      <EmailVerification />
      <div className="panel form-panel">
        <h3>Password</h3>
        <p className="muted">
          Changing your password signs out other devices and refreshes your
          current session.
        </p>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const body = {
              currentPassword: data.get("currentPassword"),
              newPassword: data.get("newPassword"),
            };
            form.reset();
            void action("password", body);
          }}
        >
          <div className="field">
            <label htmlFor="current-password">Current password</label>
            <input
              id="current-password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </div>
          <div className="field">
            <label htmlFor="new-password">New password</label>
            <input
              id="new-password"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
            />
          </div>
          <div className="actions">
            <button className="btn" disabled={busy}>
              Change password
            </button>
          </div>
        </form>
      </div>
      <div className="panel form-panel">
        <h3>Sessions</h3>
        <div className="actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => void action("logout-others")}
          >
            Sign out other devices
          </button>
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={() => void action("logout-all")}
          >
            Sign out everywhere
          </button>
        </div>
      </div>
      {message && (
        <p role="status" className="callout">
          {message}
        </p>
      )}
    </section>
  );
}
