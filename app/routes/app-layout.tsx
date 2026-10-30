import { HydrationBoundary, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  data,
  Outlet,
  redirect,
  useLocation,
  useMatches,
  useNavigate,
  useParams,
  useRevalidator,
} from "react-router";
import type { SessionDto } from "@shared/auth";
import type { ConversationResult } from "@shared/conversations";
import type { ProviderModelsDto } from "@shared/generations";
import { ChatProvider } from "../chat/chat-context";
import { ChatView } from "../chat/chat-view";
import { ConversationOpsProvider } from "../chat/conversation-ops";
import { OPEN_SEARCH_EVENT } from "../chat/search-events";
import { OPEN_ARTIFACT_EVENT } from "../chat/artifact-events";
import { Drawer } from "../chat/drawer";
import { ReauthDialog } from "../chat/reauth";
import { RenameDialog } from "../chat/rename-dialog";
import { Sidebar } from "../chat/sidebar";
import { appContext } from "../context";
import { SESSION_EXPIRED_EVENT } from "../lib/api";
import { conversationIdOfPath, overlayBackground, paths } from "../lib/paths";
import { dehydrateAllowed, getBrowserQueryClient, makeQueryClient } from "../lib/query/client";
import { qk } from "../lib/query/keys";
import {
  conversationQuery,
  conversationsQuery,
  instanceQuery,
  profileQuery,
  modelsQuery,
  preferencesQuery,
  sessionQuery,
} from "../lib/query/queries";
import { useRenderProbe } from "../lib/render-probe";
import { purgeUserCache } from "../lib/session";
import { useUi } from "../lib/ui-context";
import { ErrorBoundary as AreaBoundary } from "../ui/error-boundary";
import { ConfirmProvider } from "../ui/dialog";
import { ToastProvider } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import type { Route } from "./+types/app-layout";

/** Search is its own chunk: the chat page never loads it until it opens (Phase 13a). */
const SearchDialog = lazy(() => import("../chat/search-dialog"));
const SourcePanel = lazy(() => import("../chat/source-panel"));

/**
 * Startup dependency graph (Phase 8). Critical, awaited concurrently: the
 * session (root loader), the URL's conversation, preferences and models
 * (bounded by the discovery budget). Secondary: the conversation list, which
 * gets a short budget so it can never hold up the shell and composer.
 */
const MODEL_DISCOVERY_BUDGET_MS = 2_500;
const SECONDARY_BUDGET_MS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type RouteKind = "chat" | "overlay" | "page";

/** Failed prefetches are not dehydrated; the browser fetches them itself. */
const noop = () => undefined;

function withBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error("model discovery budget exceeded"));
      }, ms).unref();
    }),
  ]);
}

