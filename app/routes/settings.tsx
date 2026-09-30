import { CircleUserRound, Shield } from "lucide-react";
import { Link, useRouteLoaderData } from "react-router";
import { Overlay } from "../components/Overlay";
import { paths } from "../lib/paths";
import { useSignOut } from "../lib/use-sign-out";
import type { loader as layoutLoader } from "./app-layout";
import type { Route } from "./+types/settings";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Settings · ChatUI" }];
}

/**
 * Settings: a large panel with its sections listed on the left. Only the
 * sections of implemented features appear; later phases add theirs (for
 * example Skills under "Customize").
 */
export default function SettingsOverlay() {
  const layout = useRouteLoaderData<typeof layoutLoader>("routes/app-layout");
  const signOut = useSignOut();
  const isAdmin = layout?.user.role === "admin";
  return (
    <Overlay title="Settings" wide>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <p className="section-label">Settings</p>
          <a href="#account" className="nav-row current" aria-current="true">
            <CircleUserRound size={18} aria-hidden /> Account
          </a>
          {isAdmin ? (
            <Link to={paths.admin()} className="nav-row">
              <Shield size={18} aria-hidden /> Administration
            </Link>
          ) : null}
        </nav>
        <section className="settings-body" id="account" aria-labelledby="settings-account">
          <h2 id="settings-account">Account</h2>
          <div className="settings-row">
            <div>
              <p className="settings-label">Username</p>
              <p className="settings-hint">
                {layout?.user.username}
                {isAdmin ? " · administrator" : ""}
              </p>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <p className="settings-label">Password</p>
              <p className="settings-hint">Change the password for this account.</p>
            </div>
            <Link to={paths.account()} className="button-link secondary">
              Change
            </Link>
          </div>
          <div className="settings-row">
            <div>
              <p className="settings-label">Sign out</p>
              <p className="settings-hint">Sign out of ChatUI on this device.</p>
            </div>
            <button type="button" className="secondary" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </section>
      </div>
    </Overlay>
  );
}
