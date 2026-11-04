"use client";
import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";

type AuditEvent = {
  id: string;
  action: string;
  resource_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export default function WorkspaceAudit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  async function load(older: boolean) {
    setBusy(true);
    setError("");
    try {
      const cursor = older ? events.at(-1)?.id : undefined;
      const response = await fetch(
        `/api/workspaces/audit${cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`,
      );
      const rows = await response.json();
      if (!response.ok)
        throw new Error(rows.error || "Unable to load audit history.");
      setEvents((previous) => (older ? [...previous, ...rows] : rows));
      setMore(rows.length === 100);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to load audit history.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load(false);
  }, []);
  return (
    <section className="settings-section" id="workspace-audit">
      <div className="section-head">
        <h2>Audit history</h2>
        <button
          className="btn btn-quiet"
          disabled={busy}
          onClick={() => void load(false)}
        >
          <RotateCw aria-hidden size={16} />
          Refresh
        </button>
      </div>
      <p className="muted">
        Committed membership, key, approval and scenario changes are retained
        for 90 days. Records identify affected resources; actor attribution is
        not available yet.
      </p>
      {error && (
        <p role="alert" className="callout callout-bad">
          {error}
        </p>
      )}
      {events.length > 0 ? (
        <ol className="trail">
          {events.map((event) => (
            <li key={event.id}>
              <p className="trail-action measured">{event.action}</p>
              <p className="trail-meta">
                <span className="measured cool">
                  {new Date(event.created_at).toLocaleString()}
                </span>
                <span className="measured muted">{event.resource_id}</span>
              </p>
              <code className="trail-data">
                {JSON.stringify(event.metadata)}
              </code>
            </li>
          ))}
        </ol>
      ) : (
        !busy && <p className="panel empty">No audit events yet.</p>
      )}
      {more && (
        <button className="btn" disabled={busy} onClick={() => void load(true)}>
          Load older audit events
        </button>
      )}
    </section>
  );
}