/**
 * Protected document: the session is validated before any private byte
 * (INV-54), then a request-scoped QueryClient is filled with the bounded
 * critical set and dehydrated through the allowlist (INV-55).
 */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  const { services, auth } = context.get(appContext);
  const url = new URL(request.url);
  if (!auth) throw redirect(paths.login(url.pathname + url.search));
  const userId = auth.userId;
  const client = makeQueryClient();
  const id = params.conversationId;
  const tasks: Promise<unknown>[] = [
    client
      .query({
        queryKey: qk.conversations(userId),
        // Secondary (sidebar): never holds the document; the browser fetches it if late.
        queryFn: () =>
          withBudget(
            Promise.resolve(services.bootstrap.conversations(userId)),
            SECONDARY_BUDGET_MS,
          ),
      })
      .catch(noop),
    client
      .query({
        queryKey: qk.instance(userId),
        queryFn: () => Promise.resolve(services.bootstrap.instance()),
      })
      .catch(noop),
    client
      .query({
        queryKey: qk.preferences(userId),
        queryFn: () => services.bootstrap.preferences(userId),
      })
      .catch(noop),
    client
      .query({
        queryKey: qk.profile(userId),
        queryFn: () => services.bootstrap.profile(userId),
      })
      .catch(noop),
    client
      .query({
        queryKey: qk.models(userId),
        queryFn: (): Promise<ProviderModelsDto[]> =>
          withBudget(services.bootstrap.models(auth.role), MODEL_DISCOVERY_BUDGET_MS),
      })
      .catch(noop),
  ];
  if (id !== undefined) {
    const key = qk.conversation(userId, id);
    if (UUID.test(id)) {
      tasks.push(
        client
          .query({
            queryKey: key,
            queryFn: () => services.bootstrap.conversation(userId, id),
          })
          .catch(noop),
      );
    } else {
      const notFound: ConversationResult = { ok: false, code: "NOT_FOUND" };
      client.setQueryData(key, notFound);
    }
  }
  await Promise.all(tasks);
  const result =
    id === undefined
      ? undefined
      : client.getQueryData<ConversationResult>(qk.conversation(userId, id));
  // A missing chat is a data error with a real status, not an unmatched route (INV-57).
  const status = result && !result.ok ? (result.code === "NOT_FOUND" ? 404 : 422) : 200;
  return data({ dehydrated: dehydrateAllowed(client) }, { status });
}

/**
 * Navigations after hydration: TanStack Query is the only cache, so the
 * server loader is not called again. The guard uses the cached session.
 */
