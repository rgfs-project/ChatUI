import { HydrationBoundary, QueryClientProvider } from "@tanstack/react-query";
import { PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Link,
  Outlet,
  redirect,
  useLocation,
  useMatches,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import { ConversationView } from "../components/ConversationView";
import { SectionBoundary } from "../components/SectionBoundary";
import { Sidebar } from "../components/Sidebar";
import { SignedOutShell } from "../components/SignedOutShell";
import { appContext } from "../context";
import { useAuth } from "../lib/auth-store";
import { useNarrow } from "../lib/use-media-query";
import { documentPathOf, paths, type OverlayState } from "../lib/paths";
import { getQueryClient, queryKeys } from "../lib/query";
import { prefetchForRequest } from "../lib/server-query";
import { ShellProvider } from "../lib/shell-context";
import { useAccountBoundary } from "../lib/use-account-boundary";
import type { Route } from "./+types/app-layout";

/** Model state is critical (it validates the selection) but gets a time budget. */
const MODEL_BUDGET_MS = 2_500;

export function meta(): Route.MetaDescriptors {
  return [{ title: "ChatUI" }];
}

/**
 * Shared auth guard for every protected route (INV-53, INV-54): identity comes
 * from the server-side session only; signed-out requests are redirected with
 * a validated return-to before anything private is read.
 *
 * Startup graph (contracts §9.2): the session is resolved by middleware
 * before any loader; this loader (models, critical, bounded) and the child
 * route's loader (the active conversation with its active generation,
 * critical) then run concurrently. The conversation list is secondary: it is
 * never awaited here, the sidebar loads it after hydration.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { services, auth } = context.get(appContext);
  if (!auth) throw redirect(paths.login(documentPathOf(request.url)));
  const userId = auth.userId;
  const dehydratedState = await prefetchForRequest(async (client) => {
    const models = await Promise.race([
      services.modelList(auth.role),
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

/**
 * Inside the shell, client navigations reuse the Query cache instead of
 * re-running this guard: an expired session surfaces as a 401 from the data
 * it needs, which opens the re-authentication dialog without a document
 * navigation. Explicit revalidation (after re-authentication) still runs it.
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod || currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  return false;
}

/**
 * The chat shell owns TanStack Query: the page's one browser QueryClient (a
 * module singleton, so it survives the shell remounting) or, on the server, a
 * fresh client per request.
 */
export default function AppLayout(props: Route.ComponentProps) {
  const [queryClient] = useState(getQueryClient);
  // Account boundary: a changed account purges the previous user's cache.
  useAccountBoundary(queryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <Shell {...props} />
    </QueryClientProvider>
  );
}

// The drawer (Radix Dialog + the sidebar) loads on demand, never in the critical bundle.
const loadDrawer = () => import("../components/SidebarDrawer");
const SidebarDrawer = lazy(loadDrawer);

function Shell({ loaderData }: Route.ComponentProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Mounted after first use so it can restore focus when it closes.
  const [drawerUsed, setDrawerUsed] = useState(false);
  const drawerTrigger = useRef<HTMLButtonElement>(null);
  const narrow = useNarrow();
  const drawerShown = narrow && drawerOpen;
  const location = useLocation();
  // Navigating (e.g. picking a conversation in the drawer) closes the drawer.
  const [drawerPath, setDrawerPath] = useState(location.pathname);
  if (drawerPath !== location.pathname) {
    setDrawerPath(location.pathname);
    setDrawerOpen(false);
  }
  useVisualViewportHeight();
  const matches = useMatches();
  const auth = useAuth();
  const overlay = matches.some((m) => /routes\/(settings|admin)$/.test(m.id));
  const background = (location.state as OverlayState | null)?.background;
  const backgroundId = background?.startsWith("/chat/")
    ? decodeURIComponent(background.slice(6))
    : undefined;
  // The account the tab belongs to (kept through an expiry). Shell state
  // (drafts, model choices) is scoped to it: another account remounts it.
  const account = auth.expired?.userId ?? auth.session?.user?.id ?? loaderData.user.id;
  const user = auth.session?.user ?? null;
  const signedIn = auth.status === "authenticated" && user !== null;

  return (
    <HydrationBoundary state={loaderData.dehydratedState}>
      <ShellProvider key={account}>
        <div
          className={`app-shell${collapsed ? " sidebar-collapsed" : ""}`}
          data-testid="app-shell"
          data-auth={auth.status}
        >
          <header className="app-header">
            <button
              ref={drawerTrigger}
              type="button"
              className="icon-button"
              aria-label={
                narrow ? "Open conversations" : collapsed ? "Show sidebar" : "Hide sidebar"
              }
              aria-expanded={narrow ? drawerShown : !collapsed}
              aria-controls={narrow ? undefined : "sidebar"}
              aria-haspopup={narrow ? "dialog" : undefined}
              title={narrow ? "Conversations" : collapsed ? "Show sidebar" : "Hide sidebar"}
              // Warm the drawer chunk on intent (touch or mouse), never required.
              onPointerDown={() => void loadDrawer()}
              onFocus={() => {
                if (narrow) void loadDrawer();
              }}
              onClick={() => {
                if (narrow) {
                  setDrawerUsed(true);
                  setDrawerOpen(true);
                } else setCollapsed((c) => !c);
              }}
            >
              {collapsed || narrow ? (
                <PanelLeftOpen size={18} aria-hidden />
              ) : (
                <PanelLeftClose size={18} aria-hidden />
              )}
            </button>
            <Link to={paths.newChat()} className="brand">
              ChatUI
            </Link>
            <span className="header-spacer" />
            {signedIn ? (
              <>
                <span className="header-user" data-testid="signed-in-user">
                  {user.username}
                </span>
                <Link
                  to={paths.settings()}
                  prefetch="intent"
                  state={
                    { background: overlay ? background : location.pathname } satisfies OverlayState
                  }
                  className="icon-button"
                  aria-label="Settings"
                  title="Settings"
                >
                  <Settings size={18} aria-hidden />
                </Link>
              </>
            ) : null}
          </header>
          {signedIn ? (
            <>
              <SectionBoundary
                label="The conversation list"
                resetKeys={[user.id]}
                queryKey={queryKeys.conversations(user.id)}
                className="sidebar"
              >
                <Sidebar userId={user.id} hidden={collapsed} />
              </SectionBoundary>
              {narrow && drawerUsed ? (
                <Suspense fallback={null}>
                  <SidebarDrawer
                    userId={user.id}
                    open={drawerShown}
                    onOpenChange={setDrawerOpen}
                    returnFocus={() => drawerTrigger.current}
                  />
                </Suspense>
              ) : null}
              {/* The background is inert while the drawer is open. */}
              <div className="app-main" inert={drawerShown}>
                <SectionBoundary
                  label="This conversation"
                  resetKeys={[location.pathname]}
                  queryKey={["user", user.id]}
                >
                  {overlay ? (
                    <>
                      {/* URL-backed overlay: the previous conversation stays behind it. */}
                      <ConversationView
                        key={backgroundId ?? "new"}
                        userId={user.id}
                        conversationId={backgroundId}
                        inert
                      />
                      <Outlet />
                    </>
                  ) : (
                    <Outlet />
                  )}
                </SectionBoundary>
              </div>
            </>
          ) : (
            <SignedOutShell
              expired={auth.status === "unauthenticated" ? auth.expired : null}
              unknown={auth.status === "unknown"}
            />
          )}
        </div>
      </ShellProvider>
    </HydrationBoundary>
  );
}

/** Shell-level failure (render error or failed guard): the route boundary. */
export function ErrorBoundary() {
  return (
    <main className="empty-state" role="alert" data-testid="shell-error">
      <h1>ChatUI couldn’t be displayed</h1>
      <p>Something went wrong while loading the app.</p>
      <button
        type="button"
        onClick={() => {
          window.location.reload();
        }}
      >
        Try again
      </button>
    </main>
  );
}

/**
 * iOS Safari ignores `interactive-widget=resizes-content`: its on-screen
 * keyboard overlays the page without shrinking the layout viewport, so
 * `100dvh` would hide the composer behind it. CSS can't express "the visible
 * height", so only in that case the visual viewport height is exposed as
 * `--app-height` (the shell's height). Where the layout viewport already
 * resizes (Chromium), innerHeight shrinks with it and nothing is set.
 */
function useVisualViewportHeight(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const update = () => {
      if (viewport.height < window.innerHeight - 1)
        root.style.setProperty("--app-height", `${String(Math.round(viewport.height))}px`);
      else root.style.removeProperty("--app-height");
    };
    viewport.addEventListener("resize", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      root.style.removeProperty("--app-height");
    };
  }, []);
}
