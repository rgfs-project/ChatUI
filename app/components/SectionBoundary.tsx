import { QueryErrorResetBoundary, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";

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
          fallbackRender={({ resetErrorBoundary }) => (
            <div
              className={`section-error${props.className ? ` ${props.className}` : ""}`}
              role="alert"
              data-testid="section-error"
            >
              <p>{props.label} couldn’t be displayed.</p>
              <button type="button" className="secondary" onClick={resetErrorBoundary}>
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
