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

export default function Account({ loaderData }: Route.ComponentProps) {
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
    <main className="page">
      <h1>Account</h1>
      <p>
        Signed in as <strong>{loaderData.username}</strong>. <a href="/chat">Back to chats</a>
      </p>
      <h2>Change password</h2>
      <form className="auth-form" onSubmit={(event) => void changePassword(event)}>
        <label htmlFor="current">Current password</label>
        <input
          id="current"
          name="current"
          type="password"
          autoComplete="current-password"
          required
        />
        <label htmlFor="next">New password (at least 10 characters)</label>
        <input
          id="next"
          name="next"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
        />
        <button type="submit">Change password and sign out everywhere</button>
        {message ? (
          <p className="error" role="alert">
            {message}
          </p>
        ) : null}
      </form>
    </main>
  );
}
