import {
  Brain,
  CircleUserRound,
  Database,
  FileCode,
  Paperclip,
  ScrollText,
  Shield,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ConfirmDialog } from "../components/Dialogs";
import { apiJson, queryKeys } from "../lib/query";
import { AttachmentSettings } from "../components/AttachmentSettings";
import { Overlay } from "../components/Overlay";
import { SkillsSettings } from "../components/SkillsSettings";
import { useAuth } from "../lib/auth-store";
import { paths } from "../lib/paths";
import { useSignOut } from "../lib/use-sign-out";
import type { Route } from "./+types/settings";

/** Settings → Memories (Phase 13b): loaded when its tab opens. */
const MemorySettings = lazy(() => import("../components/MemorySettings"));
/** Settings → Files (Phase 13c): loaded when its tab opens. */
const ArtifactSettings = lazy(() => import("../components/ArtifactSettings"));
/** Settings → Data (Phase 13d): export and import, loaded when its tab opens. */
const DataSettings = lazy(() => import("../components/DataSettings"));

export function meta(): Route.MetaDescriptors {
  return [{ title: "Settings · ChatUI" }];
}

const SECTIONS = ["account", "data", "skills", "memories", "files", "attachments"] as const;
type Section = (typeof SECTIONS)[number];

/**
 * Settings: a large panel with its sections listed on the left (Account;
 * Skills and Attachments under "Customize"). Only implemented features appear.
 */
export default function SettingsOverlay() {
  const user = useAuth().session?.user;
  const signOut = useSignOut();
  const isAdmin = user?.role === "admin";
  // `?section=` opens a tab directly (the account menu's "Import & export").
  const [params] = useSearchParams();
  const requested = params.get("section");
  const [section, setSection] = useState<Section>(
    SECTIONS.includes(requested as Section) ? (requested as Section) : "account",
  );
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
          {tab("data", "Data", <Database size={18} aria-hidden />)}
          {isAdmin ? (
            // Intent prefetch of the admin chunk, only for admins (Phase 9 rules).
            <Link to={paths.admin()} className="nav-row" prefetch="intent">
              <Shield size={18} aria-hidden /> Administration
            </Link>
          ) : null}
          <p className="section-label">Customize</p>
          {tab("skills", "Skills", <ScrollText size={18} aria-hidden />)}
          {tab("memories", "Memories", <Brain size={18} aria-hidden />)}
          {tab("files", "Files", <FileCode size={18} aria-hidden />)}
          {tab("attachments", "Attachments", <Paperclip size={18} aria-hidden />)}
        </nav>
        {section === "data" && user ? (
          <Suspense
            fallback={
              <section className="settings-body">
                <p className="settings-hint">Loading…</p>
              </section>
            }
          >
            <DataSettings userId={user.id} />
          </Suspense>
        ) : section === "skills" && user ? (
          <SkillsSettings userId={user.id} />
        ) : section === "memories" && user ? (
          <Suspense
            fallback={
              <section className="settings-body">
                <p className="settings-hint">Loading memories…</p>
              </section>
            }
          >
            <MemorySettings userId={user.id} />
          </Suspense>
        ) : section === "files" && user ? (
          <Suspense
            fallback={
              <section className="settings-body">
                <p className="settings-hint">Loading files…</p>
              </section>
            }
          >
            <ArtifactSettings userId={user.id} />
          </Suspense>
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
            {user ? <ClearHistory userId={user.id} /> : null}
          </section>
        )}
      </div>
    </Overlay>
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
