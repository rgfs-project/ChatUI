import {
  ArrowLeft,
  Brain,
  ChevronRight,
  CircleUserRound,
  ClipboardList,
  Cpu,
  Database,
  Gauge,
  PanelLeft,
  ScrollText,
  Server,
  Settings,
  SlidersHorizontal,
  Users,
  Wrench,
} from "lucide-react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router";
import { GeneralSettings } from "../components/GeneralSettings";
import { SkillsSettings } from "../components/SkillsSettings";
import { Spinner } from "../components/Spinner";
import type { AdminSectionId } from "../admin/sections";
import { useAuth } from "../lib/auth-store";
import { paths, type OverlayState } from "../lib/paths";
import { NARROW_QUERY, useMediaQuery } from "../lib/use-media-query";
import type { Route } from "./+types/settings";

const AccountSettings = lazy(() => import("../components/AccountSettings"));
const UsageSettings = lazy(() => import("../components/UsageSettings"));
const MemorySettings = lazy(() => import("../components/MemorySettings"));
const DataSettings = lazy(() => import("../components/DataSettings"));
/**
 * Administration: its own chunk, loaded only when an administrator opens one
 * of its sections. The server authorizes every request regardless.
 */
const loadAdmin = () => import("../admin/AdminPanel");
const AdminSection = lazy(loadAdmin);

export function meta(): Route.MetaDescriptors {
  return [{ title: "Settings · ChatUI" }];
}

const USER_SECTIONS = ["general", "account", "data", "usage", "skills", "memories"] as const;
type UserSection = (typeof USER_SECTIONS)[number];
const ADMIN_SECTIONS: readonly AdminSectionId[] = [
  "users",
  "providers",
  "models",
  "instance",
  "maintenance",
  "logs",
];
type Section = UserSection | AdminSectionId;

const isUserSection = (value: unknown): value is UserSection =>
  (USER_SECTIONS as readonly unknown[]).includes(value);
const isAdminSection = (value: unknown): value is AdminSectionId =>
  (ADMIN_SECTIONS as readonly unknown[]).includes(value);
/** Older links keep working. */
const ALIASES: Record<string, Section> = { attachments: "general", audit: "logs" };

const ICON = 20;
const SECTIONS: Record<Section, { label: string; icon: ReactNode; admin?: boolean }> = {
  general: { label: "General", icon: <Settings size={ICON} aria-hidden /> },
  account: { label: "Account", icon: <CircleUserRound size={ICON} aria-hidden /> },
  data: { label: "Data", icon: <Database size={ICON} aria-hidden /> },
  usage: { label: "Usage", icon: <Gauge size={ICON} aria-hidden /> },
  skills: { label: "Skills", icon: <ScrollText size={ICON} aria-hidden /> },
  memories: { label: "Memories", icon: <Brain size={ICON} aria-hidden /> },
  users: { label: "Users", icon: <Users size={ICON} aria-hidden />, admin: true },
  providers: { label: "Providers", icon: <Server size={ICON} aria-hidden />, admin: true },
  models: { label: "Models", icon: <Cpu size={ICON} aria-hidden />, admin: true },
  instance: { label: "Instance", icon: <SlidersHorizontal size={ICON} aria-hidden />, admin: true },
  maintenance: { label: "Maintenance", icon: <Wrench size={ICON} aria-hidden />, admin: true },
  logs: { label: "Logs", icon: <ClipboardList size={ICON} aria-hidden />, admin: true },
};

export default function SettingsPage() {
  return <SettingsPanel />;
}

/**
 * Settings, a page of its own. Wide screens: a section column where the chat
 * list was (Back returns to the page it was opened from) and the chosen
 * section in the reading column. Phones: a list of sections, then one section
 * per screen. `/admin` opens the same page on Users.
 */
