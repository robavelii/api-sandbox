"use client";
import WorkspaceInvitations from "../../../workspace-invitations";
import { useWorkspace } from "../../workspace-context";
export default function Invitations() {
  return <WorkspaceInvitations owner={useWorkspace().user.role === "owner"} />;
}
