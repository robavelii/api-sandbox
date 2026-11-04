"use client";
import WorkspaceAudit from "../../../workspace-audit";
import OwnersOnly from "../owners-only";
export default function Audit() {
  return (
    <OwnersOnly>
      <WorkspaceAudit />
    </OwnersOnly>
  );
}