export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const client = getBrowserQueryClient();
  const session = client.getQueryData<SessionDto>(qk.session());
  const url = new URL(request.url);
  if (!session?.user) throw redirect(paths.login(url.pathname + url.search));
  const userId = session.user.id;
  void client.query(conversationsQuery(userId)).catch(noop);
  void client.query(modelsQuery(userId)).catch(noop);
  void client.query(preferencesQuery(userId)).catch(noop);
  void client.query(instanceQuery(userId)).catch(noop);
  void client.query(profileQuery(userId)).catch(noop);
  // The active conversation is critical: navigation completes once it is known.
  // (An overlay's background conversation is already cached: it was just open.)
  const id = params.conversationId;
  if (id) await client.query({ ...conversationQuery(userId, id), staleTime: "static" }).catch(noop);
  return { dehydrated: null };
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  return (
    <HydrationBoundary state={loaderData.dehydrated}>
      <TooltipProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Shell />
          </ConfirmProvider>
        </ToastProvider>
      </TooltipProvider>
    </HydrationBoundary>
  );
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** The persistent shell: never remounted by navigation, overlays or streaming (INV-32, INV-53). */
function Shell() {
  useRenderProbe("Shell");
  const { data: session } = useQuery({ ...sessionQuery(), enabled: false });
  const user = session?.user ?? null;
  const location = useLocation();
  const params = useParams();
  const matches = useMatches();
  const navigate = useNavigate();
  const { sidebarCollapsed, narrowOpen, closeNarrow, setSidebarOpen } = useUi();
  const kind: RouteKind =
    (matches.at(-1)?.handle as { kind?: RouteKind } | undefined)?.kind ?? "page";
  const background = kind === "overlay" ? overlayBackground(location.state) : undefined;
  const conversationId =
    kind === "chat"
      ? (params.conversationId ?? null)
      : background
        ? (conversationIdOfPath(background) ?? null)
        : null;

  // Session expired mid-use: the chat surfaces (and their queries) step aside
  // for the re-authentication dialog; drafts stay in tab memory (contracts §12).
  const client = useQueryClient();
  const [expired, setExpired] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      setArtifactId((event as CustomEvent<{ id: string }>).detail.id);
    };
    window.addEventListener(OPEN_ARTIFACT_EVENT, open);
    return () => {
      window.removeEventListener(OPEN_ARTIFACT_EVENT, open);
    };
  }, []);
  useEffect(() => {
    const open = () => {
      setSearchOpen(true);
    };
    window.addEventListener(OPEN_SEARCH_EVENT, open);
    return () => {
      window.removeEventListener(OPEN_SEARCH_EVENT, open);
    };
  }, []);
  useEffect(() => {
    const onExpired = (event: Event) => {
      if ((event as CustomEvent<{ userId: string }>).detail.userId !== user?.id) return;
      purgeUserCache(client);
      setExpired(true);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    };
  }, [client, user?.id]);

  // Picking something in the narrow overlay sidebar closes it.
  useEffect(() => {
    closeNarrow();
  }, [location.pathname, closeNarrow]);

  // Global shortcuts; Ctrl/Cmd+A selects only the conversation, not the chrome.
  function onKeyDown(event: ReactKeyboardEvent | KeyboardEvent) {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (!event.shiftKey && key === "k") {
      event.preventDefault();
      setSearchOpen(true);
    } else if (event.shiftKey && key === "o") {
      event.preventDefault();
      void navigate(paths.newChat());
    } else if (event.shiftKey && key === "s") {
      event.preventDefault();
      setSidebarOpen(sidebarCollapsed);
    } else if (!event.shiftKey && key === "a" && !isTyping(event.target)) {
      const thread = document.querySelector('[data-testid="transcript"]');
      const selection = window.getSelection();
      if (!thread || !selection) return;
      event.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(thread);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  // With nothing focused (after a page load or a click on blank space) keys go
  // to the body, outside the app element: the shortcuts still apply there.
  const shortcuts = useRef(onKeyDown);
  useLayoutEffect(() => {
    shortcuts.current = expired ? () => undefined : onKeyDown;
  });
  useEffect(() => {
    const onBodyKey = (event: KeyboardEvent) => {
      if (event.target === document.body) shortcuts.current(event);
    };
    window.addEventListener("keydown", onBodyKey);
    return () => {
      window.removeEventListener("keydown", onBodyKey);
    };
  }, []);

  // The guard resolved signed-out (logout, account change in progress).
  if (!user) return null;
  if (expired) {
    return (
      <div className="app">
        <ReauthDialog
          user={user}
          onRestored={() => {
            setExpired(false);
          }}
        />
      </div>
    );
  }

  return (
    <ChatProvider user={user} conversationId={conversationId}>
      <ConversationOpsProvider>
        <div
          className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}${narrowOpen ? " narrow-open" : ""}`}
          onKeyDown={onKeyDown}
        >
          <AreaBoundary
            area="Sidebar"
            className="sidebar"
            onRetry={() => {
              void client.invalidateQueries({ queryKey: qk.conversations(user.id) });
            }}
          >
            <Sidebar />
          </AreaBoundary>
          <Drawer />
          <main className="main">{kind === "page" ? <Outlet /> : <ChatView />}</main>
        </div>
        {kind === "overlay" ? <Outlet /> : null}
        <RenameDialog />
        {searchOpen ? (
          <Suspense fallback={null}>
            <SearchDialog
              onClose={() => {
                setSearchOpen(false);
              }}
            />
          </Suspense>
        ) : null}
        {artifactId ? (
          <Suspense fallback={null}>
            <SourcePanel
              key={artifactId}
              id={artifactId}
              onClose={() => {
                setArtifactId(null);
              }}
            />
          </Suspense>
        ) : null}
      </ConversationOpsProvider>
    </ChatProvider>
  );
}

/** Shell-level failure: the protected layout itself could not load or render. */
export function ErrorBoundary() {
  const revalidator = useRevalidator();
  return (
    <main className="auth">
      <title>Something went wrong · ChatUI</title>
      <div className="auth-card error-card" role="alert">
        <h1>Something went wrong</h1>
        <p className="auth-note">ChatUI could not load this page.</p>
        <button
          type="button"
          className="pill-button pill-primary"
          onClick={() => {
            void revalidator.revalidate();
          }}
        >
          Retry
        </button>
      </div>
    </main>
  );
}
