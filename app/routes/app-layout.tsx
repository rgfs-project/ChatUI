import { HydrationBoundary, useQuery } from "@tanstack/react-query";
import { useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  data,
  Outlet,
  redirect,
  useLocation,
  useMatches,
  useNavigate,
  useParams,
} from "react-router";
import type { SessionDto } from "@shared/auth";
import type { ConversationResult } from "@shared/conversations";
import type { ProviderModelsDto } from "@shared/generations";
import { ChatProvider } from "../chat/chat-context";
import { ChatView } from "../chat/chat-view";
import { RenameDialog } from "../chat/rename-dialog";
import { Sidebar } from "../chat/sidebar";
import { appContext } from "../context";
import { conversationIdOfPath, overlayBackground, paths } from "../lib/paths";
import { dehydrateAllowed, getBrowserQueryClient, makeQueryClient } from "../lib/query/client";
import { qk } from "../lib/query/keys";
import {
  conversationQuery,
  conversationsQuery,
  modelsQuery,
  preferencesQuery,
  sessionQuery,
} from "../lib/query/queries";
import { useRenderProbe } from "../lib/render-probe";
import { useUi } from "../lib/ui-context";
import { ConfirmProvider } from "../ui/dialog";
import { ToastProvider } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import type { Route } from "./+types/app-layout";

/** SSR waits this long for model discovery, then renders without it. */
const MODEL_DISCOVERY_BUDGET_MS = 2_500;
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
        queryFn: () => services.bootstrap.conversations(userId),
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
        queryKey: qk.models(userId),
        queryFn: (): Promise<ProviderModelsDto[]> =>
          withBudget(services.models.listModels(), MODEL_DISCOVERY_BUDGET_MS),
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

  // Picking something in the narrow overlay sidebar closes it.
  useEffect(() => {
    closeNarrow();
  }, [location.pathname, closeNarrow]);

  // Global shortcuts; Ctrl/Cmd+A selects only the conversation, not the chrome.
  function onKeyDown(event: ReactKeyboardEvent) {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (event.shiftKey && key === "o") {
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

  // The guard resolved signed-out (logout, expiry, account change in progress).
  if (!user) return null;

  return (
    <ChatProvider user={user} conversationId={conversationId}>
      <div
        className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}${narrowOpen ? " narrow-open" : ""}`}
        onKeyDown={onKeyDown}
      >
        <Sidebar />
        {narrowOpen ? (
          <div
            className="narrow-backdrop"
            aria-hidden
            onClick={() => {
              closeNarrow();
            }}
          />
        ) : null}
        <main className="main">{kind === "page" ? <Outlet /> : <ChatView />}</main>
      </div>
      {kind === "overlay" ? <Outlet /> : null}
      <RenameDialog />
    </ChatProvider>
  );
}
