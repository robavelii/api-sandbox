"use client";
import Link from "next/link";
import { Plus } from "lucide-react";
import { useWorkspace } from "../workspace-context";

export default function Sandboxes() {
  const { boxes, usage } = useWorkspace();
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Sandboxes</h1>
          <p className="lead">
            Stateful API sandboxes for reproducible integration tests.
          </p>
        </div>
        {boxes.length > 0 && (
          <div className="actions">
            <Link className="btn" href="/sandboxes/new?example=payments">
              Explore example
            </Link>
            <Link className="btn btn-primary" href="/sandboxes/new">
              <Plus aria-hidden size={16} />
              New sandbox
            </Link>
          </div>
        )}
      </header>
      {!boxes.length ? (
        <section className="panel empty">
          <h2>No sandboxes yet</h2>
          <p>
            Import an OpenAPI 3.0 or 3.1 contract. SpecTwin infers the CRUD
            behavior of each operation, and you approve it before the sandbox
            answers requests.
          </p>
          <div className="actions">
            <Link className="btn btn-primary" href="/sandboxes/new">
              Import contract
            </Link>
            <Link className="btn" href="/sandboxes/new?example=payments">
              Explore example
            </Link>
          </div>
        </section>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Operations
                </th>
                <th scope="col">OpenAPI</th>
              </tr>
            </thead>
            <tbody>
              {boxes.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link className="row-link" href={`/sandboxes/${b.id}`}>
                      {b.name}
                    </Link>
                  </td>
                  <td>
                    {b.approved ? (
                      <span className="chip chip-ok">Ready</span>
                    ) : (
                      <span className="chip chip-accent">Review needed</span>
                    )}
                  </td>
                  <td className="num measured">
                    {b.contract.operations.length}
                  </td>
                  <td className="measured">{b.contract.openapi}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {usage && (
        <p className="muted foot-note">
          Requests this month:{" "}
          <span className="measured">
            {usage.requests} of {usage.request_limit}
          </span>
        </p>
      )}
    </div>
  );
}
