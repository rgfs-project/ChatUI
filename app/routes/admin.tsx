import { Cpu, ScrollText, Server, Settings2, Users, Wrench } from "lucide-react";
import { data, useLocation, useNavigate, useParams } from "react-router";
import { InstanceSection, AuditSection, MaintenanceSection } from "../admin/instance";
import { ModelsSection } from "../admin/models";
import { ProvidersSection } from "../admin/providers";
import { UsersSection } from "../admin/users";
import { OverlayDialog } from "../chat/overlay";
import { appContext } from "../context";
import { paths } from "../lib/paths";
import { AdminPage } from "../admin/layout";
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
    description: "Who can sign in, their role, and whether the account is active.",
    icon: <Users size={18} aria-hidden />,
    render: () => <UsersSection />,
  },
  {
    id: "providers",
    label: "Providers",
    description: "The model servers this instance talks to.",
    icon: <Server size={18} aria-hidden />,
    render: () => <ProvidersSection />,
  },
  {
    id: "models",
    label: "Models",
    description: "Which models members can choose, and their defaults.",
    icon: <Cpu size={18} aria-hidden />,
    render: () => <ModelsSection />,
  },
  {
    id: "instance",
    label: "Instance",
    description: "The notice everyone sees and the default model for new chats.",
    icon: <Settings2 size={18} aria-hidden />,
    render: () => <InstanceSection />,
  },
  {
    id: "maintenance",
    label: "Maintenance",
    description: "Rebuild chat indexes and refresh model discovery.",
    icon: <Wrench size={18} aria-hidden />,
    render: () => <MaintenanceSection />,
  },
  {
    id: "audit",
    label: "Audit log",
    description: "Every administrative change, newest first.",
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
    <OverlayDialog title="Administration" className="settings-dialog admin-dialog-page" page>
      <AdminPage
        items={SECTIONS}
        current={current}
        onSelect={(id) => {
          void navigate(paths.admin(id), {
            replace: true,
            state: location.state as unknown,
          });
        }}
      >
        {current.render()}
      </AdminPage>
    </OverlayDialog>
  );
}
