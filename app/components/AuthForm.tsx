import { useState, type SyntheticEvent } from "react";
import { useNavigate } from "react-router";
import type { SessionDto } from "@shared/auth";
import { safeReturnTo } from "../lib/api";
import { sessionStore } from "../lib/session";

/** Sign-in and sign-up share one form: username, password with Show, one main action. */
export function AuthForm(props: {
  mode: "login" | "register";
  returnTo: string | null;
  footer?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const login = props.mode === "login";

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(login ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      });
      const body = (await response.json()) as SessionDto & { error?: { message?: string } };
      if (!response.ok) {
        setError(
          body.error?.message ?? (login ? "Sign-in failed." : "Couldn’t create the account."),
        );
        return;
      }
      sessionStore.set(body);
      await navigate(login ? safeReturnTo(props.returnTo) : "/chat/new", { replace: true });
    } catch {
      setError("Couldn’t reach ChatUI.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <header className="auth-header">
        <span className="brand">ChatUI</span>
      </header>
      <main className="auth-main">
        <form className="auth-form" method="post" onSubmit={(e) => void submit(e)}>
          <div className="auth-title">
            <h1>{login ? "Welcome back" : "Create your account"}</h1>
            <p className="muted">
              {login ? "Sign in to continue to ChatUI." : "Choose a username and a password."}
            </p>
          </div>
          <div className="auth-fields">
            <div className="field">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                name="username"
                placeholder="Enter your username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <div className="password">
                <input
                  id="password"
                  name="password"
                  type={shown ? "text" : "password"}
                  placeholder="Enter your password"
                  autoComplete={login ? "current-password" : "new-password"}
                  required
                />
                <button
                  type="button"
                  className="reveal"
                  aria-pressed={shown}
                  onClick={() => {
                    setShown(!shown);
                  }}
                >
                  {shown ? "Hide" : "Show"}
                  <span className="sr-only"> password</span>
                </button>
              </div>
            </div>
          </div>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="button primary large" disabled={busy}>
            {login ? "Sign in" : "Create account"}
          </button>
          {props.footer}
        </form>
      </main>
    </div>
  );
}
