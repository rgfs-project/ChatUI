import * as RadixDialog from "@radix-ui/react-dialog";
import {
  Brain,
  ChevronLeft,
  CircleUserRound,
  ClipboardList,
  Cpu,
  Database,
  FileCode,
  ScrollText,
  Search,
  Server,
  Settings,
  Settings2,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { SubPageContext } from "./parts";
import { CloseButton, IconButton } from "../components/ui";
import type { ShellUser } from "../lib/shell";
import { Account } from "./Account";
import { AdminAudit, AdminInstance, AdminMaintenance } from "./AdminInstance";
import { AdminModelsSection } from "./AdminModels";
import { AdminProviders } from "./AdminProviders";
import { AdminUsers } from "./AdminUsers";
import { Data } from "./Data";
import { Files } from "./Files";
import { General } from "./General";
import { Memories } from "./Memories";
import { Skills } from "./Skills";

interface SectionDef {
  id: string;
  title: string;
  group: "Settings" | "Customize" | "Administration";
  icon: LucideIcon;
  keywords: string;
  admin?: boolean;
  render: (user: ShellUser) => ReactNode;
}

export const SECTIONS: readonly SectionDef[] = [
  {
    id: "general",
    title: "General",
    group: "Settings",
    icon: Settings,
    keywords: "theme dark light appearance thought reasoning images audio shrink",
    render: (u) => <General userId={u.id} />,
  },
  {
    id: "account",
    title: "Account",
    group: "Settings",
    icon: CircleUserRound,
    keywords: "password sign out username delete all chats",
    render: (u) => <Account user={u} />,
  },
  {
    id: "data",
    title: "Data",
    group: "Settings",
    icon: Database,
    keywords: "export import archive claude duck backup",
    render: (u) => <Data userId={u.id} />,
  },
  {
    id: "skills",
    title: "Skills",
    group: "Customize",
    icon: ScrollText,
    keywords: "slash commands instructions",
    render: (u) => <Skills userId={u.id} />,
  },
  {
    id: "memories",
    title: "Memories",
    group: "Customize",
    icon: Brain,
    keywords: "notes remember",
    render: (u) => <Memories userId={u.id} />,
  },
  {
    id: "files",
    title: "Files",
    group: "Customize",
    icon: FileCode,
    keywords: "artifacts code source downloads",
    render: (u) => <Files userId={u.id} />,
  },
  {
    id: "users",
    title: "Users",
    group: "Administration",
    icon: Users,
    keywords: "accounts members roles",
    admin: true,
    render: (u) => <AdminUsers userId={u.id} />,
  },
  {
    id: "providers",
    title: "Providers",
    group: "Administration",
    icon: Server,
    keywords: "llama openai endpoint api key",
    admin: true,
    render: (u) => <AdminProviders userId={u.id} />,
  },
  {
    id: "models",
    title: "Models",
    group: "Administration",
    icon: Cpu,
    keywords: "temperature system prompt hidden sampling",
    admin: true,
    render: (u) => <AdminModelsSection userId={u.id} />,
  },
  {
    id: "instance",
    title: "Instance",
    group: "Administration",
    icon: Settings2,
    keywords: "registration default model limits attachments time zone",
    admin: true,
    render: (u) => <AdminInstance userId={u.id} />,
  },
  {
    id: "maintenance",
    title: "Maintenance",
    group: "Administration",
    icon: Wrench,
    keywords: "rebuild index",
    admin: true,
    render: () => <AdminMaintenance />,
  },
  {
    id: "audit",
    title: "Audit log",
    group: "Administration",
    icon: ClipboardList,
    keywords: "history changes",
    admin: true,
    render: (u) => <AdminAudit userId={u.id} />,
  },
];

export function sectionsFor(user: ShellUser) {
  return SECTIONS.filter((s) => !s.admin || user.role === "admin");
}

/**
 * Settings as one dialog: sections on the left (searchable), the open one on
 * the right. On small screens the sections become a row of tabs above it.
 */
export function SettingsDialog(props: {
  user: ShellUser;
  section: string | null;
  narrow: boolean;
  onSection: (id: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sub, setSub] = useState<{ title: string; onBack: () => void } | null>(null);
  const available = sectionsFor(props.user);
  const fallback = available[0] ?? null;
  const current = available.find((s) => s.id === props.section) ?? fallback;
  const q = query.trim().toLowerCase();
  const shown = q
    ? available.filter((s) => `${s.title} ${s.keywords}`.toLowerCase().includes(q))
    : available;
  const groups = (["Settings", "Customize", "Administration"] as const).filter((g) =>
    shown.some((s) => s.group === g),
  );
  const showContent = current !== null;

  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="scrim" />
        <RadixDialog.Content className="settings" aria-describedby={undefined}>
          <RadixDialog.Title className="sr-only">Settings</RadixDialog.Title>
          <div className="settings-top">
            <h2>Settings</h2>
            <CloseButton onClick={props.onClose} />
          </div>
          <div className="settings-side">
            <label className="settings-search">
              <Search size={18} aria-hidden />
              <span className="sr-only">Search settings</span>
              <input
                type="search"
                placeholder="Search settings"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
              />
            </label>
            <nav aria-label="Settings sections" className="settings-nav">
              {groups.map((g) => (
                <div key={g}>
                  <p className="settings-nav-group">{g}</p>
                  {shown
                    .filter((s) => s.group === g)
                    .map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="settings-nav-item"
                        aria-current={current?.id === s.id ? "page" : undefined}
                        onClick={() => {
                          props.onSection(s.id);
                        }}
                      >
                        <s.icon size={18} aria-hidden />
                        <span>{s.title}</span>
                      </button>
                    ))}
                </div>
              ))}
              {shown.length === 0 ? <p className="muted pad">No settings match.</p> : null}
            </nav>
          </div>
          {showContent ? (
            <div className="settings-main">
              <div className="settings-body" key={current.id}>
                <div className="settings-head">
                  {sub ? (
                    <IconButton label="Back" className="back" onClick={sub.onBack}>
                      <ChevronLeft size={20} aria-hidden />
                    </IconButton>
                  ) : null}
                  <h2>{sub?.title ?? current.title}</h2>
                  <CloseButton onClick={props.onClose} />
                </div>
                <SubPageContext.Provider value={setSub}>
                  {current.render(props.user)}
                </SubPageContext.Provider>
              </div>
            </div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
