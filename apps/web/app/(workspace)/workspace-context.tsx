"use client";
import { createContext, useContext } from "react";
import type { Box } from "../lib/api";

export type Workspace = {
  user: any;
  boxes: Box[];
  usage: any;
  refresh: () => Promise<Box[]>;
  secret: { id: string; key: string };
  setSecret: (secret: { id: string; key: string }) => void;
  signedOut: () => void;
};
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("useWorkspace outside the workspace shell");
  return workspace;
}
