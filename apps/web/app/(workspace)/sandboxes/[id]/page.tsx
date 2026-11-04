"use client";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Plus, RotateCw } from "lucide-react";
import ScenarioEditor from "../../../scenario-editor";
import WebhookPanel from "../../../webhook-panel";
import ConfirmAction from "../../../confirm-action";
import { api, type Session } from "../../../lib/api";
import { useWorkspace } from "../../workspace-context";

const tabs = [
  ["activity", "Activity"],
  ["operations", "Operations"],
  ["scenarios", "Scenarios"],
  ["webhooks", "Webhooks"],
] as const;
const time = (value: string) => new Date(value).toISOString();

function Sandbox() {
  const { id } = useParams<{ id: string }>();
  const tab = useSearchParams().get("tab") || "activity";
  const { boxes, usage, refresh, secret, setSecret } = useWorkspace();
  const [sessions, setSessions] = useState<Session[]>([]),
    [sid, setSid] = useState(""),
    [logs, setLogs] = useState<any[] | null>(null),
    [resources, setResources] = useState<any[]>([]),
    [naming, setNaming] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const box = boxes.find((b) => b.id === id),
    session = sessions.find((s) => s.id === sid);
  const key = secret.id === id ? secret.key : "";
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function activity() {
    if (!id || !sid) return;
    const [l, r] = await Promise.all([
      api(`/sandboxes/${id}/sessions/${sid}/logs`),
      api(`/sandboxes/${id}/sessions/${sid}/resources`),
    ]);
    setLogs(l);
    setResources(r);
  }
  useEffect(() => {
    setSessions([]);
    setSid("");
    if (box)
      api(`/sandboxes/${id}/sessions`)
        .then((s) => {
          setSessions(s);
          setSid(s[0]?.id || "");
        })
        .catch((e) => setError(e.message));
  }, [id, !!box]);
  useEffect(() => {
    setLogs(null);
    setResources([]);
    activity().catch((e) => setError(e.message));
  }, [id, sid]);
  if (!box)
    return (
      <div className="page">
        <section className="panel empty">
          <h1>Sandbox not found</h1>
          <p>It may have been deleted, or it belongs to another workspace.</p>
          <div className="actions">
            <Link className="btn" href="/sandboxes">
              All sandboxes
            </Link>
          </div>
        </section>
      </div>
    );
  const endpoint =
    (process.env.NEXT_PUBLIC_RUNTIME_URL || "http://localhost:4000") +
    "/sandbox/" +
    box.id;
  const latest = logs?.[0];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="title-row">
            <h1>{box.name}</h1>
            {box.approved ? (
              <span className="chip chip-ok">Ready</span>
            ) : (
              <span className="chip chip-accent">Review needed</span>
            )}
          </div>
          <p className="muted">
            OpenAPI <span className="measured">{box.contract.openapi}</span>
          </p>
        </div>
        <dl className="stats">
          <div>
            <dt>Operations</dt>
            <dd className="measured">{box.contract.operations.length}</dd>
          </div>
          <div>
            <dt>Stored resources</dt>
            <dd className="measured">{resources.length}</dd>
          </div>
          <div>
            <dt>Requests this month</dt>
            <dd className="measured">
              {usage?.requests} <small>of {usage?.request_limit}</small>
            </dd>
          </div>
        </dl>
      </header>

      {error && (
        <div role="alert" className="callout callout-bad">
          {error}
        </div>
      )}
      {key && (
        <div className="callout callout-accent secret">
          <div>
            <strong>Save this key securely:</strong>
            <code className="secret-value">{key}</code>
          </div>
          <p className="hint">It is shown once. Use it as a Bearer token.</p>
          <button
            className="btn btn-quiet"
            onClick={() => setSecret({ id: "", key: "" })}
          >
            Dismiss
          </button>
        </div>
      )}
      {!box.approved && (
        <section className="callout callout-accent review">
          <div>
            <h2>Review inferred behavior</h2>
            {box.contract.warnings.length > 0 && (
              <ul>
                {box.contract.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <p>
              Check each operation&rsquo;s behavior under Operations. The
              sandbox answers requests once you approve.
            </p>
          </div>
          <button
            disabled={busy}
            className="btn btn-primary"
            onClick={() =>
              run(async () => {
                await api(`/sandboxes/${box.id}/approve`, {});
                await refresh();
              })
            }
          >
            Approve inferred CRUD mappings
          </button>
        </section>
      )}

      <section className="panels connect" aria-label="Connection">
        <div className="connect-endpoint">
          <h2>Endpoint</h2>
          <code id="sandbox-endpoint" className="endpoint">
            {endpoint}
          </code>
          <div className="actions">
            <ConfirmAction
              label="Rotate key"
              title="Rotate the sandbox key?"
              body="The current key stops working immediately. Existing clients will need the new key."
              confirmLabel="Rotate key"
              danger
              disabled={busy}
              onConfirm={() =>
                run(async () => {
                  setSecret({
                    id: box.id,
                    key: (await api(`/sandboxes/${box.id}/key`, {})).apiKey,
                  });
                })
              }
            />
          </div>
        </div>
        <div className="connect-session">
          <h2>Session</h2>
          <div className="control-row">
            <select
              aria-label="Session"
              value={sid}
              onChange={(e) => setSid(e.target.value)}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Scenario"
              disabled={!sid || busy}
              value={session?.scenario || "success"}
              onChange={(e) => {
                const scenario = e.target.value;
                run(async () => {
                  await api(`/sandboxes/${box.id}/sessions/${sid}/scenario`, {
                    scenario,
                  });
                  setSessions(await api(`/sandboxes/${box.id}/sessions`));
                });
              }}
            >
              {["success", "error", "rate_limit", "delay"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <p className="hint">
            Send <code>X-SpecTwin-Session: {session?.name ?? "…"}</code> to use
            this session&rsquo;s state.
          </p>
          {naming ? (
            <form
              className="control-row"
              onSubmit={(e) => {
                e.preventDefault();
                const name = String(
                  new FormData(e.currentTarget).get("name") || "",
                );
                run(async () => {
                  const created = await api(`/sandboxes/${box.id}/sessions`, {
                    name,
                  });
                  setSessions(await api(`/sandboxes/${box.id}/sessions`));
                  setSid(created.id);
                  setNaming(false);
                });
              }}
            >
              <input
                name="name"
                aria-label="Session name"
                placeholder="ci"
                pattern="[a-z0-9-]+"
                title="Lowercase letters, numbers and hyphens"
                required
                autoFocus
              />
              <button className="btn btn-primary" disabled={busy}>
                Create session
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setNaming(false)}
              >
                Cancel
              </button>
            </form>
          ) : (
            <div className="actions">
              <button
                className="btn"
                disabled={busy}
                onClick={() => setNaming(true)}
              >
                <Plus aria-hidden size={16} />
                New session
              </button>
              <ConfirmAction
                label={
                  <>
                    <RotateCw aria-hidden size={16} />
                    Reset state
                  </>
                }
                title={`Reset session ${session?.name ?? ""}?`}
                body={`This deletes ${resources.length} stored resources and ${logs?.length ?? 0} logged requests, and restarts the ID sequence.`}
                confirmLabel="Reset session"
                danger
                disabled={busy || !sid}
                onConfirm={() =>
                  run(async () => {
                    await api(`/sandboxes/${box.id}/sessions/${sid}/reset`, {});
                    setSessions(await api(`/sandboxes/${box.id}/sessions`));
                    await activity();
                  })
                }
              />
            </div>
          )}
        </div>
      </section>

      <nav className="tabs" aria-label="Sandbox sections">
        {tabs.map(([slug, label]) => (
          <Link
            key={slug}
            href={`/sandboxes/${box.id}?tab=${slug}`}
            aria-current={tab === slug ? "page" : undefined}
            scroll={false}
          >
            {label}
          </Link>
        ))}
      </nav>

      {tab === "activity" && (
        <section className="tab-panel" id="activity">
          <div className="section-head">
            <h2>Request activity</h2>
            <button
              className="btn btn-quiet"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await activity();
                  await refresh();
                })
              }
            >
              <RotateCw aria-hidden size={16} />
              Refresh
            </button>
          </div>
          {logs === null ? (
            <div className="skeleton" style={{ height: 160 }} />
          ) : !logs.length ? (
            <div className="panel empty">
              <p>
                No requests yet. Send a request to <code>{endpoint}</code> with
                your sandbox key.
              </p>
            </div>
          ) : (
            <>
              <div className="reading">
                <span
                  className={
                    "reading-value " + (latest.status >= 400 ? "bad" : "ok")
                  }
                >
                  {latest.status}
                </span>
                <div>
                  <p className="measured">
                    {latest.method} {latest.path}
                  </p>
                  <p>{latest.detail}</p>
                  {latest.simulated_at && (
                    <p className="measured cool">{time(latest.simulated_at)}</p>
                  )}
                </div>
              </div>
              <div className="table-wrap">
                <table className="table ledger">
                  <thead>
                    <tr>
                      <th scope="col">Simulated time</th>
                      <th scope="col">Request</th>
                      <th scope="col">Status</th>
                      <th scope="col">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((l, i) => (
                      <tr key={i}>
                        <td className="measured cool">
                          {l.simulated_at ? time(l.simulated_at) : ""}
                        </td>
                        <td className="measured">
                          <span className="method">{l.method}</span> {l.path}
                        </td>
                        <td>
                          <span
                            className={
                              "chip measured " +
                              (l.status >= 400 ? "chip-bad" : "chip-ok")
                            }
                          >
                            {l.status}
                          </span>
                        </td>
                        <td>{l.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}
      {tab === "operations" && (
        <section className="tab-panel" id="operations">
          <div className="section-head">
            <h2>API operations</h2>
            <p className="muted">
              {box.approved
                ? "Approved behavior from your contract."
                : "Inferred from your contract. Approve above to activate."}
            </p>
          </div>
          {box.approved && box.contract.warnings.length > 0 && (
            <ul className="callout warnings">
              {box.contract.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <div className="table-wrap">
            <table className="table operations">
              <thead>
                <tr>
                  <th scope="col">Method</th>
                  <th scope="col">Path</th>
                  <th scope="col">Behavior</th>
                </tr>
              </thead>
              <tbody>
                {box.contract.operations.map((o) => (
                  <tr key={o.id}>
                    <td className="measured method">{o.method}</td>
                    <td className="measured">{o.path}</td>
                    <td>
                      {o.behavior}{" "}
                      {!box.approved && (
                        <span className="chip chip-accent">inferred</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {tab === "scenarios" && (
        <ScenarioEditor
          boxId={box.id}
          sid={sid}
          versionId={session?.version_id || ""}
          clock={session?.clock || ""}
          operationIds={box.contract.operations.map((o) => o.id)}
          onChange={async () => {
            setSessions(await api(`/sandboxes/${box.id}/sessions`));
            await activity();
          }}
        />
      )}
      {tab === "webhooks" && <WebhookPanel boxId={box.id} />}
    </div>
  );
}
export default function SandboxPage() {
  return (
    <Suspense fallback={<div className="page" aria-busy="true" />}>
      <Sandbox />
    </Suspense>
  );
}
