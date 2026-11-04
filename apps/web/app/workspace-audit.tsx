"use client";
import { useState } from "react";

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
  return (
    <details className="panel" id="workspace-audit">
      <summary>Workspace audit history</summary>
      <p>
        Committed membership, key, approval and scenario changes are retained
        for 90 days. Records identify affected resources; actor attribution is
        not available yet.
      </p>
      <button
        className="button light"
        disabled={busy}
        onClick={() => void load(false)}
      >
        Load audit history
      </button>
      {error && <p role="alert">{error}</p>}
      {events.map((event) => (
        <article className="activity" key={event.id}>
          <div>
            <strong>{event.action}</strong>
            <small>
              {new Date(event.created_at).toLocaleString()} ·{" "}
              {event.resource_id}
            </small>
            <code>{JSON.stringify(event.metadata)}</code>
          </div>
        </article>
      ))}
      {more && (
        <button
          className="button light"
          disabled={busy}
          onClick={() => void load(true)}
        >
          Load older audit events
        </button>
      )}
    </details>
  );
}
