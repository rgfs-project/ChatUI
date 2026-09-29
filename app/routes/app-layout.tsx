import { HydrationBoundary } from "@tanstack/react-query";
import { PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { useState } from "react";
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
import { documentPathOf, paths, type OverlayState } from "../lib/paths";
import { queryKeys } from "../lib/query";
import { prefetchForRequest } from "../lib/server-query";
import { ShellProvider } from "../lib/shell-context";
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

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
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
            {signedIn ? (
              <>
                <span className="header-user" data-testid="signed-in-user">
                  {user.username}
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
              <div className="app-main">
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
