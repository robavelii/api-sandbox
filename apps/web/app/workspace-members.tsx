"use client";
import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import ConfirmAction from "./confirm-action";
type Member = { id: string; email: string; role: "owner" | "member" };
export default function WorkspaceMembers({
  currentUserId,
}: {
  currentUserId: string;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function request(path: string, body?: unknown) {
    const response = await fetch(`/api/workspaces/members${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Member request failed.");
    return result;
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Member request failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(async () => setMembers(await request("")));
  }, []);
  return (
    <section className="settings-section" id="workspace-members">
      <div className="section-head">
        <h2>Members</h2>
        <button
          className="btn btn-quiet"
          disabled={busy}
          onClick={() => void run(async () => setMembers(await request("")))}
        >
          <RotateCw aria-hidden size={16} />
          Refresh
        </button>
      </div>
      <p className="muted">
        Owners can manage roles and access. A workspace must keep at least one
        owner.
      </p>
      {error && (
        <p role="alert" className="callout callout-bad">
          {error}
        </p>
      )}
      {members.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td>
                    {member.email}
                    {member.id === currentUserId && (
                      <span className="muted"> (you)</span>
                    )}
                  </td>
                  <td>
                    <select
                      aria-label={`Role for ${member.email}`}
                      value={member.role}
                      disabled={busy}
                      onChange={(event) => {
                        const role = event.target.value;
                        void run(async () => {
                          await request(`/${member.id}/role`, { role });
                          if (member.id === currentUserId)
                            window.location.reload();
                          else setMembers(await request(""));
                        });
                      }}
                    >
                      <option value="owner">Owner</option>
                      <option value="member">Member</option>
                    </select>
                  </td>
                  <td className="cell-action">
                    <ConfirmAction
                      className="btn btn-quiet"
                      label="Remove"
                      ariaLabel={`Remove ${member.email}`}
                      title={`Remove ${member.email}?`}
                      body="They lose access to every sandbox in this workspace."
                      confirmLabel="Remove member"
                      danger
                      disabled={busy}
                      onConfirm={() =>
                        void run(async () => {
                          await request(`/${member.id}/remove`, {});
                          if (member.id === currentUserId)
                            window.location.reload();
                          else setMembers(await request(""));
                        })
                      }
                    />
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
