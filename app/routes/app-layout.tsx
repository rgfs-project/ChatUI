import { HydrationBoundary } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Outlet, redirect, useLocation, useMatches } from "react-router";
import { Sidebar } from "../components/Sidebar";
import { ConversationView } from "../components/ConversationView";
import { appContext } from "../context";
import { documentPathOf, paths, type OverlayState } from "../lib/paths";
import { queryKeys } from "../lib/query";
import { prefetchForRequest } from "../lib/server-query";
import { ShellProvider } from "../lib/shell-context";
import { SidebarProvider } from "../lib/sidebar-context";
import { NARROW_QUERY, useMediaQuery } from "../lib/use-media-query";
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
  // Wide screens: a column that can be hidden. Narrow screens: an overlay
  // drawer, closed by default and after choosing a destination.
  const narrow = useMediaQuery(NARROW_QUERY);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const matches = useMatches();
  const overlay = matches.some((m) => /routes\/(settings|admin)$/.test(m.id));
  const background = (location.state as OverlayState | null)?.background;
  const backgroundId = background?.startsWith("/chat/")
    ? decodeURIComponent(background.slice(6))
    : undefined;

  const sidebarVisible = narrow ? drawerOpen : !collapsed;
  const hide = useCallback(() => {
    if (narrow) setDrawerOpen(false);
    else setCollapsed(true);
  }, [narrow]);
  const show = useCallback(() => {
    if (narrow) setDrawerOpen(true);
    else setCollapsed(false);
  }, [narrow]);
  const afterNavigate = useCallback(() => {
    setDrawerOpen(false);
  }, []);
  const sidebarControls = useMemo(
    () => ({ visible: sidebarVisible, show }),
    [sidebarVisible, show],
  );

  return (
    <HydrationBoundary state={loaderData.dehydratedState}>
      <ShellProvider>
        <SidebarProvider value={sidebarControls}>
          <div
            className={`app-shell${sidebarVisible ? "" : " sidebar-collapsed"}`}
            data-testid="app-shell"
          >
            <Sidebar
              user={loaderData.user}
              hidden={!sidebarVisible}
              drawer={narrow}
              onHide={hide}
              onNavigate={afterNavigate}
            />
            {narrow && drawerOpen ? (
              <div className="drawer-backdrop" aria-hidden onClick={afterNavigate} />
            ) : null}
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
        </SidebarProvider>
      </ShellProvider>
    </HydrationBoundary>
  );
}
