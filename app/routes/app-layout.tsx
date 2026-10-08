import * as RadixDialog from "@radix-ui/react-dialog";
import { dehydrate, HydrationBoundary, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isRouteErrorResponse,
  Outlet,
  redirect,
  useLocation,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import { SearchDialog } from "../components/SearchDialog";
import { Rail, Sidebar } from "../components/Sidebar";
import { Dialog } from "../components/ui";
import { appContext } from "../context";
import { documentPathOf, paths } from "../lib/paths";
import { createQueryClient, getQueryClient, isDehydratable, keys } from "../lib/query";
import { useSessionState } from "../lib/session";
import { NARROW_QUERY, ShellProvider, useMediaQuery, type ShellControls } from "../lib/shell";
import type { Route } from "./+types/app-layout";

const MODEL_BUDGET_MS = 2_500;

export function meta(): Route.MetaDescriptors {
  return [{ title: "ChatUI" }];
}

/**
 * The guard for every signed-in page: identity comes from the server session
 * only; signed-out requests go to sign-in with a validated return-to. The
 * model list is rendered into the first HTML when it arrives in time.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { services, auth } = context.get(appContext);
  if (!auth) throw redirect(paths.login(documentPathOf(request.url)));
  const client = createQueryClient();
  const models = await Promise.race([
    services.modelList(auth.role),
    new Promise<null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, MODEL_BUDGET_MS).unref();
    }),
  ]).catch(() => null);
  if (models) client.setQueryData(keys.models(auth.userId), models);
  const dehydratedState = dehydrate(client, {
    shouldDehydrateQuery: (q) => q.state.status === "success" && isDehydratable(q.queryKey),
  });
  client.clear();
  return {
    dehydratedState,
    user: { id: auth.userId, username: auth.username, role: auth.role },
  };
}

/** Client navigations inside the shell reuse the cache instead of re-running the guard. */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod || currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  return false;
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const [client] = useState(getQueryClient);
  const { session, expired } = useSessionState();
  // Account boundary: another account signed in in another tab. Start clean.
  const sessionUser = session?.user?.id;
  useEffect(() => {
    if (sessionUser && sessionUser !== loaderData.user.id) window.location.reload();
  }, [sessionUser, loaderData.user.id]);
  return (
    <QueryClientProvider client={client}>
      <HydrationBoundary state={loaderData.dehydratedState}>
        <Shell user={loaderData.user} expired={expired} />
      </HydrationBoundary>
    </QueryClientProvider>
  );
}

function Shell(props: { user: Route.ComponentProps["loaderData"]["user"]; expired: boolean }) {
  const narrow = useMediaQuery(NARROW_QUERY);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const location = useLocation();

  // Navigating closes the drawer.
  const [path, setPath] = useState(location.pathname);
  if (path !== location.pathname) {
    setPath(location.pathname);
    setDrawerOpen(false);
  }

  const openSidebar = useCallback(() => {
    if (narrow) setDrawerOpen(true);
    else setSidebarOpen(true);
  }, [narrow]);
  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    setDrawerOpen(false);
  }, []);
  const openSearch = useCallback(() => {
    setDrawerOpen(false);
    setSearchOpen(true);
  }, []);

  // ⌘K / Ctrl+K opens search; ⇧⌘O starts a new chat.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const controls = useMemo<ShellControls>(
    () => ({
      user: props.user,
      narrow,
      sidebarOpen: !narrow && sidebarOpen,
      openSidebar,
      closeSidebar,
      openSearch,
    }),
    [props.user, narrow, sidebarOpen, openSidebar, closeSidebar, openSearch],
  );

  return (
    <ShellProvider value={controls}>
      <div className={`app${sidebarOpen ? "" : " sidebar-hidden"}`} data-testid="app-shell">
        {sidebarOpen ? (
          <div className="sidebar-column">
            <Sidebar onClose={closeSidebar} closeLabel="Close sidebar" />
          </div>
        ) : (
          <div className="rail-column">
            <Rail />
          </div>
        )}
        <RadixDialog.Root open={narrow && drawerOpen} onOpenChange={setDrawerOpen}>
          <RadixDialog.Portal>
            <RadixDialog.Overlay className="scrim drawer-scrim" />
            <RadixDialog.Content className="drawer" aria-describedby={undefined}>
              <RadixDialog.Title className="sr-only">Conversations</RadixDialog.Title>
              <Sidebar
                onClose={() => {
                  setDrawerOpen(false);
                }}
                closeLabel="Close conversations"
                onNavigate={() => {
                  setDrawerOpen(false);
                }}
              />
            </RadixDialog.Content>
          </RadixDialog.Portal>
        </RadixDialog.Root>
        <div className="main-column">
          <Outlet />
        </div>
        <SearchDialog userId={props.user.id} open={searchOpen} onOpenChange={setSearchOpen} />
        <Dialog
          open={props.expired}
          onOpenChange={() => undefined}
          title="Your session ended"
          description="Sign in again to keep going. Nothing you wrote here has been sent."
        >
          <div className="dialog-actions">
            <a className="button primary" href={paths.login(location.pathname + location.search)}>
              Sign in
            </a>
          </div>
        </Dialog>
      </div>
    </ShellProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  if (isRouteErrorResponse(error) && error.status === 404)
    return (
      <main className="center-page">
        <title>Page not found · ChatUI</title>
        <div className="center-card">
          <h1>Page not found</h1>
          <p className="muted">The page you asked for doesn’t exist.</p>
          <a className="button primary" href="/chat/new">
            New chat
          </a>
        </div>
      </main>
    );
  return (
    <main className="center-page" role="alert">
      <div className="center-card">
        <h1>ChatUI couldn’t be displayed</h1>
        <p className="muted">Something went wrong while loading the app.</p>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            window.location.reload();
          }}
        >
          Try again
        </button>
      </div>
    </main>
  );
}
