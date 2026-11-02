"use client";
import { useState } from "react";
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
  return (
    <details className="panel" id="workspace-members">
      <summary>Workspace members</summary>
      <p>
        Owners can manage roles and access. A workspace must keep at least one
        owner.
      </p>
      <button
        className="button light"
        disabled={busy}
        onClick={() => void run(async () => setMembers(await request("")))}
      >
        Load members
      </button>
      {error && <p role="alert">{error}</p>}
      {members.map((member) => (
        <div className="scenario-toolbar" key={member.id}>
          <span>{member.email}</span>
          <select
            aria-label={`Role for ${member.email}`}
            value={member.role}
            disabled={busy}
            onChange={(event) => {
              const role = event.target.value;
              void run(async () => {
                await request(`/${member.id}/role`, { role });
                if (member.id === currentUserId) window.location.reload();
                else setMembers(await request(""));
              });
            }}
          >
            <option value="owner">Owner</option>
            <option value="member">Member</option>
          </select>
          <button
            className="button light"
            disabled={busy}
            onClick={() => {
              if (confirm(`Remove ${member.email} from this workspace?`))
                void run(async () => {
                  await request(`/${member.id}/remove`, {});
                  if (member.id === currentUserId) window.location.reload();
                  else setMembers(await request(""));
                });
            }}
          >
            Remove {member.email}
          </button>
        </div>
      ))}
    </details>
  );
}
