import { CircleUserRound, Paperclip, ScrollText, Shield } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { AttachmentSettings } from "../components/AttachmentSettings";
import { Overlay } from "../components/Overlay";
import { SkillsSettings } from "../components/SkillsSettings";
import { useAuth } from "../lib/auth-store";
import { paths } from "../lib/paths";
import { useSignOut } from "../lib/use-sign-out";
import type { Route } from "./+types/settings";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Settings · ChatUI" }];
}

type Section = "account" | "skills" | "attachments";

/**
 * Settings: a large panel with its sections listed on the left (Account;
 * Skills and Attachments under "Customize"). Only implemented features appear.
 */
export default function SettingsOverlay() {
  const user = useAuth().session?.user;
  const signOut = useSignOut();
  const isAdmin = user?.role === "admin";
  const [section, setSection] = useState<Section>("account");
  const tab = (id: Section, label: string, icon: ReactNode) => (
    <button
      type="button"
      className={`nav-row${section === id ? " current" : ""}`}
      aria-current={section === id ? "true" : undefined}
      onClick={() => {
        setSection(id);
      }}
    >
      {icon} {label}
    </button>
  );
  return (
    <Overlay title="Settings" wide>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <p className="section-label">Settings</p>
          {tab("account", "Account", <CircleUserRound size={18} aria-hidden />)}
          {isAdmin ? (
            // Intent prefetch of the admin chunk, only for admins (Phase 9 rules).
            <Link to={paths.admin()} className="nav-row" prefetch="intent">
              <Shield size={18} aria-hidden /> Administration
            </Link>
          ) : null}
          <p className="section-label">Customize</p>
          {tab("skills", "Skills", <ScrollText size={18} aria-hidden />)}
          {tab("attachments", "Attachments", <Paperclip size={18} aria-hidden />)}
        </nav>
        {section === "skills" && user ? (
          <SkillsSettings userId={user.id} />
        ) : section === "attachments" && user ? (
          <AttachmentSettings userId={user.id} />
        ) : (
          <section className="settings-body" id="account" aria-labelledby="settings-account">
            <h2 id="settings-account">Account</h2>
            <div className="settings-row">
              <div>
                <p className="settings-label">Username</p>
                <p className="settings-hint">
                  {user?.username}
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
        )}
      </div>
    </Overlay>
  );
}
