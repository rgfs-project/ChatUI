import {
  KeyRound,
  MoreHorizontal,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserCheck,
  UserX,
} from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import type { AdminUser } from "@shared/admin";
import { useChat } from "../chat/chat-context";
import { apiJson } from "../lib/api";
import { FormActions, Row } from "../settings/row";
import { Dialog } from "../ui/dialog";
import { Menu, MenuItem, MenuSeparator } from "../ui/menu";
import { useAdminAction, useAdminQuery } from "./data";

export function UsersSection() {
  const { userId } = useChat();
  const users = useAdminQuery<{ users: AdminUser[] }>(userId, "users", "/api/admin/users");
  const act = useAdminAction(userId);
  const [passwordFor, setPasswordFor] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState<AdminUser | null>(null);

  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const done = await act(
      () =>
        apiJson("/api/admin/users", {
          method: "POST",
          json: {
            username: form.get("username"),
            password: form.get("password"),
            role: form.get("role") === "admin" ? "admin" : "user",
          },
        }),
      { done: "Account created.", refresh: ["users"] },
    );
    if (done) formEl.reset();
  }

  const update = (
    user: AdminUser,
    patch: { role?: "user" | "admin"; status?: "active" | "disabled" },
  ) =>
    act(() => apiJson(`/api/admin/users/${user.id}`, { method: "PATCH", json: patch }), {
      done: "Account updated.",
      refresh: ["users", "audit"],
    });

  return (
    <>
      <h3 className="settings-subtitle admin-subtitle">Create account</h3>
      <form
        className="settings-card"
        aria-label="Create account"
        onSubmit={(event) => void create(event)}
      >
        <Row label="Username" labelFor="admin-new-username">
          <input
            id="admin-new-username"
            name="username"
            className="text-field settings-input selectable"
            required
            autoComplete="off"
          />
        </Row>
        <Row label="Password" hint="At least 10 characters." labelFor="admin-new-password">
          <input
            id="admin-new-password"
            name="password"
            type="password"
            className="text-field settings-input selectable"
            required
            minLength={10}
            autoComplete="new-password"
          />
        </Row>
        <Row label="Role" labelFor="admin-new-role">
          <select
            id="admin-new-role"
            name="role"
            className="pill-button pill-select native-select"
            defaultValue="user"
          >
            <option value="user">Member</option>
            <option value="admin">Admin</option>
          </select>
        </Row>
        <FormActions>
          <button type="submit" className="pill-button pill-primary">
            Create
          </button>
        </FormActions>
      </form>
      <h3 className="settings-subtitle">All accounts</h3>
      {users.isPending ? <p className="settings-row-hint">Loading…</p> : null}
      <div className="settings-card">
        <table className="admin-table" aria-label="Accounts">
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Status</th>
              <th>Chats</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.data?.users.map((user) => (
              <tr key={user.id} data-testid={`admin-user-${user.username}`}>
                <td className="selectable">
                  {user.username}
                  {user.id === userId ? <span className="admin-badge">you</span> : null}
                </td>
                <td>{user.role === "admin" ? "Admin" : "Member"}</td>
                <td className={user.status === "active" ? "" : "admin-muted"}>
                  {user.status === "active"
                    ? "Active"
                    : user.status === "disabled"
                      ? "Disabled"
                      : "Closing"}
                </td>
                <td>{user.conversationCount}</td>
                <td className="admin-actions">
                  <Menu
                    label={`Actions for ${user.username}`}
                    align="end"
                    trigger={
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Actions for ${user.username}`}
                      >
                        <MoreHorizontal size={18} aria-hidden />
                      </button>
                    }
                  >
                    {user.role === "admin" ? (
                      <MenuItem
                        icon={<ShieldOff size={16} aria-hidden />}
                        onSelect={() => void update(user, { role: "user" })}
                      >
                        Make member
                      </MenuItem>
                    ) : (
                      <MenuItem
                        icon={<ShieldCheck size={16} aria-hidden />}
                        onSelect={() => void update(user, { role: "admin" })}
                      >
                        Make admin
                      </MenuItem>
                    )}
                    {user.status === "active" ? (
                      <MenuItem
                        icon={<UserX size={16} aria-hidden />}
                        onSelect={() => void update(user, { status: "disabled" })}
                      >
                        Disable
                      </MenuItem>
                    ) : (
                      <MenuItem
                        icon={<UserCheck size={16} aria-hidden />}
                        onSelect={() => void update(user, { status: "active" })}
                      >
                        Enable
                      </MenuItem>
                    )}
                    <MenuItem
                      icon={<KeyRound size={16} aria-hidden />}
                      onSelect={() => {
                        setPasswordFor(user);
                      }}
                    >
                      Set password
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      danger
                      icon={<Trash2 size={16} aria-hidden />}
                      onSelect={() => {
                        setDeleting(user);
                      }}
                    >
                      Delete account
                    </MenuItem>
                  </Menu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog
        open={passwordFor !== null}
        onOpenChange={(open) => {
          if (!open) setPasswordFor(null);
        }}
        title={`New password for ${passwordFor?.username ?? ""}`}
        description="Every session of this account is signed out."
      >
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            const target = passwordFor;
            const password = new FormData(event.currentTarget).get("password");
            if (!target) return;
            void act(
              () =>
                apiJson(`/api/admin/users/${target.id}/password`, {
                  method: "POST",
                  json: { password },
                }),
              { done: "Password set.", refresh: ["audit"] },
            ).then((ok) => {
              if (ok) setPasswordFor(null);
            });
          }}
        >
          <label htmlFor="admin-new-password">New password</label>
          <input
            id="admin-new-password"
            name="password"
            type="password"
            className="text-field selectable"
            minLength={10}
            required
            autoFocus
            autoComplete="new-password"
          />
          <div className="dialog-actions">
            <button
              type="button"
              className="pill-button"
              onClick={() => {
                setPasswordFor(null);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="pill-button pill-primary">
              Set password
            </button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.username ?? ""}?`}
        description="The account and everything it owns (chats, files, settings) is removed. This cannot be undone. Type the username to confirm."
      >
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            const target = deleting;
            const confirmUsername = new FormData(event.currentTarget).get("confirm");
            if (!target) return;
            void act(
              () =>
                apiJson(`/api/admin/users/${target.id}`, {
                  method: "DELETE",
                  json: { confirmUsername },
                }),
              { done: "Account deleted.", refresh: ["users", "audit"] },
            ).then((ok) => {
              if (ok) setDeleting(null);
            });
          }}
        >
          <label htmlFor="admin-confirm-delete">Username</label>
          <input
            id="admin-confirm-delete"
            name="confirm"
            className="text-field selectable"
            required
            autoFocus
            autoComplete="off"
          />
          <div className="dialog-actions">
            <button
              type="button"
              className="pill-button"
              onClick={() => {
                setDeleting(null);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="pill-button pill-danger">
              Delete account
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
