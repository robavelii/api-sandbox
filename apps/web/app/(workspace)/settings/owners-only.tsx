"use client";
import { useWorkspace } from "../workspace-context";
export default function OwnersOnly({
  children,
}: {
  children: React.ReactNode;
}) {
  if (useWorkspace().user.role === "owner") return children;
  return (
    <section className="panel empty">
      <h2>Owners only</h2>
      <p>Ask a workspace owner to change this setting.</p>
    </section>
  );
}
