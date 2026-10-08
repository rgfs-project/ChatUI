import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Trash2 } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { ConfirmDialog } from "../components/ui";
import { api, messageOf } from "../lib/api";
import { keys } from "../lib/query";
import type { ShellUser } from "../lib/shell";
import { signOut } from "../lib/sign-out";
import { ActionRow, FieldRow, formText, Group, LinkRow, Row, Status, useSubPage } from "./parts";

export function Account(props: { user: ShellUser }) {
  const client = useQueryClient();
  const [view, setView] = useState<"main" | "password">("main");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  useSubPage(
    view === "password"
      ? {
          title: "Password",
          onBack: () => {
            setView("main");
            setError(null);
          },
        }
      : null,
  );

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
      setOk(`${String(result.deleted)} chats deleted.`);
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
      <form onSubmit={(e) => void changePassword(e)}>
        <Group note="You’ll be signed out everywhere and asked to sign in again.">
          <FieldRow
            label="Current password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />
          <FieldRow
            label="New password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
          />
          <FieldRow
            label="Repeat new password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
          />
        </Group>
        <Group>
          <button type="submit" className="row row-button action-row" disabled={busy}>
            Change password
          </button>
        </Group>
        <Status error={error} />
      </form>
    );

  return (
    <>
      <Group>
        <Row label="Username">
          <span className="row-value">@{props.user.username}</span>
        </Row>
        <Row label="Role">
          <span className="row-value">
            {props.user.role === "admin" ? "Administrator" : "Member"}
          </span>
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
      <Group>
        <ActionRow
          icon={<LogOut size={18} aria-hidden />}
          label="Sign out"
          onClick={() => void signOut()}
        />
      </Group>
      <Group heading="Danger zone">
        <ActionRow
          danger
          icon={<Trash2 size={18} aria-hidden />}
          label="Delete all chats"
          onClick={() => {
            setClearing(true);
          }}
        />
      </Group>
      <Status error={clearing ? null : error} ok={ok} />
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
