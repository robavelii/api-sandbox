"use client";
import { useEffect, useState } from "react";

type Endpoint = {
  id: string;
  url: string;
  description: string;
  active: boolean;
};
type Delivery = {
  id: string;
  status: string;
  attempts: number;
  response_status?: number;
  last_error?: string;
  type: string;
  url: string;
};
async function api(path: string, data?: unknown) {
  const response = await fetch("/api" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

export default function WebhookPanel({ boxId }: { boxId: string }) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]),
    [deliveries, setDeliveries] = useState<Delivery[]>([]),
    [secret, setSecret] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function refresh() {
    const [configured, attempts] = await Promise.all([
      api(`/sandboxes/${boxId}/webhooks`),
      api(`/sandboxes/${boxId}/webhook-deliveries`),
    ]);
    setEndpoints(configured);
    setDeliveries(attempts);
  }
  useEffect(() => {
    setSecret("");
    setError("");
    refresh().catch((cause) => setError(cause.message));
  }, [boxId]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause: any) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel webhook-panel" id="webhooks">
      <div className="panel-heading">
        <div>
          <div className="eyebrow muted">OUTGOING EVENTS</div>
          <h3>Webhook delivery</h3>
        </div>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => run(refresh)}
        >
          ↻ Reload webhooks
        </button>
      </div>
      <p>
        HTTPS endpoints are resolved to public addresses before every
        connection. Event IDs stay stable across retries, so receivers can
        deduplicate delivery.
      </p>
      <form
        className="scenario-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          run(async () => {
            const created = await api(`/sandboxes/${boxId}/webhooks`, {
              url: data.get("url"),
              description: data.get("description"),
            });
            setSecret(created.signingSecret);
            form.reset();
            await refresh();
          });
        }}
      >
        <input
          name="url"
          type="url"
          placeholder="https://example.com/webhooks"
          required
        />
        <input
          name="description"
          maxLength={200}
          placeholder="Checkout test receiver"
        />
        <button className="button primary" disabled={busy}>
          Add endpoint
        </button>
      </form>
      {secret && (
        <div className="warnings">
          <strong>Save this signing secret now:</strong> <code>{secret}</code>
          <button className="text-button" onClick={() => setSecret("")}>
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <p className="editor-error" role="alert">
          {error}
        </p>
      )}
      {endpoints.map((endpoint) => (
        <div className="operation" key={endpoint.id}>
          <span className={`pill ${endpoint.active ? "green" : ""}`}>
            {endpoint.active ? "ACTIVE" : "DISABLED"}
          </span>
          <div>
            <code>{endpoint.url}</code>
            <small>{endpoint.description}</small>
          </div>
          {endpoint.active && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (confirm("Disable this webhook endpoint?")) {
                    await api(
                      `/sandboxes/${boxId}/webhooks/${endpoint.id}/disable`,
                      {},
                    );
                    await refresh();
                  }
                })
              }
            >
              Disable
            </button>
          )}
        </div>
      ))}
      <h3>Recent deliveries</h3>
      {!deliveries.length && (
        <div className="no-activity">No webhook deliveries yet.</div>
      )}
      {deliveries.map((delivery) => (
        <div className="activity" key={delivery.id}>
          <div>
            <strong>
              {delivery.type} · {delivery.status}
            </strong>
            <small>
              {delivery.url} · {delivery.attempts} attempt(s)
              {delivery.response_status
                ? ` · HTTP ${delivery.response_status}`
                : ""}
              {delivery.last_error ? ` · ${delivery.last_error}` : ""}
            </small>
          </div>
          <button
            className="text-button"
            disabled={busy || delivery.status === "delivering"}
            onClick={() =>
              run(async () => {
                await api(
                  `/sandboxes/${boxId}/webhook-deliveries/${delivery.id}/replay`,
                  {},
                );
                await refresh();
              })
            }
          >
            Replay
          </button>
        </div>
      ))}
    </section>
  );
}
