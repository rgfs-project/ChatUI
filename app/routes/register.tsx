import { useState, type SyntheticEvent } from "react";
import { data, redirect, useNavigate } from "react-router";
import type { SessionDto } from "@shared/auth";
import { appContext } from "../context";
import { setSession } from "../lib/api";
import type { Route } from "./+types/register";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Create account · ChatUI" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { auth, services } = context.get(appContext);
  if (auth) throw redirect("/chat");
  await services.auth.refreshFirstRun();
  if (!services.auth.registrationOpen) throw data("Not found", { status: 404 });
  return null;
}

export default function Register() {
  const navigate = useNavigate();
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
    setSession(body);
    await navigate("/chat", { replace: true });
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <p className="auth-brand">ChatUI</p>
        <h1>Create an account</h1>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="username" className="visually-hidden">
            Username
          </label>
          <input
            id="username"
            name="username"
            className="input"
            placeholder="Username"
            aria-describedby="username-hint"
            autoComplete="username"
            required
          />
          <p className="hint field-hint" id="username-hint">
            3–32 characters: a–z, 0–9, _ . -
          </p>
          <label htmlFor="password" className="visually-hidden">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            className="input"
            placeholder="Password (10+ characters)"
            autoComplete="new-password"
            minLength={10}
            required
          />
          <button type="submit" className="btn lg primary block">
            Create account
          </button>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
        <p className="auth-foot">
          Have an account? <a href="/login">Sign in</a>
        </p>
      </div>
    </main>
  );
}
