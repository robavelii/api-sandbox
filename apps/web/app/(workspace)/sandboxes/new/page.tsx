"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "../../../lib/api";
import { useWorkspace } from "../../workspace-context";

function ImportContract() {
  const router = useRouter(),
    params = useSearchParams();
  const { refresh, setSecret } = useWorkspace();
  const [source, setSource] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (params.get("example") !== "payments") return;
    fetch("/payments.json")
      .then((response) => response.text())
      .then(setSource)
      .catch((e) => setError(e.message));
  }, [params]);
  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Import your API</h1>
          <p className="lead">
            Paste or upload a contract. Next you review the behavior SpecTwin
            inferred for each operation, then approve it to activate the
            sandbox.
          </p>
        </div>
      </header>
      <form
        className="panel form-panel"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          api("/sandboxes", { source })
            .then(async (b) => {
              setSecret({ id: b.id, key: b.apiKey });
              await refresh();
              router.push(`/sandboxes/${b.id}?tab=operations`);
            })
            .catch((e) => {
              setError(e.message);
              setBusy(false);
            });
        }}
      >
        <div className="field">
          <label htmlFor="spec-file">Specification file</label>
          <input
            id="spec-file"
            type="file"
            accept=".json,.yaml,.yml"
            onChange={async (e) => {
              if (e.target.files?.[0])
                setSource(await e.target.files[0].text());
            }}
          />
          <p className="hint">
            OpenAPI 3.0 or 3.1, JSON or YAML. Maximum 1 MB.
          </p>
        </div>
        <div className="field">
          <label htmlFor="spec-source">Specification source</label>
          <textarea
            id="spec-source"
            className="code-input"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            required
          />
        </div>
        {error && (
          <p role="alert" className="callout callout-bad">
            {error}
          </p>
        )}
        <div className="actions">
          <button disabled={busy} aria-busy={busy} className="btn btn-primary">
            {busy ? "Importing…" : "Import contract"}
          </button>
        </div>
      </form>
    </div>
  );
}
export default function NewSandbox() {
  return (
    <Suspense fallback={<div className="page" aria-busy="true" />}>
      <ImportContract />
    </Suspense>
  );
}
