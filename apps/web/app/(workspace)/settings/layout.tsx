"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWorkspace } from "../workspace-context";

const sections = [
  ["/settings/security", "Account security", false],
  ["/settings/invitations", "Invitations", false],
  ["/settings/members", "Members", true],
  ["/settings/audit", "Audit history", true],
  ["/settings/keys", "Platform keys", true],
] as const;
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const owner = useWorkspace().user.role === "owner";
  return (
    <div className="page">
      <header className="page-head">
        <h1>Settings</h1>
      </header>
      <div className="settings">
        <nav className="sub-nav" aria-label="Settings">
          {sections
            .filter(([, , ownerOnly]) => owner || !ownerOnly)
            .map(([href, label]) => (
              <Link
                key={href}
                href={href}
                aria-current={pathname === href ? "page" : undefined}
              >
                {label}
              </Link>
            ))}
        </nav>
        <div className="settings-body">{children}</div>
      </div>
    </div>
  );
}
