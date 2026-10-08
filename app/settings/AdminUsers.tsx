import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2, UserPlus } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import type { AdminUserDto } from "@shared/admin";
import { Dialog, DialogClose, Switch } from "../components/ui";
import { api, messageOf } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { keys } from "../lib/query";
import {
  ActionRow,
  Choice,
  FieldRow,
  formText,
  Group,
  LinkRow,
  Row,
  Status,
  useSubPage,
} from "./parts";

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
  const [dialog, setDialog] = useState<"password" | "delete" | null>(null);
  const user = view && view !== "new" ? users.data?.find((u) => u.id === view) : undefined;
  const back = () => {
    setView(null);
    setError(null);
    setOk(null);
  };
  useSubPage(
    view === "new"
      ? { title: "New user", onBack: back }
      : user
        ? { title: user.username, onBack: back }
        : null,
  );

  async function run(fn: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await fn();
      await client.invalidateQueries({ queryKey: key });
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
      <form
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
        <Group>
          <FieldRow
            label="Username"
            name="username"
            required
            maxLength={64}
            autoCapitalize="none"
            spellCheck={false}
          />
          <FieldRow
            label="Password"
            name="password"
            type="password"
            required
            autoComplete="new-password"
          />
          <Row label="Role" id="nu-role">
            <Choice labelledBy="nu-role" value={role} options={ROLES} onChange={setRole} />
          </Row>
        </Group>
        <Group>
          <button type="submit" className="row row-button action-row" disabled={busy}>
            <UserPlus size={18} aria-hidden />
            <span>Create user</span>
          </button>
        </Group>
        <Status error={error} />
      </form>
    );

  if (user) {
    const self = user.id === props.userId;
    return (
      <>
        <Group
          note={`${String(user.conversationCount)} chats · created ${formatDateTime(user.createdAt)}${
            self ? " · You can’t disable or delete yourself." : ""
          }`}
        >
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
          <Row label="Can sign in">
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
        </Group>
        <Group>
          <ActionRow
            icon={<KeyRound size={18} aria-hidden />}
            label="Set a new password"
            onClick={() => {
              setError(null);
              setDialog("password");
            }}
          />
        </Group>
        {self ? null : (
          <Group>
            <ActionRow
              danger
              icon={<Trash2 size={18} aria-hidden />}
              label="Delete account"
              onClick={() => {
                setError(null);
                setDialog("delete");
              }}
            />
          </Group>
        )}
        <Status error={dialog ? null : error} ok={ok} />
        <Dialog
          open={dialog === "password"}
          onOpenChange={(o) => {
            if (!o) setDialog(null);
          }}
          title={`New password for ${user.username}`}
          description="Their sessions end; they sign in with the new password."
        >
          <form
            className="dialog-form"
            onSubmit={(e: SyntheticEvent<HTMLFormElement>) => {
              e.preventDefault();
              const password = formText(new FormData(e.currentTarget), "password");
              void run(
                () =>
                  api(`/api/admin/users/${user.id}/password`, {
                    method: "POST",
                    body: { password },
                  }),
                "Password set. Their sessions have ended.",
              ).then((done) => {
                if (done) setDialog(null);
              });
            }}
          >
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
            />
            <Status error={error} />
            <div className="dialog-actions">
              <DialogClose asChild>
                <button type="button" className="button">
                  Cancel
                </button>
              </DialogClose>
              <button type="submit" className="button primary" disabled={busy}>
                Set password
              </button>
            </div>
          </form>
        </Dialog>
        <Dialog
          open={dialog === "delete"}
          onOpenChange={(o) => {
            if (!o) setDialog(null);
          }}
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
                  setDialog(null);
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
      {users.data && users.data.length > 0 ? (
        <Group>
          {users.data.map((u) => (
            <LinkRow
              key={u.id}
              label={u.username}
              value={
                u.status === "disabled"
                  ? "Disabled"
                  : u.role === "admin"
                    ? "Administrator"
                    : "Member"
              }
              onClick={() => {
                setError(null);
                setOk(null);
                setView(u.id);
              }}
            />
          ))}
        </Group>
      ) : null}
      <Group>
        <ActionRow
          icon={<UserPlus size={18} aria-hidden />}
          label="Add user"
          onClick={() => {
            setRole("user");
            setError(null);
            setView("new");
          }}
        />
      </Group>
      <Status error={users.isError ? "Couldn’t load users." : error} />
    </>
  );
}
