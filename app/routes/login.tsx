import { useState, type SyntheticEvent } from "react";
import { redirect, useNavigate, useSearchParams } from "react-router";
import type { SessionDto } from "@shared/auth";
import { appContext } from "../context";
import { safeReturnTo, setSession } from "../lib/api";
import type { Route } from "./+types/login";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Sign in · ChatUI" }];
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const { auth, services } = context.get(appContext);
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
  if (auth) throw redirect(returnTo);
  await services.auth.refreshFirstRun();
  return { registrationOpen: services.auth.registrationOpen };
}

export default function Login({ loaderData }: Route.ComponentProps) {
  const navigate = useNavigate();
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
      setSession(body);
      await navigate(safeReturnTo(params.get("returnTo")), { replace: true });
    } catch {
      setError("Could not reach ChatUI.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <h1>Sign in</h1>
      <form className="auth-form" method="post" onSubmit={(event) => void submit(event)}>
        <label htmlFor="username">Username</label>
        <input id="username" name="username" autoComplete="username" required />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <button type="submit" disabled={busy}>
          Sign in
        </button>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
      {loaderData.registrationOpen ? (
        <p>
          New here? <a href="/register">Create an account</a>
        </p>
      ) : null}
    </main>
  );
}
