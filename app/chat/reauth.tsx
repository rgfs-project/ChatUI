import * as RadixDialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type SyntheticEvent } from "react";
import { useNavigate } from "react-router";
import type { SessionDto } from "@shared/auth";
import { paths } from "../lib/paths";
import { applySession, purgeUserCache } from "../lib/session";
import { draftStore } from "./drafts";

/**
 * Session expired mid-use (contracts §12): an in-app dialog, no document
 * navigation. Drafts stay in tab memory, keyed by user, and come back only if
 * the same user signs in here; choosing another account discards them.
 */
export function ReauthDialog({
  user,
  onRestored,
}: {
  user: { id: string; username: string };
  onRestored: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get("password");
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username: user.username, password }),
      });
      const body = (await response.json()) as SessionDto & { error?: { message?: string } };
      if (!response.ok) {
        setError(body.error?.message ?? "Sign-in failed");
        return;
      }
      if (body.user?.id !== user.id) {
        // Not the account whose draft is held: nothing of it may carry over.
        draftStore.clearAll();
        purgeUserCache(client);
        applySession(client, body);
        await navigate(paths.newChat(), { replace: true });
        return;
      }
      applySession(client, body);
      onRestored();
    } catch {
      setError("Could not reach ChatUI.");
    } finally {
      setBusy(false);
    }
  }

  async function otherAccount() {
    draftStore.clearAll();
    purgeUserCache(client);
    applySession(client, { user: null, csrfToken: null, registrationOpen: false });
    await navigate(paths.login(), { replace: true });
  }

  return (
    <RadixDialog.Root open>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-backdrop" />
        <RadixDialog.Content
          className="dialog reauth-dialog"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
          }}
          onInteractOutside={(event) => {
            event.preventDefault();
          }}
        >
          <RadixDialog.Title className="dialog-title">Session expired</RadixDialog.Title>
          <RadixDialog.Description className="dialog-body">
            Sign in again as <strong>{user.username}</strong> to continue. Your unsent message is
            kept until then.
          </RadixDialog.Description>
          <form className="dialog-form" onSubmit={(event) => void submit(event)}>
            <label htmlFor="reauth-password">Password</label>
            <input
              id="reauth-password"
              name="password"
              type="password"
              className="text-field selectable"
              autoComplete="current-password"
              required
              autoFocus
            />
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button type="button" className="pill-button" onClick={() => void otherAccount()}>
                Use another account
              </button>
              <button type="submit" className="pill-button pill-primary" disabled={busy}>
                Sign in
              </button>
            </div>
          </form>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