export function SettingsPanel({ initial }: { initial?: Section }) {
  const user = useAuth().session?.user;
  const isAdmin = user?.role === "admin";
  const narrow = useMediaQuery(NARROW_QUERY);
  const location = useLocation();
  const background = (location.state as OverlayState | null)?.background;
  const [params, setParams] = useSearchParams();
  const raw = params.get("section") ?? initial;
  const requested = (raw && ALIASES[raw]) ?? raw;
  // The old Settings → Files moved to its own page.
  const toFiles = raw === "files";
  const section: Section | null = isUserSection(requested)
    ? requested
    : isAdmin && isAdminSection(requested)
      ? requested
      : null;
  const valid = section !== null;
  // Phones show the section list until one is chosen (or named in the URL).
  const listOnly = narrow && !valid;
  const [railed, setRailed] = useState(false);
  const back = background ?? paths.newChat();
  // History state carried through section changes (Back keeps its target).
  const keep = location.state as OverlayState | null;

  if (toFiles) return <Navigate to={paths.files()} replace state={keep} />;

  const open = (id: Section) => {
    setParams({ section: id }, { state: keep, preventScrollReset: true });
  };
  const preloadAdmin = () => void loadAdmin();
  const ids = [...USER_SECTIONS, ...(isAdmin ? ADMIN_SECTIONS : [])];

  const shown: Section = section ?? "general";
  const content = !user ? null : isAdminSection(shown) && isAdmin ? (
    <Suspense fallback={<Spinner label="Loading administration…" />}>
      <AdminSection section={shown} />
    </Suspense>
  ) : shown === "account" ? (
    <Suspense fallback={<Spinner label="Loading…" />}>
      <AccountSettings userId={user.id} />
    </Suspense>
  ) : shown === "data" ? (
    <Suspense fallback={<Spinner label="Loading…" />}>
      <DataSettings userId={user.id} />
    </Suspense>
  ) : shown === "usage" ? (
    <Suspense fallback={<Spinner label="Loading usage…" />}>
      <UsageSettings userId={user.id} />
    </Suspense>
  ) : shown === "skills" ? (
    <SkillsSettings userId={user.id} />
  ) : shown === "memories" ? (
    <Suspense fallback={<Spinner label="Loading memories…" />}>
      <MemorySettings userId={user.id} />
    </Suspense>
  ) : (
    <GeneralSettings userId={user.id} />
  );

  if (narrow)
    return (
      <div className="settings-mobile" data-testid="settings">
        <header className="mobile-head">
          {listOnly ? (
            <Link
              to={back}
              className="icon-btn"
              aria-label="Back to chats"
              data-testid="settings-back"
            >
              <ArrowLeft size={20} aria-hidden />
            </Link>
          ) : (
            <button
              type="button"
              className="icon-btn"
              aria-label="Back to settings"
              onClick={() => {
                setParams({}, { state: keep });
              }}
            >
              <ArrowLeft size={20} aria-hidden />
            </button>
          )}
          <span className="title">Settings</span>
        </header>
        <div className="page-scroll">
          <div className="page-body">
            {listOnly ? (
              <nav className="group nav-card" aria-label="Settings sections">
                {ids.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="row"
                    onPointerEnter={SECTIONS[id].admin ? preloadAdmin : undefined}
                    onClick={() => {
                      open(id);
                    }}
                  >
                    {SECTIONS[id].icon}
                    {SECTIONS[id].label}
                    <ChevronRight size={16} className="chev" aria-hidden />
                  </button>
                ))}
              </nav>
            ) : (
              content
            )}
          </div>
        </div>
      </div>
    );

  return (
    <div className="split" data-testid="settings">
      <aside className={`sidebar settings-nav${railed ? " rail" : ""}`}>
        <div className="sidebar-top">
          <button
            type="button"
            className="icon-btn toggle-btn rail-toggle"
            aria-label={railed ? "Open sidebar" : "Close sidebar"}
            title={railed ? "Open sidebar" : "Close sidebar"}
            onClick={() => {
              setRailed((value) => !value);
            }}
          >
            <PanelLeft size={20} aria-hidden />
          </button>
        </div>
        <Link to={back} className="nav-row back-row" data-testid="settings-back" aria-label="Back">
          <ArrowLeft size={ICON} aria-hidden />
          <span className="label">Back</span>
        </Link>
        <nav className="nav-list" aria-label="Settings sections">
          {ids.map((id, index) => (
            <div key={id} className={index === USER_SECTIONS.length ? "nav-gap" : undefined}>
              <button
                type="button"
                className="nav-row"
                aria-current={shown === id ? "page" : undefined}
                aria-label={SECTIONS[id].label}
                onPointerEnter={SECTIONS[id].admin ? preloadAdmin : undefined}
                onFocus={SECTIONS[id].admin ? preloadAdmin : undefined}
                onClick={() => {
                  open(id);
                }}
              >
                {SECTIONS[id].icon}
                <span className="label">{SECTIONS[id].label}</span>
              </button>
            </div>
          ))}
        </nav>
      </aside>
      <main className="page-scroll">
        <div className="page-body">{content}</div>
      </main>
    </div>
  );
}
