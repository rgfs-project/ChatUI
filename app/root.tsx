import { useEffect, type ReactNode } from "react";
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
import { reasoningShownFromCookieHeader } from "@shared/reasoning-display";
import { themeFromCookieHeader, type Theme } from "@shared/theme";
import type { Route } from "./+types/root";
import { appContext } from "./context";
import { sessionStore } from "./lib/session";
import stylesheet from "./app.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: stylesheet },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

/** The browser-safe session plus display hints, rendered into the first HTML. */
export function loader({ context, request }: Route.LoaderArgs) {
  const { services, auth } = context.get(appContext);
  const cookie = request.headers.get("cookie");
  return {
    session: services.auth.sessionDto(auth),
    theme: themeFromCookieHeader(cookie),
    reasoningShown: reasoningShownFromCookieHeader(cookie),
  };
}

export function Layout({ children }: { children: ReactNode }) {
  const root = useRouteLoaderData<typeof loader>("root");
  const theme: Theme = root?.theme ?? "system";
  return (
    <html
      lang="en"
      data-theme={theme === "system" ? undefined : theme}
      data-reasoning={root?.reasoningShown === false ? "hidden" : undefined}
    >
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
        />
        <meta name="color-scheme" content={theme === "system" ? "light dark" : theme} />
        <Meta />
        {/* An explicit empty nonce keeps server and client markup identical. */}
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

function useHydrated() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
}

export default function App({ loaderData }: Route.ComponentProps) {
  useHydrated();
  useEffect(() => {
    sessionStore.set(loaderData.session);
  }, [loaderData.session]);
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  useHydrated();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const title = notFound ? "Page not found" : "Something went wrong";
  return (
    <main className="center-page">
      <title>{`${title} · ChatUI`}</title>
      <div className="center-card">
        <h1>{title}</h1>
        <p className="muted">
          {notFound
            ? "The page you asked for doesn’t exist."
            : "An unexpected error occurred. Please try again."}
        </p>
        <a className="button primary" href="/">
          Go to ChatUI
        </a>
      </div>
    </main>
  );
}
