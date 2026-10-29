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
    <main className="page">
      <h1>Create account</h1>
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="username">Username (3-32: a-z 0-9 _ . -)</label>
        <input id="username" name="username" autoComplete="username" required />
        <label htmlFor="password">Password (at least 10 characters)</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
        />
        <button type="submit">Create account</button>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </main>
  );
}
