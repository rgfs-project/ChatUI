import { useEffect, type ReactNode } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  type LinksFunction,
} from "react-router";
import type { Route } from "./+types/root";
import { appContext } from "./context";
import { setSession } from "./lib/api";
import { markDocumentStart, markOnce, perfSummary } from "./lib/perf";
import stylesheet from "./app.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: stylesheet },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

/** Browser-safe session bootstrap, rendered into private no-store HTML (§5). */
export function loader({ context }: Route.LoaderArgs) {
  const { services, auth } = context.get(appContext);
  return { session: services.auth.sessionDto(auth) };
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        {/* resizes-content: the on-screen keyboard shrinks the layout viewport (and so
            100dvh), keeping the composer visible; viewport-fit=cover enables the
            safe-area insets used in app.css. */}
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

/** Marks the document once React has hydrated; used by `verify`, tests and perf marks. */
function useHydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
    markDocumentStart();
    markOnce("chatui:hydration-complete");
    // Development diagnostic: `chatuiPerf()` in the console lists marks and measures.
    if (import.meta.env.DEV)
      (window as unknown as { chatuiPerf?: typeof perfSummary }).chatuiPerf = perfSummary;
  }, []);
}

export default function App({ loaderData }: Route.ComponentProps) {
  useHydrationMarker();
  // Client-only: the shared fetch wrapper learns the session after hydration.
  useEffect(() => {
    setSession(loaderData.session);
  }, [loaderData.session]);
  // TanStack Query lives in the chat shell (routes/app-layout): public and
  // sign-in pages don't download it.
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  useHydrationMarker();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const title = notFound ? "Page not found" : "Something went wrong";
  const message = notFound
    ? "The page you requested does not exist."
    : "An unexpected error occurred. Please try again.";
  return (
    <main className="page">
      <title>{`${title} · ChatUI`}</title>
      <h1>{title}</h1>
      <p>{message}</p>
      <p>
        <a href="/">Return to the status page</a>
      </p>
    </main>
  );
}
