import {
  ArrowLeft,
  Brain,
  ChevronRight,
  CircleUserRound,
  ClipboardList,
  Cpu,
  Database,
  FolderClosed,
  ScrollText,
  Server,
  Settings,
  Settings2,
  Users,
  Wrench,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useRouteLoaderData, useSearchParams } from "react-router";
import { isTheme, type Theme } from "@shared/theme";
import { ConfirmDialog } from "../components/Dialogs";
import { Spinner } from "../components/Spinner";
import { AttachmentSettings } from "../components/AttachmentSettings";
import { SkillsSettings } from "../components/SkillsSettings";
import { useAuth } from "../lib/auth-store";
import { paths, type OverlayState } from "../lib/paths";
import { apiJson, queryKeys } from "../lib/query";
import { applyReasoningShown, applyTheme } from "../lib/theme";
import { useSignOut } from "../lib/use-sign-out";
import type { AdminSectionId } from "../admin/sections";
import type { Route } from "./+types/settings";

/** Settings → Memories: loaded when its section opens. */
const MemorySettings = lazy(() => import("../components/MemorySettings"));
/** Settings → Files: loaded when its section opens. */
const ArtifactSettings = lazy(() => import("../components/ArtifactSettings"));
/** Settings → Data: export and import, loaded when its section opens. */
const DataSettings = lazy(() => import("../components/DataSettings"));
/**
 * Administration: its own chunk, loaded only when an administrator opens (or
 * points at) one of its sections. The server authorizes every request
 * regardless; hiding the group is cosmetic.
 */
const loadAdmin = () => import("../admin/AdminPanel");
const AdminSection = lazy(loadAdmin);

export function meta(): Route.MetaDescriptors {
  return [{ title: "Settings · ChatUI" }];
}

const USER_SECTIONS = ["general", "account", "data", "skills", "memories", "files"] as const;
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
/** The old Attachments section now lives in General. */
const ALIASES: Record<string, Section> = { attachments: "general" };

const ICON = 20;

export default function SettingsPage() {
  return <SettingsPanel />;
}

/**
 * Settings, a page of its own: a section list where the conversation list
 * was (Back returns to the chat it was opened from) and the chosen section
 * in the reading column. Administrators get an Administration group; `/admin`
 * opens the same page on Users. Only implemented features appear.
 */
export function SettingsPanel({ initial }: { initial?: Section }) {
  const user = useAuth().session?.user;
  const isAdmin = user?.role === "admin";
  const location = useLocation();
  const background = (location.state as OverlayState | null)?.background;
  // `?section=` opens a section directly (e.g. the sidebar's Files).
  const [params] = useSearchParams();
  const raw = params.get("section") ?? initial;
  const requested = (raw && ALIASES[raw]) ?? raw;
  const [section, setSection] = useState<Section>(
    isUserSection(requested) || (isAdmin && isAdminSection(requested)) ? requested : "general",
  );
  const item = (id: Section, label: string, icon: ReactNode, intent?: () => void) => (
    <button
      type="button"
      className="nav-row"
      aria-current={section === id ? "true" : undefined}
      onPointerEnter={intent}
      onFocus={intent}
      onClick={() => {
        setSection(id);
      }}
    >
      {icon}
      {label}
    </button>
  );
  const preloadAdmin = () => void loadAdmin();
  const loading = (label: string) => (
    <section className="settings-body">
      <Spinner label={label} />
    </section>
  );
  return (
    <div className="settings-page" data-testid="settings">
      <aside className="sidebar">
        <div className="sidebar-top">
          <Link to={background ?? paths.newChat()} className="nav-row" data-testid="settings-back">
            <ArrowLeft size={ICON} aria-hidden />
            Back
          </Link>
        </div>
        <nav className="settings-nav" aria-label="Settings sections">
          {item("general", "General", <Settings size={ICON} aria-hidden />)}
          {item("account", "Account", <CircleUserRound size={ICON} aria-hidden />)}
          {item("data", "Data", <Database size={ICON} aria-hidden />)}
          {item("skills", "Skills", <ScrollText size={ICON} aria-hidden />)}
          {item("memories", "Memories", <Brain size={ICON} aria-hidden />)}
          {item("files", "Files", <FolderClosed size={ICON} aria-hidden />)}
          {isAdmin ? (
            <>
              <p className="nav-group">Administration</p>
              {item("users", "Users", <Users size={ICON} aria-hidden />, preloadAdmin)}
              {item("providers", "Providers", <Server size={ICON} aria-hidden />, preloadAdmin)}
              {item("models", "Models", <Cpu size={ICON} aria-hidden />, preloadAdmin)}
              {item("instance", "Instance", <Settings2 size={ICON} aria-hidden />, preloadAdmin)}
              {item("maintenance", "Maintenance", <Wrench size={ICON} aria-hidden />, preloadAdmin)}
              {item("audit", "Logs", <ClipboardList size={ICON} aria-hidden />, preloadAdmin)}
            </>
          ) : null}
        </nav>
      </aside>
      <main className="settings-main">
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
        ) : section === "account" && user ? (
          <AccountSection username={user.username} isAdmin={isAdmin} />
        ) : user ? (
          <GeneralSection userId={user.id} />
        ) : null}
      </main>
    </div>
  );
}

