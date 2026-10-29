import { data } from "react-router";
import { OverlayDialog } from "../chat/overlay";
import { appContext } from "../context";
import type { Route } from "./+types/admin";

export const handle = { kind: "overlay" };

/**
 * Reserved until Phase 10. The server decides admin access (never the
 * browser): anyone else gets the same 404 as an unknown page.
 */
export function loader({ context }: Route.LoaderArgs) {
  const { auth } = context.get(appContext);
  const admin = auth?.role === "admin";
  return data({ admin }, { status: admin ? 200 : 404 });
}

export default function Admin({ loaderData }: Route.ComponentProps) {
  if (!loaderData.admin) {
    return (
      <OverlayDialog title="Page not found">
        <p className="dialog-body">The page you requested does not exist.</p>
      </OverlayDialog>
    );
  }
  return (
    <OverlayDialog title="Administration">
      <p className="dialog-body">
        Administration (accounts, providers, models and instance settings) is not available yet.
      </p>
    </OverlayDialog>
  );
}
