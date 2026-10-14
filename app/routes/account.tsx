import { useState, type SyntheticEvent } from "react";
import { redirect, useNavigate } from "react-router";
import { appContext } from "../context";
import { apiFetch } from "../lib/api";
import type { Route } from "./+types/account";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Account · ChatUI" }];
}

export function loader({ context }: Route.LoaderArgs) {
  const { auth } = context.get(appContext);
  if (!auth) throw redirect("/login?returnTo=%2Faccount");
  return { username: auth.username };
}

export default function Account() {
  const navigate = useNavigate();
  const [message, setMessage] = useState<string | null>(null);

  async function changePassword(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await apiFetch("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: form.get("current"), newPassword: form.get("next") }),
    });
    if (response.ok) {
      await navigate("/login", { replace: true });
      return;
    }
    const body = (await response.json()) as { error?: { message?: string } };
    setMessage(body.error?.message ?? "Could not change the password");
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <p className="auth-brand">ChatUI</p>
        <h1>Change password</h1>
        <p className="lede">You’ll be signed out everywhere.</p>
        <form onSubmit={(event) => void changePassword(event)}>
          <label htmlFor="current" className="visually-hidden">
            Current password
          </label>
          <input
            id="current"
            name="current"
            type="password"
            className="input"
            placeholder="Current password"
            autoComplete="current-password"
            required
          />
          <label htmlFor="next" className="visually-hidden">
            New password
          </label>
          <input
            id="next"
            name="next"
            type="password"
            className="input"
            placeholder="New password (10+ characters)"
            autoComplete="new-password"
            minLength={10}
            required
          />
          <button type="submit" className="btn lg primary block">
            Change password
          </button>
          {message ? (
            <p className="form-error" role="alert">
              {message}
            </p>
          ) : null}
        </form>
        <p className="auth-foot">
          <a href="/chat">Back to chats</a>
        </p>
      </div>
    </main>
  );
}
