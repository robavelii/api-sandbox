"use client";
import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";

type Key = {
  id: string;
  name: string;
  scope: string;
  expires_at: string;
  revoked_at: string | null;
};
export default function PlatformKeys() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [days, setDays] = useState(90);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function api(path: string, body?: unknown) {
    const response = await fetch(`/api/platform-keys${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "Platform key request failed.");
    return result;
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Platform key request failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(async () => setKeys(await api("")));
  }, []);
  return (
    <section className="settings-section" id="platform-keys">
      <div className="section-head">
        <h2>Platform keys</h2>
        <button
          className="btn btn-quiet"
          disabled={busy}
          onClick={() => void run(async () => setKeys(await api("")))}
        >
          <RotateCw aria-hidden size={16} />
          Refresh
        </button>
      </div>
      <p className="muted">
        Create read-only control-plane keys for CI and tooling. Keys are bound
        to this workspace and require their creator to retain owner access.
        Sandbox request keys are separate.
      </p>
      <form
        className="panel form-panel form-row"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const result = await api("", { name, expiresInDays: days });
            setSecret(result.token);
            setName("");
            setKeys(await api(""));
          });
        }}
      >
        <div className="field">
          <label htmlFor="platform-key-name">Platform key name</label>
          <input
            id="platform-key-name"
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field field-short">
          <label htmlFor="platform-key-days">Expires in days</label>
          <input
            id="platform-key-days"
            type="number"
            required
            min={1}
            max={365}
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          Create platform key
        </button>
      </form>
      {secret && (
        <div className="callout callout-accent secret">
          <p>
            Save this platform key now:{" "}
            <code className="secret-value">{secret}</code>
          </p>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => setSecret("")}
          >
            Dismiss platform key
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="callout callout-bad">
          {error}
        </p>
      )}
      {keys.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Scope</th>
                <th scope="col">Expires</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td>{key.scope}</td>
                  <td className="measured cool">
                    {new Date(key.expires_at).toLocaleDateString()}
                  </td>
                  <td>
                    {key.revoked_at ? (
                      <span className="chip chip-bad">revoked</span>
                    ) : (
                      <span className="chip chip-ok">issued</span>
                    )}
                  </td>
                  <td className="cell-action">
                    {!key.revoked_at && (
                      <button
                        className="btn btn-quiet"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api(`/${key.id}/revoke`, {});
                            setKeys(await api(""));
                            setSecret("");
                          })
                        }
                      >
                        Revoke {key.name}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !busy && <p className="panel empty">No platform keys yet.</p>
      )}
    </section>
  );
}
