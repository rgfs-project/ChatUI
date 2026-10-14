import { QueryErrorResetBoundary, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";

/** A dynamic import that failed, as Chromium, Firefox and Safari word it. */
export function isChunkLoadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
      error.message,
    )
  );
}

/**
 * Keeps a failure in one part of the shell (the sidebar, the chat) from taking
 * down the rest. "Try again" resets that part's queries and renders it again;
 * a code chunk that failed to load only recovers with a fresh page. A new
 * `resetKeys` value (navigating) resets it too.
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
              className={`empty-state${props.className ? ` ${props.className}` : ""}`}
              role="alert"
              data-testid="section-error"
            >
              <p>{props.label} couldn’t be displayed.</p>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
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
