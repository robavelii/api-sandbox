"use client";
import { useState } from "react";
type Invitation = { id: string; email: string; expires_at: string };
export default function WorkspaceInvitations({ owner }: { owner: boolean }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState<Invitation[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function api(path: string, body?: unknown) {
    const response = await fetch(`/api/workspaces/invitations${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "Invitation request failed.");
    return result;
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Invitation request failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="panel" id="workspace-invitations">
      <summary>Workspace invitations</summary>
      <p>
        Verify your email in Account security before creating or accepting
        invitations. Invitation codes are shared directly by workspace owners.
      </p>
      {owner && (
        <>
          <form
            className="scenario-toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await api("", { email });
                setSecret(result.code);
                setPending(await api(""));
              });
            }}
          >
            <label>
              Invite email
              <input
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <button className="button light" disabled={busy}>
              Create invitation
            </button>
          </form>
          {secret && (
            <p>
              Share this code securely with the invited email address:{" "}
              <code>{secret}</code>{" "}
              <button type="button" onClick={() => setSecret("")}>
                Dismiss invitation code
              </button>
            </p>
          )}
          <button
            className="button light"
            disabled={busy}
            onClick={() => void run(async () => setPending(await api("")))}
          >
            Load pending invitations
          </button>
          {pending.map((invitation) => (
            <div key={invitation.id}>
              <span>
                {invitation.email} · expires{" "}
                {new Date(invitation.expires_at).toLocaleDateString()}
              </span>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/${invitation.id}/revoke`, {});
                    setPending(await api(""));
                    setSecret("");
                  })
                }
              >
                Revoke {invitation.email}
              </button>
            </div>
          ))}
        </>
      )}
      <form
        className="scenario-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const result = await api("/accept", { code });
            const selected = await fetch("/api/workspaces/select", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workspaceId: result.workspaceId }),
            });
            if (!selected.ok)
              throw new Error(
                "Invitation accepted. Select your new workspace after refreshing.",
              );
            window.location.reload();
          });
        }}
      >
        <label>
          Invitation code
          <input
            required
            minLength={64}
            maxLength={64}
            value={code}
            onChange={(event) => setCode(event.target.value.trim())}
          />
        </label>
        <button className="button light" disabled={busy}>
          Accept invitation
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
