import * as Dialog from "@radix-ui/react-dialog";
import { useState, type SyntheticEvent } from "react";
import { Link, useLocation, useNavigate, useRevalidator } from "react-router";
import type { SessionDto } from "@shared/auth";
import { authStore } from "../lib/auth-store";
import { paths } from "../lib/paths";

/**
 * In-app re-authentication: no document navigation. The same account gets
 * its tab-memory drafts back; another account starts clean (the shell state
 * is scoped to the account). "Sign-in page" leaves the shell, which discards
 * the draft.
 */
export default function ReauthDialog({
  expired,
}: {
  expired: { userId: string; username: string };
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const revalidator = useRevalidator();
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
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      });
      const body = (await response.json()) as SessionDto & { error?: { message?: string } };
      if (!response.ok || !body.user) {
        setError(body.error?.message ?? "Sign-in failed");
        return;
      }
      // Another account never sees the previous one's view or draft.
      if (body.user.id !== expired.userId) await navigate(paths.newChat(), { replace: true });
      authStore.applySession(body);
      await revalidator.revalidate();
    } catch {
      setError("Could not reach ChatUI.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content"
          data-testid="reauth-dialog"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
          }}
        >
          <Dialog.Title className="dialog-title">Sign in again</Dialog.Title>
          <Dialog.Description className="dialog-description">
            Your session has ended. Sign in to continue where you left off; your unsent message is
            kept in this tab.
          </Dialog.Description>
          <form className="auth-form" onSubmit={(event) => void submit(event)}>
            <label htmlFor="reauth-username">Username</label>
            <input
              id="reauth-username"
              name="username"
              autoComplete="username"
              defaultValue={expired.username}
              required
            />
            <label htmlFor="reauth-password">Password</label>
            <input
              id="reauth-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="dialog-actions">
              <Link
                to={paths.login(location.pathname)}
                className="secondary-link"
                data-testid="reauth-login-page"
              >
                Sign-in page
              </Link>
              <button type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
