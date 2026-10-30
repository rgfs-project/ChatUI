import { Cpu, ScrollText, Server, Settings2, Users, Wrench } from "lucide-react";
import { data, useLocation, useNavigate, useParams } from "react-router";
import { InstanceSection, AuditSection, MaintenanceSection } from "../admin/instance";
import { ModelsSection } from "../admin/models";
import { ProvidersSection } from "../admin/providers";
import { UsersSection } from "../admin/users";
import { OverlayDialog } from "../chat/overlay";
import { appContext } from "../context";
import { paths } from "../lib/paths";
import { SettingsPage } from "../settings/page-layout";
import type { Route } from "./+types/admin";

export const handle = { kind: "overlay" };

/**
 * Administration (Phase 10): a lazily loaded route chunk; chat startup never
 * loads it or calls admin APIs. The server decides access (never the browser):
 * anyone else gets the same 404 as an unknown page, and every admin API checks
 * the role again (INV-24).
 */
export function loader({ context }: Route.LoaderArgs) {
  const { auth } = context.get(appContext);
  const admin = auth?.role === "admin";
  return data({ admin }, { status: admin ? 200 : 404 });
}

const SECTIONS = [
  {
    id: "users",
    label: "Accounts",
    icon: <Users size={18} aria-hidden />,
    render: () => <UsersSection />,
  },
  {
    id: "providers",
    label: "Providers",
    icon: <Server size={18} aria-hidden />,
    render: () => <ProvidersSection />,
  },
  {
    id: "models",
    label: "Models",
    icon: <Cpu size={18} aria-hidden />,
    render: () => <ModelsSection />,
  },
  {
    id: "instance",
    label: "Instance",
    icon: <Settings2 size={18} aria-hidden />,
    render: () => <InstanceSection />,
  },
  {
    id: "maintenance",
    label: "Maintenance",
    icon: <Wrench size={18} aria-hidden />,
    render: () => <MaintenanceSection />,
  },
  {
    id: "audit",
    label: "Audit log",
    icon: <ScrollText size={18} aria-hidden />,
    render: () => <AuditSection />,
  },
] as const;

export default function Admin({ loaderData }: Route.ComponentProps) {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  if (!loaderData.admin) {
    return (
      <OverlayDialog title="Page not found">
        <p className="dialog-body">The page you requested does not exist.</p>
      </OverlayDialog>
    );
  }
  const current = SECTIONS.find((s) => s.id === params.section) ?? SECTIONS[0];
  return (
    <OverlayDialog title="Administration" className="settings-dialog" page>
      <SettingsPage
        title="Administration"
        navLabel="Administration sections"
        items={SECTIONS}
        current={current.id}
        wide
        onSelect={(id) => {
          void navigate(paths.admin(id), {
            replace: true,
            state: location.state as unknown,
          });
        }}
      >
        <h2 id="settings-section-title" className="settings-title">
          {current.label}
        </h2>
        <div className="admin-panel">{current.render()}</div>
      </SettingsPage>
    </OverlayDialog>
  );
}
