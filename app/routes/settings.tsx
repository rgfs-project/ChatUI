import {
  Brain,
  CircleUserRound,
  ClipboardList,
  Cpu,
  Database,
  FileCode,
  Paperclip,
  ScrollText,
  Server,
  Settings2,
  Users,
  Wrench,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ConfirmDialog } from "../components/Dialogs";
import { Spinner } from "../components/Spinner";
import { apiJson, queryKeys } from "../lib/query";
import { AttachmentSettings } from "../components/AttachmentSettings";
import { Overlay } from "../components/Overlay";
import { SkillsSettings } from "../components/SkillsSettings";
import { useAuth } from "../lib/auth-store";
import { paths } from "../lib/paths";
import { useSignOut } from "../lib/use-sign-out";
import { applyTheme, currentTheme } from "../lib/theme";
import { isTheme, type Theme } from "@shared/theme";
import type { AdminSectionId } from "../admin/sections";
import type { Route } from "./+types/settings";

/** Settings → Memories (Phase 13b): loaded when its tab opens. */
const MemorySettings = lazy(() => import("../components/MemorySettings"));
/** Settings → Files (Phase 13c): loaded when its tab opens. */
const ArtifactSettings = lazy(() => import("../components/ArtifactSettings"));
/** Settings → Data (Phase 13d): export and import, loaded when its tab opens. */
const DataSettings = lazy(() => import("../components/DataSettings"));
/**
 * Administration (Phase 10): its own chunk, loaded only when an administrator
 * opens (or points at) one of its sections. The server authorizes every
 * request regardless (INV-24); hiding the group is cosmetic.
 */
const loadAdmin = () => import("../admin/AdminPanel");
const AdminSection = lazy(loadAdmin);

export function meta(): Route.MetaDescriptors {
  return [{ title: "Settings · ChatUI" }];
}

const USER_SECTIONS = ["account", "data", "skills", "memories", "files", "attachments"] as const;
type UserSection = (typeof USER_SECTIONS)[number];
const ADMIN_SECTIONS: readonly AdminSectionId[] = [
  "users",
  "providers",
  "models",
  "instance",
  "maintenance",
  "audit",
];
type Section = UserSection | AdminSectionId;

const isUserSection = (value: unknown): value is UserSection =>
  (USER_SECTIONS as readonly unknown[]).includes(value);
const isAdminSection = (value: unknown): value is AdminSectionId =>
  (ADMIN_SECTIONS as readonly unknown[]).includes(value);

const ICON = 18;

export default function SettingsOverlay() {
  return <SettingsPanel />;
}

/**
 * Settings, one panel for everything (owner's design, after ChatGPT): the
 * sections listed in a rail that scrolls on its own, in three groups —
 * Settings, Customize and, for administrators, Administration. `/admin`
 * opens the same panel on Users. Only implemented features appear.
 */
