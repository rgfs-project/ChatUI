import { useState, type SyntheticEvent } from "react";
import { data, redirect, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { SessionDto } from "@shared/auth";
import { appContext } from "../context";
import { applySession } from "../lib/session";
import { paths } from "../lib/paths";
import type { Route } from "./+types/register";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Create account · ChatUI" }];
}

export function loader({ context }: Route.LoaderArgs) {
  const { auth, services } = context.get(appContext);
  if (auth) throw redirect(paths.newChat());
  if (!services.auth.registrationOpen) throw data("Not found", { status: 404 });
  return null;
}

export default function Register() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
    });
    const body = (await response.json()) as SessionDto & { error?: { message?: string } };
    if (!response.ok) {
      setError(body.error?.message ?? "Registration failed");
      return;
    }
    applySession(client, body);
    await navigate(paths.newChat(), { replace: true });
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <p className="auth-brand">ChatUI</p>
        <h1>Create your account</h1>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="username">Username</label>
          <input
            id="username"
            name="username"
            className="text-field"
            autoComplete="username"
            autoCapitalize="none"
            aria-describedby="username-hint"
            required
          />
          <span id="username-hint" className="field-hint">
            3–32 characters: a–z, 0–9, _ . -
          </span>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            className="text-field"
            autoComplete="new-password"
            aria-describedby="password-hint"
            minLength={10}
            required
          />
          <span id="password-hint" className="field-hint">
            At least 10 characters
          </span>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="pill-button pill-primary auth-submit">
            Create account
          </button>
        </form>
        <p className="auth-note">
          Already have an account? <a href={paths.login()}>Sign in</a>
        </p>
      </div>
    </main>
  );
}
