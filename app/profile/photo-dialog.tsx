import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProfileDto } from "@shared/profile";
import { apiUpload } from "../lib/api";
import { qk } from "../lib/query/keys";
import { Dialog } from "../ui/dialog";
import { useToast } from "../ui/toast";

/** The crop window, in CSS pixels, and the uploaded square, in image pixels. */
const VIEW = 280;
const OUTPUT = 512;

interface Crop {
  zoom: number;
  x: number;
  y: number;
}

/** CSS pixels per image pixel: at zoom 1 the short side fills the square. */
const scale = (img: HTMLImageElement, zoom: number) =>
  (VIEW / Math.min(img.naturalWidth, img.naturalHeight)) * zoom;

const centred = (img: HTMLImageElement): Crop => {
  const s = scale(img, 1);
  return { zoom: 1, x: (VIEW - img.naturalWidth * s) / 2, y: (VIEW - img.naturalHeight * s) / 2 };
};

/** The picture always covers the square. */
const clamp = (img: HTMLImageElement, next: Crop): Crop => {
  const s = scale(img, next.zoom);
  return {
    zoom: next.zoom,
    x: Math.min(0, Math.max(VIEW - img.naturalWidth * s, next.x)),
    y: Math.min(0, Math.max(VIEW - img.naturalHeight * s, next.y)),
  };
};

/**
 * Crops a chosen picture to a square in the browser (drag to move, slider or
 * wheel to zoom), then uploads a 512 × 512 JPEG. The server still sniffs and
 * limits it. Positions are set through the CSSOM (style attributes are
 * blocked by CSP).
 */
export function PhotoDialog({
  userId,
  file,
  onClose,
}: {
  userId: string;
  file: File | null;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [loaded, setLoaded] = useState<{ file: File; image: HTMLImageElement; url: string } | null>(
    null,
  );
  const [crop, setCrop] = useState<Crop>({ zoom: 1, x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const drag = useRef<{ x: number; y: number; crop: Crop } | null>(null);
  // Only the picture chosen now counts (a previous one may still be in state).
  const image = loaded?.file === file ? loaded.image : null;
  const url = loaded?.file === file ? loaded.url : null;

  useEffect(() => {
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setLoaded({ file, image: img, url: objectUrl });
      setCrop(centred(img));
    };
    img.onerror = () => {
      toast("That file can't be used as a photo.", "error");
      onClose();
    };
    img.src = objectUrl;
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file, onClose, toast]);
  const zoomTo = (zoom: number) => {
    if (!image) return;
    // Zoom around the centre of the square.
    const before = scale(image, crop.zoom);
    const after = scale(image, zoom);
    const cx = (VIEW / 2 - crop.x) / before;
    const cy = (VIEW / 2 - crop.y) / before;
    setCrop(clamp(image, { zoom, x: VIEW / 2 - cx * after, y: VIEW / 2 - cy * after }));
  };

  useLayoutEffect(() => {
    const el = imgRef.current;
    if (!el || !image) return;
    const s = scale(image, crop.zoom);
    el.style.width = `${String(image.naturalWidth * s)}px`;
    el.style.height = `${String(image.naturalHeight * s)}px`;
    el.style.transform = `translate(${String(crop.x)}px, ${String(crop.y)}px)`;
  });

  async function save() {
    if (!image) return;
    setSaving(true);
    try {
      const s = scale(image, crop.zoom);
      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT;
      canvas.height = OUTPUT;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser can't crop images");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, OUTPUT, OUTPUT);
      context.imageSmoothingQuality = "high";
      context.drawImage(image, -crop.x / s, -crop.y / s, VIEW / s, VIEW / s, 0, 0, OUTPUT, OUTPUT);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.9);
      });
      if (!blob) throw new Error("The photo could not be prepared");
      const profile = await apiUpload<ProfileDto>("/api/profile/photo", blob, "photo.jpg", {
        method: "PUT",
      });
      client.setQueryData(qk.profile(userId), profile);
      toast("Photo updated.");
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : "The photo could not be saved", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={file !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Profile photo"
      description="Drag to move the picture and zoom to frame it."
      className="photo-dialog"
    >
      <div
        className="photo-crop"
        data-testid="photo-crop"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, crop };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || !image) return;
          setCrop(
            clamp(image, {
              zoom: start.crop.zoom,
              x: start.crop.x + event.clientX - start.x,
              y: start.crop.y + event.clientY - start.y,
            }),
          );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onWheel={(event) => {
          zoomTo(Math.min(4, Math.max(1, crop.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1))));
        }}
      >
        {url && image ? <img ref={imgRef} src={url} alt="" draggable={false} /> : null}
      </div>
      <label className="photo-zoom">
        Zoom
        <input
          type="range"
          min={1}
          max={4}
          step={0.01}
          value={crop.zoom}
          onChange={(event) => {
            zoomTo(Number(event.currentTarget.value));
          }}
        />
      </label>
      <div className="dialog-actions">
        <button type="button" className="pill-button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="pill-button pill-primary"
          disabled={!image || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save photo"}
        </button>
      </div>
    </Dialog>
  );
}
