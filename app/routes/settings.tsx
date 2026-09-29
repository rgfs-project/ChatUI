import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { Overlay } from "../components/Overlay";
import { apiFetch } from "../lib/api";
import { authStore, useAuth } from "../lib/auth-store";
import { paths } from "../lib/paths";
import type { Route } from "./+types/settings";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Settings · ChatUI" }];
}

export default function SettingsOverlay() {
  const user = useAuth().session?.user;
  const navigate = useNavigate();
  const client = useQueryClient();
  return (
    <Overlay title="Settings">
      <section className="settings-section">
        <h2>Account</h2>
        <p>
          Signed in as <strong>{user?.username}</strong>
          {user?.role === "admin" ? " (admin)" : ""}.
        </p>
        <p className="settings-actions">
          <Link to={paths.account()}>Change password</Link>
          {user?.role === "admin" ? <Link to={paths.admin()}>Administration</Link> : null}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              // Leave the shell first (it discards drafts), then drop the account.
              void apiFetch("/api/auth/logout", { method: "POST" })
                .catch(() => undefined)
                .then(() => navigate(paths.login(), { replace: true }))
                .then(() => {
                  authStore.signedOut();
                  client.clear();
                });
            }}
          >
            Sign out
          </button>
        </p>
      </section>
    </Overlay>
  );
}