export function SettingsPanel({ initial }: { initial?: Section }) {
  const user = useAuth().session?.user;
  const signOut = useSignOut();
  const isAdmin = user?.role === "admin";
  // `?section=` opens a section directly (the account menu's "Import & export").
  const [params] = useSearchParams();
  const requested = params.get("section") ?? initial;
  const [section, setSection] = useState<Section>(
    isUserSection(requested) || (isAdmin && isAdminSection(requested)) ? requested : "account",
  );
  const item = (id: Section, label: string, icon: ReactNode, intent?: () => void) => (
    <button
      type="button"
      className={`nav-row${section === id ? " current" : ""}`}
      aria-current={section === id ? "true" : undefined}
      onPointerEnter={intent}
      onFocus={intent}
      onClick={() => {
        setSection(id);
      }}
    >
      {icon} {label}
    </button>
  );
  const preloadAdmin = () => void loadAdmin();
  const loading = (label: string) => (
    <section className="settings-body" tabIndex={0}>
      <Spinner label={label} />
    </section>
  );
  return (
    <Overlay title="Settings" wide>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <p className="section-label">Settings</p>
          {item("account", "Account", <CircleUserRound size={ICON} aria-hidden />)}
          {item("data", "Data", <Database size={ICON} aria-hidden />)}
          <p className="section-label">Customize</p>
          {item("skills", "Skills", <ScrollText size={ICON} aria-hidden />)}
          {item("memories", "Memories", <Brain size={ICON} aria-hidden />)}
          {item("files", "Files", <FileCode size={ICON} aria-hidden />)}
          {item("attachments", "Attachments", <Paperclip size={ICON} aria-hidden />)}
          {isAdmin ? (
            <>
              <p className="section-label">Administration</p>
              {item("users", "Users", <Users size={ICON} aria-hidden />, preloadAdmin)}
              {item("providers", "Providers", <Server size={ICON} aria-hidden />, preloadAdmin)}
              {item("models", "Models", <Cpu size={ICON} aria-hidden />, preloadAdmin)}
              {item(
                "instance",
                "Instance settings",
                <Settings2 size={ICON} aria-hidden />,
                preloadAdmin,
              )}
              {item("maintenance", "Maintenance", <Wrench size={ICON} aria-hidden />, preloadAdmin)}
              {item("audit", "Audit log", <ClipboardList size={ICON} aria-hidden />, preloadAdmin)}
            </>
          ) : null}
        </nav>
        {isAdminSection(section) && isAdmin ? (
          <Suspense fallback={loading("Loading administration…")}>
            <AdminSection section={section} />
          </Suspense>
        ) : section === "data" && user ? (
          <Suspense fallback={loading("Loading…")}>
            <DataSettings userId={user.id} />
          </Suspense>
        ) : section === "skills" && user ? (
          <SkillsSettings userId={user.id} />
        ) : section === "memories" && user ? (
          <Suspense fallback={loading("Loading memories…")}>
            <MemorySettings userId={user.id} />
          </Suspense>
        ) : section === "files" && user ? (
          <Suspense fallback={loading("Loading files…")}>
            <ArtifactSettings userId={user.id} />
          </Suspense>
        ) : section === "attachments" && user ? (
          <AttachmentSettings userId={user.id} />
        ) : (
          <section
            className="settings-body"
            tabIndex={0}
            id="account"
            aria-labelledby="settings-account"
          >
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
            <ThemeSetting />
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
            {user ? <ClearHistory userId={user.id} /> : null}
          </section>
        )}
      </div>
    </Overlay>
  );
}

/**
 * Settings → Account → Theme (Phase 18): applies at once and is remembered
 * for this browser (a presentation hint, not an account preference).
 */
function ThemeSetting() {
  // Settings is a client-only overlay, so the document is always there.
  const [theme, setTheme] = useState<Theme>(currentTheme);
  return (
    <div className="settings-row">
      <div>
        <label className="settings-label" htmlFor="theme-select">
          Theme
        </label>
        <p className="settings-hint" id="theme-hint">
          System follows your device’s light or dark setting.
        </p>
      </div>
      <select
        id="theme-select"
        className="text-input settings-select"
        aria-describedby="theme-hint"
        value={theme}
        onChange={(event) => {
          const next = event.target.value;
          if (!isTheme(next)) return;
          applyTheme(next);
          setTheme(next);
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </div>
  );
}

/**
 * Settings → Account → Delete all chats (contracts §4.2 clear history): every
 * conversation with its attachments, memory suggestions and pin. Preferences,
 * skills, approved memories and (later) artifacts stay.
 */
function ClearHistory({ userId }: { userId: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const clear = useMutation({
    mutationFn: () => apiJson<{ deleted: number }>("/api/conversations", { method: "DELETE" }),
    onSuccess: async ({ deleted }) => {
      setResult(`${String(deleted)} chat${deleted === 1 ? "" : "s"} deleted.`);
      client.removeQueries({ queryKey: ["user", userId, "conversation"] });
      client.removeQueries({ queryKey: ["user", userId, "search"] });
      await client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
      await navigate(paths.settings(), { replace: true, state: { background: paths.newChat() } });
    },
    onError: () => {
      setResult("The chats couldn’t be deleted. Try again.");
    },
  });
  return (
    <div className="settings-row">
      <div>
        <p className="settings-label">Delete all chats</p>
        <p className="settings-hint">
          Permanently deletes every conversation and its attachments. Settings, skills and memories
          stay.
        </p>
        {result ? (
          <p className="settings-hint" role="status">
            {result}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        className="secondary danger-outline"
        disabled={clear.isPending}
        onClick={() => {
          setConfirming(true);
        }}
      >
        Delete all
      </button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete all chats?"
        description="Every conversation and its attachments will be permanently deleted. This cannot be undone."
        confirmLabel="Delete all"
        onConfirm={() => {
          clear.mutate();
        }}
      />
    </div>
  );
}