/** A titled card of rows ("Appearance", "Chat", …). */
function Group({ title, children }: { title?: string; children: ReactNode }) {
  return title ? (
    <section className="settings-section">
      <h2>{title}</h2>
      <div className="group">{children}</div>
    </section>
  ) : (
    <section className="group">{children}</section>
  );
}

/** Settings → General: appearance, chat display and history. */
function GeneralSection({ userId }: { userId: string }) {
  return (
    <div className="settings-body" aria-labelledby="settings-general">
      <h1 id="settings-general">General</h1>
      <Group title="Appearance">
        <ThemeSetting />
      </Group>
      <Group title="Chat">
        <ReasoningSetting />
        <AttachmentSettings userId={userId} />
      </Group>
      <Group title="Chat history">
        <ClearHistory userId={userId} />
      </Group>
    </div>
  );
}

/** Settings → Account: who is signed in, the password and signing out. */
function AccountSection({ username, isAdmin }: { username: string; isAdmin: boolean }) {
  const signOut = useSignOut();
  return (
    <div className="settings-body" id="account" aria-labelledby="settings-account">
      <h1 id="settings-account">Account</h1>
      <Group>
        <div className="settings-row">
          <span className="settings-value">
            <span className="avatar large" aria-hidden>
              {(username.at(0) ?? "?").toUpperCase()}
            </span>
            <span className="identity">
              <span className="settings-label">{username}</span>
              <span className="settings-hint">{isAdmin ? "Administrator" : "Member"}</span>
            </span>
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-label">Username</span>
          <span className="settings-value">{username}</span>
        </div>
        <Link to={paths.account()} className="settings-row">
          <span className="settings-label">Password</span>
          <span className="settings-value">
            Change
            <ChevronRight size={16} aria-hidden />
          </span>
        </Link>
      </Group>
      <Group>
        <div className="settings-row">
          <div>
            <p className="settings-label">Sign out</p>
            <p className="settings-hint">Sign out of ChatUI on this device.</p>
          </div>
          <button type="button" className="btn small" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </Group>
    </div>
  );
}

/**
 * Theme: applies at once and is remembered for this browser (a presentation
 * hint, not an account preference).
 */
function ThemeSetting() {
  // What the server rendered (from the cookie): the same on server and client.
  const root = useRouteLoaderData<{ theme?: Theme }>("root");
  const [theme, setTheme] = useState<Theme>(root?.theme ?? "system");
  return (
    <div className="settings-row">
      <label className="settings-label" htmlFor="theme-select">
        Theme
      </label>
      <select
        id="theme-select"
        className="text-input"
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

/** Show thought process: the model's reasoning above replies (display only). */
function ReasoningSetting() {
  const root = useRouteLoaderData<{ reasoningShown?: boolean }>("root");
  const [shown, setShown] = useState(root?.reasoningShown ?? true);
  return (
    <div className="settings-row">
      <label className="settings-label" htmlFor="reasoning-toggle">
        Show thought process
      </label>
      <input
        id="reasoning-toggle"
        type="checkbox"
        className="toggle"
        // Takes effect at once: a switch, not a form checkbox.
        role="switch"
        checked={shown}
        onChange={(event) => {
          applyReasoningShown(event.target.checked);
          setShown(event.target.checked);
        }}
      />
    </div>
  );
}

/**
 * Delete all chats: every conversation with its attachments, memory
 * suggestions and pin. Preferences, skills, approved memories and files stay.
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
      // Back would otherwise return to a chat that no longer exists.
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
        {result ? (
          <p className="settings-hint" role="status">
            {result}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        className="btn small danger"
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
        description="This permanently deletes every chat in your history. You can’t undo this."
        confirmLabel="Delete all"
        onConfirm={() => {
          clear.mutate();
        }}
      />
    </div>
  );
}
