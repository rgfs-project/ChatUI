import {
  HydrationBoundary,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
  type LinksFunction,
} from "react-router";
import type { Route } from "./+types/root";
import { appContext } from "./context";
import { setSession } from "./lib/api";
import { DEFAULT_APPEARANCE, htmlAttributes } from "./lib/appearance";
import { paths } from "./lib/paths";
import { dehydrateAllowed, getBrowserQueryClient, makeQueryClient } from "./lib/query/client";
import { qk } from "./lib/query/keys";
import { sessionQuery } from "./lib/query/queries";
import { UiProvider } from "./lib/ui-context";
import { readUiHints } from "./lib/ui-cookies";
import stylesheet from "./app.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: stylesheet },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

/**
 * Browser-safe session bootstrap, rendered into private no-store HTML (§5),
 * seeded into a QueryClient created for this request only (INV-55).
 */
export function loader({ context, request }: Route.LoaderArgs) {
  const { services, auth } = context.get(appContext);
  const client = makeQueryClient();
  client.setQueryData(qk.session(), services.auth.sessionDto(auth));
  return {
    dehydrated: dehydrateAllowed(client),
    hints: readUiHints(request),
    renderedAt: new Date().toISOString(),
  };
}

/** After hydration the session lives in the query cache; the root never refetches. */
export function shouldRevalidate() {
  return false;
}

export function Layout({ children }: { children: ReactNode }) {
  // Error documents may have no root data: they fall back to the defaults.
  const data = useRouteLoaderData<typeof loader>("root");
  const appearance = data?.hints.appearance ?? DEFAULT_APPEARANCE;
  return (
    <html
      lang="en"
      {...htmlAttributes(appearance)}
      {...(data?.hints.phone ? { "data-phone": "" } : {})}
    >
      <head>
        <meta charSet="utf-8" />
        {/* The on-screen keyboard resizes the layout, so 100dvh keeps the composer visible. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
        />
        <meta name="color-scheme" content="light dark" />
        <Meta />
        {/* Stylesheets need no nonce (style-src 'self'). An explicit empty nonce keeps
            server and client markup identical: browsers hide nonce values from the
            DOM, so a server-only nonce would be a hydration mismatch. */}
        <Links nonce="" />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/** Marks the document once React has hydrated; used by `verify` and tests. */
function useHydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
}

/** Keeps the shared fetch adapter's identity in step with the session query. */
function SessionSync() {
  const client = useQueryClient();
  const { data } = useQuery({ ...sessionQuery(), enabled: false });
  useEffect(() => {
    if (data) setSession(data);
  }, [client, data]);
  return null;
}

export default function App({ loaderData }: Route.ComponentProps) {
  useHydrationMarker();
  // The browser has one QueryClient; each server render gets a fresh one (INV-55).
  const [client] = useState(() =>
    typeof window === "undefined" ? makeQueryClient() : getBrowserQueryClient(),
  );
  return (
    <QueryClientProvider client={client}>
      <HydrationBoundary state={loaderData.dehydrated}>
        <UiProvider hints={loaderData.hints} renderedAt={loaderData.renderedAt}>
          <SessionSync />
          <Outlet />
        </UiProvider>
      </HydrationBoundary>
    </QueryClientProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  useHydrationMarker();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const title = notFound ? "Page not found" : "Something went wrong";
  const message = notFound
    ? "The page you requested does not exist."
    : "An unexpected error occurred. Please try again.";
  return (
    <main className="auth">
      <title>{`${title} · ChatUI`}</title>
      <div className="auth-card error-card">
        <p className="error-code" aria-hidden>
          {notFound ? "404" : "500"}
        </p>
        <h1>{title}</h1>
        <p className="auth-note">{message}</p>
        <a className="pill-button pill-primary" href={paths.newChat()}>
          Go to ChatUI
        </a>
      </div>
    </main>
  );
}
