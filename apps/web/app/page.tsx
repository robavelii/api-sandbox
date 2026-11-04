"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PasswordRecovery from "./password-recovery";
import { api } from "./lib/api";

export default function SignIn() {
  const router = useRouter();
  const [ready, setReady] = useState(false),
    [register, setRegister] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/me")
      .then(() => router.replace("/sandboxes"))
      .catch(() => setReady(true));
  }, [router]);
  if (!ready)
    return (
      <main className="auth" aria-busy="true">
        <p className="muted">Loading workspace…</p>
      </main>
    );
  return (
    <main className="auth">
      <div className="auth-column">
        <span className="wordmark">SpecTwin</span>
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            api("/auth/" + (register ? "register" : "login"), {
              email: data.get("email"),
              password: data.get("password"),
            })
              .then(() => router.push("/sandboxes"))
              .catch((e) => {
                setError(e.message);
                setBusy(false);
              });
          }}
        >
          <div>
            <h1>{register ? "Create your workspace" : "Sign in"}</h1>
            <p className="lead">
              Stateful API sandboxes for reproducible integration tests.
            </p>
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="email"
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={register ? 12 : 1}
              maxLength={128}
              autoComplete={register ? "new-password" : "current-password"}
            />
            {register && <p className="hint">At least 12 characters.</p>}
          </div>
          {error && (
            <p role="alert" className="callout callout-bad">
              {error}
            </p>
          )}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {register ? "Create account" : "Sign in"}
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register
              ? "Already have an account? Sign in"
              : "Create an account"}
          </button>
        </form>
        <PasswordRecovery />
      </div>
    </main>
  );
}
