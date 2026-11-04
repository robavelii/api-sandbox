"use client";
import { useState } from "react";

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
  return (
    <details className="panel" id="platform-keys">
      <summary>Platform API keys</summary>
      <p>
        Create read-only control-plane keys for CI and tooling. Keys are bound
        to this workspace and require their creator to retain owner access.
        Sandbox request keys are separate.
      </p>
      <form
        className="scenario-toolbar"
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
        <label>
          Platform key name
          <input
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Expires in days
          <input
            type="number"
            required
            min={1}
            max={365}
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          />
        </label>
        <button className="button light" disabled={busy}>
          Create platform key
        </button>
      </form>
      {secret && (
        <p>
          Save this platform key now: <code>{secret}</code>{" "}
          <button type="button" onClick={() => setSecret("")}>
            Dismiss platform key
          </button>
        </p>
      )}
      <button
        className="button light"
        disabled={busy}
        onClick={() => void run(async () => setKeys(await api("")))}
      >
        Load platform keys
      </button>
      {keys.map((key) => (
        <div className="scenario-toolbar" key={key.id}>
          <span>
            {key.name} · {key.scope} · expires{" "}
            {new Date(key.expires_at).toLocaleDateString()} ·{" "}
            {key.revoked_at ? "revoked" : "issued"}
          </span>
          {!key.revoked_at && (
            <button
              className="button light"
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
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
