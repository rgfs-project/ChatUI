import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, Minus, Plus, X } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import type { MessageAttachmentDto } from "@shared/attachments";
import { attachmentContentUrl } from "@shared/attachment-media";
import "./attachments.css";

const STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

/**
 * Full-screen image viewer (Phase 12; loaded on the first click of a
 * thumbnail). Radix Dialog: focus trap, Escape, focus back to the thumbnail.
 * The image opens fitted to the screen; − / + step the zoom (also the − and
 * + keys, 0 to fit), a zoomed image scrolls. ←/→ move between a message's
 * images. Download fetches the bytes with `Content-Disposition: attachment`.
 */
export function ImageViewer({
  items,
  index: initial,
  onClose,
}: {
  items: readonly MessageAttachmentDto[];
  index: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(initial);
  const [scale, setScale] = useState<number | null>(null); // null: fit
  const [fit, setFit] = useState(1);
  // State, not a ref: the portal mounts the stage after this component's first effects.
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const item = items[index] ?? items[0];
  const natural = { width: item?.width ?? 0, height: item?.height ?? 0 };

  // The fitted scale: the whole image visible, never enlarged past 100%.
  useLayoutEffect(() => {
    const el = stage;
    if (!el || !natural.width || !natural.height) return;
    const measure = () => {
      setFit(
        Math.min(1, (el.clientWidth - 32) / natural.width, (el.clientHeight - 32) / natural.height),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [stage, natural.width, natural.height]);

  const current = scale ?? fit;
  const zoom = (direction: 1 | -1) => {
    const next =
      direction > 0
        ? (STEPS.find((s) => s > current + 0.001) ?? STEPS.at(-1))
        : ([...STEPS].reverse().find((s) => s < current - 0.001) ?? STEPS[0]);
    setScale(next ?? current);
  };
  const go = (step: 1 | -1) => {
    setIndex((i) => (i + step + items.length) % items.length);
    setScale(null); // each image opens fitted
  };
  if (!item) return null;
  const width = Math.max(1, Math.round(natural.width * current));
  const height = Math.max(1, Math.round(natural.height * current));

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="viewer-overlay" />
        <Dialog.Content
          className="viewer"
          data-testid="image-viewer"
          aria-describedby={undefined}
          onKeyDown={(event) => {
            if (event.key === "+" || event.key === "=") zoom(1);
            else if (event.key === "-") zoom(-1);
            else if (event.key === "0") setScale(null);
            else if (event.key === "ArrowRight" && items.length > 1) go(1);
            else if (event.key === "ArrowLeft" && items.length > 1) go(-1);
            else return;
            event.preventDefault();
          }}
        >
          <Dialog.Title className="visually-hidden">{item.filename ?? "Image"}</Dialog.Title>
          <div className="viewer-actions">
            <a
              className="viewer-btn"
              href={attachmentContentUrl(item.id, true)}
              download={item.filename ?? true}
              aria-label="Download image"
              title="Download"
            >
              <Download size={20} aria-hidden />
            </a>
            <Dialog.Close className="viewer-btn" aria-label="Close" title="Close (Esc)">
              <X size={20} aria-hidden />
            </Dialog.Close>
          </div>
          <div
            ref={setStage}
            className={`viewer-stage${current > fit + 0.001 ? " zoomed" : ""}`}
            onClick={(event) => {
              if (event.target === event.currentTarget) onClose();
            }}
          >
            <img
              key={item.id}
              src={attachmentContentUrl(item.id)}
              alt={item.filename ?? "Image"}
              width={width}
              height={height}
              style={{ width, height }}
              draggable={false}
            />
          </div>
          {items.length > 1 ? (
            <>
              <button
                type="button"
                className="viewer-btn viewer-prev"
                aria-label="Previous image"
                onClick={() => {
                  go(-1);
                }}
              >
                <ChevronLeft size={22} aria-hidden />
              </button>
              <button
                type="button"
                className="viewer-btn viewer-next"
                aria-label="Next image"
                onClick={() => {
                  go(1);
                }}
              >
                <ChevronRight size={22} aria-hidden />
              </button>
            </>
          ) : null}
          <div className="viewer-zoom" role="group" aria-label="Zoom">
            <button
              type="button"
              className="viewer-btn"
              aria-label="Zoom out"
              disabled={current <= (STEPS[0] ?? 0.1) + 0.001}
              onClick={() => {
                zoom(-1);
              }}
            >
              <Minus size={18} aria-hidden />
            </button>
            <button
              type="button"
              className="viewer-level"
              aria-label="Fit to screen"
              title="Fit to screen (0)"
              onClick={() => {
                setScale(null);
              }}
              data-testid="zoom-level"
            >
              {Math.round(current * 100)}%
            </button>
            <button
              type="button"
              className="viewer-btn"
              aria-label="Zoom in"
              disabled={current >= (STEPS.at(-1) ?? 8) - 0.001}
              onClick={() => {
                zoom(1);
              }}
            >
              <Plus size={18} aria-hidden />
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
