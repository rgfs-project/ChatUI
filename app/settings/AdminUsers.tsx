import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type SyntheticEvent } from "react";
import type { AdminUserDto } from "@shared/admin";
import { Dialog, DialogClose, Switch } from "../components/ui";
import { api, messageOf } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { keys } from "../lib/query";
import { Choice, Field, Group, LinkRow, Row, Status, SubHeader, formText } from "./parts";

const ROLES = [
  { value: "user" as const, label: "Member" },
  { value: "admin" as const, label: "Administrator" },
];

export function AdminUsers(props: { userId: string }) {
  const client = useQueryClient();
  const key = keys.admin(props.userId, "users");
  const users = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<{ users: AdminUserDto[] }>("/api/admin/users", { signal }),
    select: (d) => d.users,
  });
  const [view, setView] = useState<string | null>(null);
  const [role, setRole] = useState<"user" | "admin">("user");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: key });

  async function run(fn: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await fn();
      await refresh();
      if (success) setOk(success);
      return true;
    } catch (e) {
      setError(messageOf(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (view === "new")
    return (
      <>
        <SubHeader
          title="New user"
          backLabel="Users"
          onBack={() => {
            setView(null);
          }}
        />
        <form
          className="settings-form"
          onSubmit={(e: SyntheticEvent<HTMLFormElement>) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            void run(() =>
              api("/api/admin/users", {
                method: "POST",
                body: {
                  username: formText(form, "username").trim(),
                  password: formText(form, "password"),
                  role,
                },
              }),
            ).then((done) => {
              if (done) setView(null);
            });
          }}
        >
          <Field
            label="Username"
            name="username"
            required
            maxLength={64}
            autoCapitalize="none"
            spellCheck={false}
          />
          <Field
            label="Password"
            name="password"
            type="password"
            required
            autoComplete="new-password"
          />
          <div className="field inline">
            <span id="nu-role">Role</span>
            <Choice labelledBy="nu-role" value={role} options={ROLES} onChange={setRole} />
          </div>
          <Status error={error} />
          <div className="form-actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                setView(null);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              Create user
            </button>
          </div>
        </form>
      </>
    );

  const user = view ? users.data?.find((u) => u.id === view) : undefined;
  if (view && user) {
    const self = user.id === props.userId;
    return (
      <>
        <SubHeader
          title={user.username}
          backLabel="Users"
          onBack={() => {
            setView(null);
            setError(null);
            setOk(null);
          }}
        />
        <Group>
          <Row label="Role" id="u-role">
            <Choice
              labelledBy="u-role"
              value={user.role}
              options={ROLES}
              disabled={busy}
              onChange={(r) =>
                void run(() =>
                  api(`/api/admin/users/${user.id}`, { method: "PATCH", body: { role: r } }),
                )
              }
            />
          </Row>
          <Row label="Can sign in" hint={self ? "You can’t disable yourself." : undefined}>
            <Switch
              label="Can sign in"
              checked={user.status === "active"}
              disabled={busy || self}
              onChange={(on) =>
                void run(() =>
                  api(`/api/admin/users/${user.id}`, {
                    method: "PATCH",
                    body: { status: on ? "active" : "disabled" },
                  }),
                )
              }
            />
          </Row>
          <Row label="Chats">
            <span className="muted">{user.conversationCount}</span>
          </Row>
          <Row label="Created">
            <span className="muted">{formatDateTime(user.createdAt)}</span>
          </Row>
        </Group>
        <form
          className="settings-group"
          onSubmit={(e: SyntheticEvent<HTMLFormElement>) => {
            e.preventDefault();
            const formEl = e.currentTarget;
            const password = formText(new FormData(formEl), "password");
            void run(
              () =>
                api(`/api/admin/users/${user.id}/password`, { method: "POST", body: { password } }),
              "Password set. Their sessions have ended.",
            ).then((done) => {
              if (done) formEl.reset();
            });
          }}
        >
          <h3 className="group-heading">Set a new password</h3>
          <div className="inline-form">
            <label className="sr-only" htmlFor="u-password">
              New password
            </label>
            <input
              id="u-password"
              name="password"
              type="password"
              className="input"
              required
              autoComplete="new-password"
              placeholder="New password"
            />
            <button type="submit" className="button" disabled={busy}>
              Set password
            </button>
          </div>
        </form>
        <Status error={error} ok={ok} />
        {self ? null : (
          <Group heading="Danger zone">
            <button
              type="button"
              className="row row-button danger-text"
              onClick={() => {
                setDeleteOpen(true);
              }}
            >
              Delete user
            </button>
          </Group>
        )}
        <Dialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={`Delete ${user.username}?`}
          description="Their account and all their chats, files and memories are deleted. Type the username to confirm."
        >
          <form
            className="dialog-form"
            onSubmit={(e: SyntheticEvent<HTMLFormElement>) => {
              e.preventDefault();
              const confirmUsername = formText(new FormData(e.currentTarget), "confirm");
              void run(() =>
                api(`/api/admin/users/${user.id}`, { method: "DELETE", body: { confirmUsername } }),
              ).then((done) => {
                if (done) {
                  setDeleteOpen(false);
                  setView(null);
                }
              });
            }}
          >
            <label className="sr-only" htmlFor="confirm-username">
              Username
            </label>
            <input
              id="confirm-username"
              name="confirm"
              className="input"
              autoComplete="off"
              placeholder={user.username}
            />
            <Status error={error} />
            <div className="dialog-actions">
              <DialogClose asChild>
                <button type="button" className="button">
                  Cancel
                </button>
              </DialogClose>
              <button type="submit" className="button danger" disabled={busy}>
                Delete
              </button>
            </div>
          </form>
        </Dialog>
      </>
    );
  }

  return (
    <>
      <div className="section-toolbar">
        <p className="muted">Everyone who can sign in to this ChatUI.</p>
        <button
          type="button"
          className="button primary small"
          onClick={() => {
            setRole("user");
            setError(null);
            setView("new");
          }}
        >
          New user
        </button>
      </div>
      <Group>
        {users.data?.map((u) => (
          <LinkRow
            key={u.id}
            label={u.username}
            hint={`${u.role === "admin" ? "Administrator" : "Member"} · ${String(u.conversationCount)} chats`}
            value={u.status === "disabled" ? "Disabled" : undefined}
            onClick={() => {
              setError(null);
              setOk(null);
              setView(u.id);
            }}
          />
        ))}
      </Group>
      <Status error={users.isError ? "Couldn’t load users." : error} />
    </>
  );
}
