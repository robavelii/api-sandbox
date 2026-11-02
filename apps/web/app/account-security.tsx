"use client";
import { useState } from "react";

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
    <details className="panel" id="account-security">
      <summary>Account security</summary>
      <p>
        Changing your password signs out other devices and refreshes your
        current session.
      </p>
      <form
        className="scenario-toolbar"
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
        <label>
          Current password
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
          />
        </label>
        <label>
          New password
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
          />
        </label>
        <button className="button light" disabled={busy}>
          Change password
        </button>
      </form>
      <div className="scenario-toolbar">
        <button
          className="button light"
          disabled={busy}
          onClick={() => void action("logout-others")}
        >
          Sign out other devices
        </button>
        <button
          className="button light"
          disabled={busy}
          onClick={() => void action("logout-all")}
        >
          Sign out everywhere
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </details>
  );
}
