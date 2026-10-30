import * as RadixDialog from "@radix-ui/react-dialog";
import "./image-viewer.css";
import { ChevronLeft, ChevronRight, Download, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { contentUrl } from "./message-attachments";
import type { ViewerImage } from "./viewer";

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const STEP = 1.5;

interface View {
  scale: number;
  x: number;
  y: number;
}

const FIT: View = { scale: 1, x: 0, y: 0 };

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/**
 * Full-screen image viewer (Phase 12): zoom (buttons, wheel, double-click,
 * pinch), pan (drag), previous/next (buttons, arrow keys, swipe), download,
 * Escape to close. The previous image stays on screen until the next one has
 * decoded, so switching never flashes; thumbnails already cached the bytes.
 * Transforms are set through the CSSOM (style attributes are blocked by CSP).
 */
export default function ImageViewer({
  images,
  index,
  onIndex,
  onClose,
  returnFocus,
}: {
  images: readonly ViewerImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const requested = images[index];
  const [shown, setShown] = useState(requested);
  const [view, setView] = useState<View>(FIT);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    startX: number;
    startY: number;
    view: View;
    distance: number | null;
    moved: boolean;
  } | null>(null);

  // Swap only once the next image is decoded: no blank frame between images.
  useEffect(() => {
    if (!requested || requested.id === shown?.id) return;
    let cancelled = false;
    const next = new Image();
    next.src = contentUrl(requested.id);
    void next
      .decode()
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        setShown(requested);
        setView(FIT);
      });
    return () => {
      cancelled = true;
    };
  }, [requested, shown?.id]);

  useLayoutEffect(() => {
    const img = imgRef.current;
    if (img)
      img.style.transform = `translate(${String(view.x)}px, ${String(view.y)}px) scale(${String(view.scale)})`;
  }, [view, shown]);

  const zoom = useCallback((factor: number) => {
    setView((v) => {
      const scale = clampScale(v.scale * factor);
      return scale === 1 ? FIT : { ...v, scale };
    });
  }, []);

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next >= 0 && next < images.length) onIndex(next);
    },
    [images.length, index, onIndex],
  );

  if (!shown) return null;
  const count = images.length;
  const position = images.findIndex((image) => image.id === shown.id) + 1;

  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="viewer-backdrop" />
        <RadixDialog.Content
          className="viewer"
          aria-describedby={undefined}
          data-testid="image-viewer"
          onCloseAutoFocus={(event) => {
            const element = returnFocus();
            if (element?.isConnected) {
              event.preventDefault();
              element.focus();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") go(1);
            else if (event.key === "ArrowLeft") go(-1);
            else if (event.key === "+" || event.key === "=") zoom(STEP);
            else if (event.key === "-") zoom(1 / STEP);
            else if (event.key === "0") setView(FIT);
            else return;
            event.preventDefault();
          }}
        >
          <div className="viewer-bar">
            <RadixDialog.Title className="viewer-title">{shown.filename}</RadixDialog.Title>
            {count > 1 ? (
              <span className="viewer-count">
                {position} of {count}
              </span>
            ) : null}
            <div className="viewer-tools">
              <button
                type="button"
                className="icon-button"
                aria-label="Zoom out"
                disabled={view.scale <= MIN_SCALE}
                onClick={() => {
                  zoom(1 / STEP);
                }}
              >
                <Minus size={18} aria-hidden />
              </button>
              <button
                type="button"
                className="viewer-zoom"
                aria-label={`Fit to screen, ${String(Math.round(view.scale * 100))}%`}
                onClick={() => {
                  setView(FIT);
                }}
              >
                {Math.round(view.scale * 100)}%
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Zoom in"
                disabled={view.scale >= MAX_SCALE}
                onClick={() => {
                  zoom(STEP);
                }}
              >
                <Plus size={18} aria-hidden />
              </button>
              <a
                className="icon-button"
                href={contentUrl(shown.id, true)}
                download={shown.filename}
                aria-label="Download"
              >
                <Download size={18} aria-hidden />
              </a>
              <RadixDialog.Close asChild>
                <button type="button" className="icon-button" aria-label="Close">
                  <X size={18} aria-hidden />
                </button>
              </RadixDialog.Close>
            </div>
          </div>
          <div
            className={`viewer-stage${view.scale > 1 ? " is-zoomed" : ""}`}
            onWheel={(event) => {
              zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15);
            }}
            onDoubleClick={() => {
              setView((v) => (v.scale > 1 ? FIT : { scale: 2, x: 0, y: 0 }));
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
              const [a, b] = [...pointers.current.values()];
              gesture.current = {
                startX: event.clientX,
                startY: event.clientY,
                view,
                distance: a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null,
                moved: false,
              };
            }}
            onPointerMove={(event) => {
              const g = gesture.current;
              if (!g || !pointers.current.has(event.pointerId)) return;
              pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
              const [a, b] = [...pointers.current.values()];
              if (a && b && g.distance) {
                const scale = clampScale(
                  (g.view.scale * Math.hypot(a.x - b.x, a.y - b.y)) / g.distance,
                );
                setView(scale === 1 ? FIT : { ...g.view, scale });
                g.moved = true;
                return;
              }
              const dx = event.clientX - g.startX;
              const dy = event.clientY - g.startY;
              if (Math.abs(dx) + Math.abs(dy) > 4) g.moved = true;
              if (g.view.scale > 1) setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
            }}
            onPointerUp={(event) => {
              const g = gesture.current;
              pointers.current.delete(event.pointerId);
              if (pointers.current.size > 0) return;
              gesture.current = null;
              // Swipe between images at fit size.
              const dx = event.clientX - (g?.startX ?? event.clientX);
              if (g?.view.scale === 1 && g.distance === null && Math.abs(dx) > 60)
                go(dx < 0 ? 1 : -1);
            }}
            onPointerCancel={(event) => {
              pointers.current.delete(event.pointerId);
              gesture.current = null;
            }}
          >
            <img
              ref={imgRef}
              className="viewer-image"
              src={contentUrl(shown.id)}
              alt={shown.filename}
              width={shown.width ?? undefined}
              height={shown.height ?? undefined}
              draggable={false}
            />
          </div>
          {count > 1 ? (
            <>
              <button
                type="button"
                className="viewer-nav is-prev icon-button"
                aria-label="Previous image"
                disabled={index <= 0}
                onClick={() => {
                  go(-1);
                }}
              >
                <ChevronLeft size={22} aria-hidden />
              </button>
              <button
                type="button"
                className="viewer-nav is-next icon-button"
                aria-label="Next image"
                disabled={index >= count - 1}
                onClick={() => {
                  go(1);
                }}
              >
                <ChevronRight size={22} aria-hidden />
              </button>
            </>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
