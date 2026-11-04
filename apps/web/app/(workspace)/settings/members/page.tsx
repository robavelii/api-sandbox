"use client";
import WorkspaceMembers from "../../../workspace-members";
import { useWorkspace } from "../../workspace-context";
import OwnersOnly from "../owners-only";
export default function Members() {
  const { user } = useWorkspace();
  return (
    <OwnersOnly>
      <WorkspaceMembers currentUserId={user.id} />
    </OwnersOnly>
  );
}
