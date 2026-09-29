import { HydrationBoundary } from "@tanstack/react-query";
import { PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { useState } from "react";
import { Link, Outlet, redirect, useLocation, useMatches } from "react-router";
import { Sidebar } from "../components/Sidebar";
import { ConversationView } from "../components/ConversationView";
import { appContext } from "../context";
import { documentPathOf, paths, type OverlayState } from "../lib/paths";
import { queryKeys } from "../lib/query";
import { prefetchForRequest } from "../lib/server-query";
import { ShellProvider } from "../lib/shell-context";
import type { Route } from "./+types/app-layout";

/** Secondary data never blocks the shell: model discovery gets a time budget. */
const MODEL_BUDGET_MS = 2_500;

export function meta(): Route.MetaDescriptors {
  return [{ title: "ChatUI" }];
}

/**
 * Shared auth guard for every protected route (INV-53, INV-54): identity comes
 * from the server-side session only; signed-out requests are redirected with
 * a validated return-to before anything private is read.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { services, auth } = context.get(appContext);
  if (!auth) throw redirect(paths.login(documentPathOf(request.url)));
  const userId = auth.userId;
  const dehydratedState = await prefetchForRequest(async (client) => {
    client.setQueryData(
      queryKeys.conversations(userId),
      services.conversations.list(userId).map((e) => ({
        id: e.id,
        title: e.title,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        messageCount: e.messageCount,
        malformed: e.malformed,
      })),
    );
    const models = await Promise.race([
      services.models.listModels().then((providers) => ({ providers })),
      new Promise<null>((resolve) => {
        setTimeout(() => {
          resolve(null);
        }, MODEL_BUDGET_MS).unref();
      }),
    ]).catch(() => null);
    if (models) client.setQueryData(queryKeys.models(userId), models);
  });
  return {
    dehydratedState,
    user: { id: userId, username: auth.username, role: auth.role },
  };
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const matches = useMatches();
  const overlay = matches.some((m) => /routes\/(settings|admin)$/.test(m.id));
  const background = (location.state as OverlayState | null)?.background;
  const backgroundId = background?.startsWith("/chat/")
    ? decodeURIComponent(background.slice(6))
    : undefined;

  return (
    <HydrationBoundary state={loaderData.dehydratedState}>
      <ShellProvider>
        <div
          className={`app-shell${collapsed ? " sidebar-collapsed" : ""}`}
          data-testid="app-shell"
        >
          <header className="app-header">
            <button
              type="button"
              className="icon-button"
              aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
              aria-expanded={!collapsed}
              aria-controls="sidebar"
              title={collapsed ? "Show sidebar" : "Hide sidebar"}
              onClick={() => {
                setCollapsed((c) => !c);
              }}
            >
              {collapsed ? (
                <PanelLeftOpen size={18} aria-hidden />
              ) : (
                <PanelLeftClose size={18} aria-hidden />
              )}
            </button>
            <Link to={paths.newChat()} className="brand">
              ChatUI
            </Link>
            <span className="header-spacer" />
            <span className="header-user" data-testid="signed-in-user">
              {loaderData.user.username}
            </span>
            <Link
              to={paths.settings()}
              state={
                { background: overlay ? background : location.pathname } satisfies OverlayState
              }
              className="icon-button"
              aria-label="Settings"
              title="Settings"
            >
              <Settings size={18} aria-hidden />
            </Link>
          </header>
          <Sidebar userId={loaderData.user.id} hidden={collapsed} />
          <div className="app-main">
            {overlay ? (
              <>
                {/* URL-backed overlay: the previous conversation stays behind it. */}
                <ConversationView
                  key={backgroundId ?? "new"}
                  userId={loaderData.user.id}
                  conversationId={backgroundId}
                  inert
                />
                <Outlet />
              </>
            ) : (
              <Outlet />
            )}
          </div>
        </div>
      </ShellProvider>
    </HydrationBoundary>
  );
}
