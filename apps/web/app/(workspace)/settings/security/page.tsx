"use client";
import AccountSecurity from "../../../account-security";
import { useWorkspace } from "../../workspace-context";
export default function Security() {
  return <AccountSecurity onSignedOut={useWorkspace().signedOut} />;
}
