"use client";
import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import ConfirmAction from "./confirm-action";

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
    <section className="tab-panel" id="webhooks">
      <div className="section-head">
        <h2>Webhook delivery</h2>
        <button
          className="btn btn-quiet"
          disabled={busy}
          onClick={() => run(refresh)}
        >
          <RotateCw aria-hidden size={16} />
          Reload webhooks
        </button>
      </div>
      <p className="muted">
        HTTPS endpoints are resolved to public addresses before every
        connection. Event IDs stay stable across retries, so receivers can
        deduplicate delivery.
      </p>
      <form
        className="panel form-panel form-row"
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
        <div className="field">
          <label htmlFor="webhook-url">Endpoint URL</label>
          <input
            id="webhook-url"
            name="url"
            type="url"
            placeholder="https://example.com/webhooks"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="webhook-description">Description</label>
          <input
            id="webhook-description"
            name="description"
            maxLength={200}
            placeholder="Checkout test receiver"
          />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          Add endpoint
        </button>
      </form>
      {secret && (
        <div className="callout callout-accent secret">
          <div>
            <strong>Save this signing secret now:</strong>{" "}
            <code className="secret-value">{secret}</code>
          </div>
          <button className="btn btn-quiet" onClick={() => setSecret("")}>
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <p className="callout callout-bad" role="alert">
          {error}
        </p>
      )}
      {endpoints.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Endpoints</caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Endpoint</th>
                <th scope="col">Description</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((endpoint) => (
                <tr key={endpoint.id}>
                  <td>
                    {endpoint.active ? (
                      <span className="chip chip-ok">Active</span>
                    ) : (
                      <span className="chip">Disabled</span>
                    )}
                  </td>
                  <td className="measured">{endpoint.url}</td>
                  <td>{endpoint.description}</td>
                  <td className="cell-action">
                    {endpoint.active && (
                      <ConfirmAction
                        className="btn btn-quiet"
                        label="Disable"
                        title="Disable this webhook endpoint?"
                        body={`${endpoint.url} stops receiving events from this sandbox.`}
                        confirmLabel="Disable endpoint"
                        danger
                        disabled={busy}
                        onConfirm={() =>
                          run(async () => {
                            await api(
                              `/sandboxes/${boxId}/webhooks/${endpoint.id}/disable`,
                              {},
                            );
                            await refresh();
                          })
                        }
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Recent deliveries</h3>
      {!deliveries.length ? (
        <p className="panel empty">No webhook deliveries yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Status</th>
                <th scope="col">Endpoint</th>
                <th scope="col" className="num">
                  Attempts
                </th>
                <th scope="col">Response</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td className="measured">{delivery.type}</td>
                  <td>
                    <span
                      className={
                        "chip " +
                        (delivery.status === "delivered"
                          ? "chip-ok"
                          : delivery.status === "failed"
                            ? "chip-bad"
                            : "")
                      }
                    >
                      {delivery.status}
                    </span>
                  </td>
                  <td className="measured">{delivery.url}</td>
                  <td className="num measured">{delivery.attempts}</td>
                  <td>
                    {delivery.response_status && (
                      <span className="measured">
                        HTTP {delivery.response_status}{" "}
                      </span>
                    )}
                    {delivery.last_error}
                  </td>
                  <td className="cell-action">
                    <button
                      className="btn btn-quiet"
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
