import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouteLoaderData } from "react-router";
import { Overlay } from "../components/Overlay";
import { apiFetch } from "../lib/api";
import { paths } from "../lib/paths";
import type { loader as layoutLoader } from "./app-layout";
import type { Route } from "./+types/settings";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Settings · ChatUI" }];
}

export default function SettingsOverlay() {
  const layout = useRouteLoaderData<typeof layoutLoader>("routes/app-layout");
  const navigate = useNavigate();
  const client = useQueryClient();
  return (
    <Overlay title="Settings">
      <section className="settings-section">
        <h2>Account</h2>
        <p>
          Signed in as <strong>{layout?.user.username}</strong>
          {layout?.user.role === "admin" ? " (admin)" : ""}.
        </p>
        <p className="settings-actions">
          <Link to={paths.account()}>Change password</Link>
          {layout?.user.role === "admin" ? <Link to={paths.admin()}>Administration</Link> : null}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void apiFetch("/api/auth/logout", { method: "POST" })
                .catch(() => undefined)
                .then(() => {
                  client.clear();
                  return navigate(paths.login(), { replace: true });
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
