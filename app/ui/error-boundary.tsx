import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Contains a rendering failure to one area (shell, sidebar, transcript) and
 * offers Retry, which re-renders the area (and runs `onRetry`, e.g. refetch).
 */
export class ErrorBoundary extends Component<
  { area: string; children: ReactNode; onRetry?: () => void; className?: string },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`${this.props.area} failed to render`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={`area-error ${this.props.className ?? ""}`} role="alert">
        <p>This part of the page could not be shown.</p>
        <button
          type="button"
          className="pill-button"
          onClick={() => {
            this.props.onRetry?.();
            this.setState({ failed: false });
          }}
        >
          Retry
        </button>
      </div>
    );
  }
}
