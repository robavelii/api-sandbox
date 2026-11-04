"use client";
import { useEffect, useState } from "react";
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
  useEffect(() => {
    if (owner) void run(async () => setPending(await api("")));
  }, [owner]);
  return (
    <section className="settings-section" id="workspace-invitations">
      <h2>Invitations</h2>
      <p className="muted">
        Verify your email in Account security before creating or accepting
        invitations. Invitation codes are shared directly by workspace owners.
      </p>
      {error && (
        <p role="alert" className="callout callout-bad">
          {error}
        </p>
      )}
      {owner && (
        <>
          <form
            className="panel form-panel form-row"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await api("", { email });
                setSecret(result.code);
                setPending(await api(""));
              });
            }}
          >
            <div className="field">
              <label htmlFor="invite-email">Invite email</label>
              <input
                id="invite-email"
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <button className="btn btn-primary" disabled={busy}>
              Create invitation
            </button>
          </form>
          {secret && (
            <div className="callout callout-accent secret">
              <p>
                Share this code securely with the invited email address:{" "}
                <code className="secret-value">{secret}</code>
              </p>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setSecret("")}
              >
                Dismiss invitation code
              </button>
            </div>
          )}
          {pending.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">
                  Pending invitations
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Email</th>
                    <th scope="col">Expires</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((invitation) => (
                    <tr key={invitation.id}>
                      <td>{invitation.email}</td>
                      <td className="measured cool">
                        {new Date(invitation.expires_at).toLocaleDateString()}
                      </td>
                      <td className="cell-action">
                        <button
                          className="btn btn-quiet"
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <form
        className="panel form-panel form-row"
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
        <div className="field">
          <label htmlFor="invitation-code">Invitation code</label>
          <input
            id="invitation-code"
            className="measured"
            required
            minLength={64}
            maxLength={64}
            value={code}
            onChange={(event) => setCode(event.target.value.trim())}
          />
        </div>
        <button className="btn" disabled={busy}>
          Accept invitation
        </button>
      </form>
    </section>
  );
}
