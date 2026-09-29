import { QueryErrorResetBoundary, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";

/** Dynamic import failures, as reported by Chromium, Firefox and Safari. */
export function isChunkLoadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
      error.message,
    )
  );
}

/**
 * Error boundary for one section of the shell (sidebar, transcript). A render
 * failure there leaves the rest of the app usable; "Try again" resets the
 * section's queries (refetching them) and re-renders it. Navigating (a new
 * `resetKeys` value) also resets it.
 */
export function SectionBoundary(props: {
  label: string;
  resetKeys: unknown[];
  queryKey: QueryKey;
  className?: string;
  children: ReactNode;
}) {
  const client = useQueryClient();
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          resetKeys={props.resetKeys}
          onReset={() => {
            reset();
            void client.resetQueries({ queryKey: props.queryKey });
          }}
          fallbackRender={({ error, resetErrorBoundary }) => (
            <div
              className={`section-error${props.className ? ` ${props.className}` : ""}`}
              role="alert"
              data-testid="section-error"
            >
              <p>{props.label} couldn’t be displayed.</p>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  // A code chunk that failed to load (offline, or a new
                  // deployment replaced it) only recovers with a fresh page.
                  if (isChunkLoadError(error)) window.location.reload();
                  else resetErrorBoundary();
                }}
              >
                Try again
              </button>
            </div>
          )}
        >
          {props.children}
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}
