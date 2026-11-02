"use client";
import { useEffect, useState } from "react";
import ScenarioEditor from "./scenario-editor";
import AccountSecurity from "./account-security";
import WorkspacePicker from "./workspace-picker";
import WebhookPanel from "./webhook-panel";
type Box = {
  id: string;
  name: string;
  approved: boolean;
  contract: {
    openapi: string;
    warnings: string[];
    operations: {
      id: string;
      method: string;
      path: string;
      behavior: string;
    }[];
  };
};
type Session = {
  id: string;
  name: string;
  scenario: string;
  generation: number;
  version_id: string;
  clock: string;
};
async function api(path: string, data?: unknown) {
  const r = await fetch("/api" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || "Request failed");
  return body;
}
export default function Home() {
  const [user, setUser] = useState<any>(null),
    [ready, setReady] = useState(false),
    [register, setRegister] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [boxes, setBoxes] = useState<Box[]>([]),
    [boxId, setBoxId] = useState(""),
    [sessions, setSessions] = useState<Session[]>([]),
    [sid, setSid] = useState(""),
    [logs, setLogs] = useState<any[]>([]),
    [resources, setResources] = useState<any[]>([]),
    [usage, setUsage] = useState<any>(null),
    [source, setSource] = useState(""),
    [showImport, setShowImport] = useState(false),
    [secret, setSecret] = useState({ id: "", key: "" });
  const key = secret.id === boxId ? secret.key : "";
  const setKey = (value: string) => setSecret({ id: boxId, key: value });
  const box = boxes.find((b) => b.id === boxId),
    session = sessions.find((s) => s.id === sid);
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
  async function refresh() {
    const [b, u] = await Promise.all([api("/sandboxes"), api("/usage")]);
    setBoxes(b);
    setUsage(u);
    setBoxId((id) => (b.some((x: Box) => x.id === id) ? id : b[0]?.id || ""));
  }
  async function activity() {
    if (!boxId || !sid) return;
    const [l, r] = await Promise.all([
      api(`/sandboxes/${boxId}/sessions/${sid}/logs`),
      api(`/sandboxes/${boxId}/sessions/${sid}/resources`),
    ]);
    setLogs(l);
    setResources(r);
  }
  useEffect(() => {
    api("/me")
      .then(async (u) => {
        setUser(u);
        await refresh();
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    setSessions([]);
    setSid("");
    if (boxId)
      api(`/sandboxes/${boxId}/sessions`)
        .then((s) => {
          setSessions(s);
          setSid(s[0]?.id || "");
        })
        .catch((e) => setError(e.message));
  }, [boxId]);
  useEffect(() => {
    setLogs([]);
    setResources([]);
    activity().catch((e) => setError(e.message));
  }, [boxId, sid]);
  if (!ready) return <main style={{ margin: 40 }}>Loading workspace…</main>;
  if (!user)
    return (
      <div className="login">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(async () => {
              await api("/auth/" + (register ? "register" : "login"), {
                email: data.get("email"),
                password: data.get("password"),
              });
              setUser(await api("/me"));
              await refresh();
            });
          }}
        >
          <div className="brand" style={{ color: "#183f30" }}>
            ✳ spectwin
          </div>
          <h1>{register ? "Create your workspace" : "Welcome back"}</h1>
          <p>Reproducible integration journeys start here.</p>
          <label>
            Email
            <input
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="email"
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              minLength={register ? 12 : 1}
              maxLength={128}
              autoComplete={register ? "new-password" : "current-password"}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button className="button primary" disabled={busy}>
            {register ? "Create account" : "Sign in"}
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register
              ? "Already have an account? Sign in"
              : "Create an account"}
          </button>
        </form>
      </div>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          ✳{" "}
          <span>
            spec<span className="brand-light">twin</span>
            <small>SIMULATION WORKSPACE</small>
          </span>
        </a>
        <div className="workspace">
          <div className="workspace-icon">S</div>
          <div>
            <strong>My workspace</strong>
            <small>{user.email}</small>
          </div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <a className="nav active" href="#overview">
          ▦ &nbsp; Overview
        </a>
        <a className="nav" href="#operations">
          ⌘ &nbsp; API operations
        </a>
        <a className="nav" href="#scenarios">
          ◈ &nbsp; Scenarios
        </a>
        <a className="nav" href="#webhooks">
          ↗ &nbsp; Webhooks
        </a>
        <a className="nav" href="#activity">
          ☷ &nbsp; Request activity
        </a>
        <div className="side-bottom">
          <strong>Build with confidence.</strong>
          <p>All state belongs to your organization and selected session.</p>
          <button
            className="button"
            onClick={() =>
              run(async () => {
                await api("/auth/logout", {});
                setUser(null);
                setBoxes([]);
                setKey("");
              })
            }
          >
            Sign out
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span className="breadcrumb">Workspace / Overview</span>
          <span className="local-badge">Foundation preview</span>
        </header>
        <div className="content">
          <WorkspacePicker currentId={user.organization_id} />
          <AccountSecurity
            onSignedOut={() => {
              setRegister(false);
              setUser(null);
            }}
          />
          <div className="heading">
            <div>
              <div className="eyebrow">YOUR SIMULATION WORKSPACE</div>
              <h1>
                Make integrations <em>feel real.</em>
              </h1>
              <p>
                Review your contract. Simulate behavior. Test with confidence.
              </p>
            </div>
            <button
              disabled={busy}
              className="button primary"
              onClick={() => setShowImport(true)}
            >
              ＋ New sandbox
            </button>
          </div>
          {error && (
            <div role="alert" className="notice">
              {error}
            </div>
          )}
          <div className="notice">
            <span className="notice-icon">✦</span>
            <div>
              <strong>Your API, ready for the unexpected</strong>
              <p>
                Import JSON or YAML. Review inferred behavior, then activate
                your sandbox.
              </p>
            </div>
            <button
              className="button light"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const response = await fetch("/payments.json");
                  setSource(await response.text());
                  setShowImport(true);
                })
              }
            >
              Explore example →
            </button>
          </div>
          <div className="section-head" id="overview">
            <div>
              <div className="eyebrow muted">YOUR ENVIRONMENT</div>
              <h2>Sandbox overview</h2>
              <p>
                Independent sessions. Persistent resources. Predictable results.
              </p>
            </div>
            <select
              aria-label="Sandbox"
              value={boxId}
              onChange={(e) => {
                setBoxId(e.target.value);
                setSid("");
              }}
            >
              {!boxes.length && <option>No sandboxes yet</option>}
              {boxes.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          {!box ? (
            <div className="empty">
              <div className="empty-icon">◇</div>
              <h3>Your first sandbox starts here</h3>
              <p>Import an API contract to get started.</p>
              <button
                className="button primary"
                onClick={() => setShowImport(true)}
              >
                Import contract
              </button>
            </div>
          ) : (
            <>
              <div className="metrics">
                <div className="metric">
                  <div className="metric-label">SANDBOX STATUS</div>
                  <div className="metric-value">
                    {box.approved ? "Ready" : "Review needed"}
                  </div>
                </div>
                <div className="metric">
                  <div className="metric-label">OPERATIONS</div>
                  <div className="metric-value">
                    {box.contract.operations.length}
                  </div>
                </div>
                <div className="metric">
                  <div className="metric-label">STORED RESOURCES</div>
                  <div className="metric-value">{resources.length}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">MONTHLY REQUESTS</div>
                  <div className="metric-value">
                    {usage?.requests} <small>/ {usage?.request_limit}</small>
                  </div>
                </div>
              </div>
              <div className="grid">
                <section className="panel">
                  <div className="eyebrow muted">READY TO CONNECT</div>
                  <h3>Your sandbox endpoint</h3>
                  <p>
                    Use a sandbox key as a Bearer token. Keys are shown once.
                  </p>
                  <div className="code-row">
                    <code>
                      {(process.env.NEXT_PUBLIC_RUNTIME_URL ||
                        "http://localhost:4000") +
                        "/sandbox/" +
                        box.id}
                    </code>
                  </div>
                  <div className="endpoint-foot">
                    <span>OpenAPI {box.contract.openapi}</span>
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          if (
                            confirm(
                              "Replace the sandbox key? Existing clients will need the new key.",
                            )
                          )
                            setKey(
                              (await api(`/sandboxes/${box.id}/key`, {}))
                                .apiKey,
                            );
                        })
                      }
                    >
                      Rotate key
                    </button>
                  </div>
                  {key && (
                    <div className="warnings">
                      <strong>Save this key securely:</strong>
                      <code style={{ overflowWrap: "anywhere" }}>{key}</code>
                      <button
                        className="text-button"
                        onClick={() => setKey("")}
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                </section>
                <section className="panel">
                  <div className="eyebrow muted">ISOLATED TEST ENVIRONMENT</div>
                  <h3>Session & scenario</h3>
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
                  </select>{" "}
                  <select
                    aria-label="Scenario"
                    disabled={!sid || busy}
                    value={session?.scenario || "success"}
                    onChange={(e) => {
                      const scenario = e.target.value;
                      run(async () => {
                        await api(
                          `/sandboxes/${box.id}/sessions/${sid}/scenario`,
                          { scenario },
                        );
                        setSessions(await api(`/sandboxes/${box.id}/sessions`));
                      });
                    }}
                  >
                    {["success", "error", "rate_limit", "delay"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <p style={{ marginTop: 15 }}>
                    Send <code>X-SpecTwin-Session: {session?.name}</code>
                  </p>
                  <div className="endpoint-foot">
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const name = prompt(
                            "Session name (lowercase letters, numbers, hyphens)",
                          );
                          if (name) {
                            const created = await api(
                              `/sandboxes/${box.id}/sessions`,
                              { name },
                            );
                            setSessions(
                              await api(`/sandboxes/${box.id}/sessions`),
                            );
                            setSid(created.id);
                          }
                        })
                      }
                    >
                      ＋ New session
                    </button>
                    <button
                      disabled={busy || !sid}
                      onClick={() =>
                        run(async () => {
                          if (
                            confirm(
                              "Delete resources and logs in this session?",
                            )
                          ) {
                            await api(
                              `/sandboxes/${box.id}/sessions/${sid}/reset`,
                              {},
                            );
                            setSessions(
                              await api(`/sandboxes/${box.id}/sessions`),
                            );
                            await activity();
                          }
                        })
                      }
                    >
                      ↺ Reset state
                    </button>
                  </div>
                </section>
              </div>
              <div className="warnings">
                <strong>Review inferred behavior</strong>
                <p>{box.contract.warnings.join(" ")}</p>
                {!box.approved && (
                  <button
                    disabled={busy}
                    className="button primary"
                    onClick={() =>
                      run(async () => {
                        await api(`/sandboxes/${box.id}/approve`, {});
                        await refresh();
                      })
                    }
                  >
                    Approve inferred CRUD mappings
                  </button>
                )}
              </div>
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
              <WebhookPanel boxId={box.id} />
              <div className="grid lower">
                <section className="panel" id="operations">
                  <div className="eyebrow muted">FROM YOUR CONTRACT</div>
                  <h3>API operations</h3>
                  {box.contract.operations.map((o) => (
                    <div className="operation" key={o.id}>
                      <span className={"method " + o.method.toLowerCase()}>
                        {o.method}
                      </span>
                      <code>{o.path}</code>
                      <span className="behavior">{o.behavior} · inferred</span>
                    </div>
                  ))}
                </section>
                <section className="panel" id="activity">
                  <div className="panel-heading">
                    <h3>Request activity</h3>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await activity();
                          await refresh();
                        })
                      }
                    >
                      ↻ Refresh
                    </button>
                  </div>
                  {!logs.length ? (
                    <div className="no-activity">
                      No requests yet. Send a request to your sandbox.
                    </div>
                  ) : (
                    logs.map((l, i) => (
                      <div className="activity" key={i}>
                        <div>
                          <strong>
                            {l.method} {l.path}
                          </strong>
                          <small>
                            {l.detail}
                            {l.simulated_at
                              ? ` · ${new Date(l.simulated_at).toISOString()}`
                              : ""}
                          </small>
                        </div>
                        <span
                          className={
                            "status-code " + (l.status >= 400 ? "bad" : "")
                          }
                        >
                          {l.status}
                        </span>
                      </div>
                    ))
                  )}
                </section>
              </div>
            </>
          )}
          <footer>
            <span>✳ Built for the moments before the backend is ready.</span>
            <span>SpecTwin · Foundation preview</span>
          </footer>
        </div>
      </main>
      {showImport && (
        <div className="modal-backdrop">
          <form
            className="import-modal"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const b = await api("/sandboxes", { source });
                await refresh();
                setBoxId(b.id);
                setShowImport(false);
                setSecret({ id: b.id, key: b.apiKey });
              });
            }}
          >
            <div className="modal-head">
              <h2>Import your API</h2>
              <button
                type="button"
                className="close"
                onClick={() => setShowImport(false)}
              >
                ×
              </button>
            </div>
            <p>OpenAPI 3.0 or 3.1, JSON or YAML. Maximum 1 MB.</p>
            <input
              aria-label="Specification file"
              type="file"
              accept=".json,.yaml,.yml"
              onChange={async (e) => {
                if (e.target.files?.[0])
                  setSource(await e.target.files[0].text());
              }}
            />
            <textarea
              aria-label="Specification source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              required
            />
            {error && <p role="alert">{error}</p>}
            <button disabled={busy} className="button primary">
              {busy ? "Importing…" : "Import contract →"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
