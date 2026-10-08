import { useQueryClient } from "@tanstack/react-query";
import { useState, type SyntheticEvent } from "react";
import { ConfirmDialog } from "../components/ui";
import { api, messageOf } from "../lib/api";
import { keys } from "../lib/query";
import type { ShellUser } from "../lib/shell";
import { signOut } from "../lib/sign-out";
import { Field, Group, LinkRow, Row, Status, SubHeader, formText } from "./parts";

export function Account(props: { user: ShellUser }) {
  const client = useQueryClient();
  const [view, setView] = useState<"main" | "password">("main");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);

  async function changePassword(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = formText(form, "newPassword");
    if (next !== formText(form, "confirmPassword")) {
      setError("The new passwords don’t match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: { currentPassword: formText(form, "currentPassword"), newPassword: next },
      });
      // Every session ends with a password change.
      window.location.assign("/login");
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  }

  async function clearHistory() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ deleted: number }>("/api/conversations", { method: "DELETE" });
      setCleared(`${String(result.deleted)} chats deleted.`);
      setClearing(false);
      await client.invalidateQueries({ queryKey: keys.user(props.user.id) });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (view === "password")
    return (
      <>
        <SubHeader
          title="Password"
          backLabel="Account"
          onBack={() => {
            setView("main");
            setError(null);
          }}
        />
        <form className="settings-form" onSubmit={(e) => void changePassword(e)}>
          <Field
            label="Current password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />
          <Field
            label="New password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
          />
          <Field
            label="Repeat new password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
          />
          <p className="field-hint">You’ll be signed out everywhere and asked to sign in again.</p>
          <Status error={error} />
          <div className="form-actions">
            <button type="submit" className="button primary" disabled={busy}>
              Change password
            </button>
          </div>
        </form>
      </>
    );

  return (
    <>
      <Group>
        <Row label="Username">
          <span className="muted">{props.user.username}</span>
        </Row>
        <Row label="Role">
          <span className="muted">{props.user.role === "admin" ? "Administrator" : "Member"}</span>
        </Row>
      </Group>
      <Group heading="Security">
        <LinkRow
          label="Password"
          onClick={() => {
            setView("password");
          }}
        />
      </Group>
      <div className="button-row">
        <button type="button" className="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
      <Group heading="Danger zone">
        <button
          type="button"
          className="row row-button danger-text"
          onClick={() => {
            setClearing(true);
          }}
        >
          Delete all chats
        </button>
      </Group>
      <Status error={clearing ? null : error} ok={cleared} />
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title="Delete all chats?"
        description="Every conversation you have will be permanently deleted. Memories, skills and files stay."
        confirm="Delete all"
        danger
        busy={busy}
        error={clearing ? error : null}
        onConfirm={() => void clearHistory()}
      />
    </>
  );
}
