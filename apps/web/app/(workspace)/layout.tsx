"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { LogOut, Menu, Plus, Settings, X } from "lucide-react";
import WorkspacePicker from "../workspace-picker";
import { api, type Box } from "../lib/api";
import { WorkspaceContext } from "./workspace-context";

export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter(),
    pathname = usePathname();
  const [user, setUser] = useState<any>(null),
    [boxes, setBoxes] = useState<Box[] | null>(null),
    [usage, setUsage] = useState<any>(null),
    [secret, setSecret] = useState({ id: "", key: "" }),
    [menu, setMenu] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const [b, u] = await Promise.all([api("/sandboxes"), api("/usage")]);
    setBoxes(b);
    setUsage(u);
    return b as Box[];
  }, []);
  const signedOut = useCallback(() => {
    setUser(null);
    setSecret({ id: "", key: "" });
    router.replace("/");
  }, [router]);
  useEffect(() => {
    api("/me")
      .then((u) => {
        setUser(u);
        return refresh().catch((e) => {
          setError(e.message);
          setBoxes([]);
        });
      })
      .catch(() => router.replace("/"));
  }, [refresh, router]);
  useEffect(() => setMenu(false), [pathname]);
  if (!user || !boxes)
    return (
      <div className="app" aria-busy="true">
        <aside className="sidebar">
          <span className="wordmark">SpecTwin</span>
          <div className="skeleton" style={{ height: 36 }} />
          <div className="skeleton" style={{ height: 120 }} />
        </aside>
        <main className="main">
          <div className="page">
            <p className="muted">Loading workspace…</p>
            <div className="skeleton" style={{ height: 240 }} />
          </div>
        </main>
      </div>
    );
  const current = (href: string) =>
    pathname === href || pathname.startsWith(href + "/") ? "page" : undefined;
  return (
    <WorkspaceContext.Provider
      value={{ user, boxes, usage, refresh, secret, setSecret, signedOut }}
    >
      <div className="app">
        <header className="topbar">
          <Link className="wordmark" href="/sandboxes">
            SpecTwin
          </Link>
          <button
            className="btn btn-quiet"
            aria-expanded={menu}
            aria-controls="sidebar"
            onClick={() => setMenu(!menu)}
          >
            {menu ? (
              <X aria-hidden size={18} />
            ) : (
              <Menu aria-hidden size={18} />
            )}
            Menu
          </button>
        </header>
        <aside className="sidebar" id="sidebar" data-open={menu}>
          <Link className="wordmark" href="/sandboxes">
            SpecTwin
          </Link>
          <WorkspacePicker currentId={user.organization_id} />
          <nav className="side-nav" aria-label="Sandboxes">
            <Link
              className="side-heading"
              href="/sandboxes"
              aria-current={pathname === "/sandboxes" ? "page" : undefined}
            >
              Sandboxes
            </Link>
            {boxes.map((b) => (
              <Link
                key={b.id}
                className="side-link"
                href={`/sandboxes/${b.id}`}
                aria-current={current(`/sandboxes/${b.id}`)}
              >
                <span className="side-name">{b.name}</span>
                {!b.approved && (
                  <span className="chip chip-accent">Review</span>
                )}
              </Link>
            ))}
            <Link
              className="side-link side-new"
              href="/sandboxes/new"
              aria-current={current("/sandboxes/new")}
            >
              <Plus aria-hidden size={16} />
              New sandbox
            </Link>
          </nav>
          <div className="side-foot">
            <Link
              className="side-link"
              href="/settings"
              aria-current={current("/settings")}
            >
              <Settings aria-hidden size={16} />
              Settings
            </Link>
            <p className="side-user" title={user.email}>
              {user.email}
            </p>
            <button
              className="btn btn-quiet"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("/auth/logout", {});
                  signedOut();
                } catch (e: any) {
                  setError(e.message);
                  setBusy(false);
                }
              }}
            >
              <LogOut aria-hidden size={16} />
              Sign out
            </button>
          </div>
        </aside>
        <main className="main">
          {error && (
            <div role="alert" className="callout callout-bad page-alert">
              {error}
            </div>
          )}
          {children}
        </main>
      </div>
    </WorkspaceContext.Provider>
  );
}
