import { useState, type SyntheticEvent } from "react";
import { redirect, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { SessionDto } from "@shared/auth";
import { appContext } from "../context";
import { applySession } from "../lib/session";
import { safeReturnTo } from "../lib/api";
import { paths } from "../lib/paths";
import type { Route } from "./+types/login";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Sign in · ChatUI" }];
}

export function loader({ context, request }: Route.LoaderArgs) {
  const { auth, services } = context.get(appContext);
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
  if (auth) throw redirect(returnTo);
  return { registrationOpen: services.auth.registrationOpen };
}

export default function Login({ loaderData }: Route.ComponentProps) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      });
      const body = (await response.json()) as SessionDto & { error?: { message?: string } };
      if (!response.ok) {
        setError(body.error?.message ?? "Sign-in failed");
        return;
      }
      applySession(client, body);
      await navigate(safeReturnTo(params.get("returnTo")), { replace: true });
    } catch {
      setError("Could not reach ChatUI.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <p className="auth-brand">ChatUI</p>
        <h1>Welcome back</h1>
        <form className="auth-form" method="post" onSubmit={(event) => void submit(event)}>
          <label htmlFor="username">Username</label>
          <input
            id="username"
            name="username"
            className="text-field"
            autoComplete="username"
            autoCapitalize="none"
            required
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            className="text-field"
            autoComplete="current-password"
            required
          />
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="pill-button pill-primary auth-submit" disabled={busy}>
            Sign in
          </button>
        </form>
        {loaderData.registrationOpen ? (
          <p className="auth-note">
            Don&apos;t have an account? <a href={paths.register()}>Sign up</a>
          </p>
        ) : (
          <p className="auth-note">Don&apos;t have an account? Ask an admin to create one.</p>
        )}
      </div>
    </main>
  );
}
