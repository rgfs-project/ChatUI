import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { overlayBackground, paths, type OverlayState } from "../lib/paths";
import { Dialog } from "../ui/dialog";

/**
 * A URL-backed overlay (INV-53). Opened from inside the app it closes with
 * Back, returning to the page behind it; a direct link or reload closes to
 * the draft chat it was rendered over.
 */
export function useCloseOverlay(): () => void {
  const navigate = useNavigate();
  const location = useLocation();
  return () => {
    if (overlayBackground(location.state)) void navigate(-1);
    else void navigate(paths.newChat(), { replace: true });
  };
}

/** Opens an overlay over the current page; Back closes it (INV-53). */
export function useOpenOverlay(): (to: string) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return (to: string) => {
    const background =
      (location.state as Partial<OverlayState> | null)?.background ?? location.pathname;
    void navigate(to, { state: { background } satisfies OverlayState });
  };
}

export function OverlayDialog({
  title,
  className,
  page,
  children,
}: {
  title: string;
  className?: string;
  page?: boolean;
  children: ReactNode;
}) {
  const close = useCloseOverlay();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={title}
      {...(className ? { className } : {})}
      {...(page ? { page } : {})}
    >
      {children}
    </Dialog>
  );
}
