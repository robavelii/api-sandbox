"use client";
import { useEffect, useState } from "react";

type Workspace = { id: string; name: string; role: string };
export default function WorkspacePicker({ currentId }: { currentId: string }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/workspaces")
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "Unable to load workspaces.");
        if (active) setWorkspaces(result);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <div>
      <label>
        Workspace{" "}
        <select
          aria-label="Active workspace"
          value={currentId}
          disabled={busy}
          onChange={async (event) => {
            setBusy(true);
            setError("");
            try {
              const response = await fetch("/api/workspaces/select", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ workspaceId: event.target.value }),
              });
              if (!response.ok)
                throw new Error(
                  (await response.json()).error ||
                    "Unable to switch workspace.",
                );
              window.location.reload();
            } catch (error) {
              setError(
                error instanceof Error
                  ? error.message
                  : "Unable to switch workspace.",
              );
              setBusy(false);
            }
          }}
        >
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name} · {workspace.role}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
