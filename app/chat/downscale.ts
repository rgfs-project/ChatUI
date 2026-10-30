/** Longest edge for images when the user has not chosen one (Settings → Chat). */
export const DEFAULT_IMAGE_MAX_EDGE = 2048;

/** Animated GIFs are never redrawn (a canvas keeps only the first frame). */
const RESIZABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * Shrinks a large image in the browser before upload (`imageMaxEdge`
 * preference; 0 turns it off). The redraw also drops EXIF metadata such as
 * location. The server still sniffs, measures and limits whatever arrives;
 * this is only an optimization. The original is kept when it is not larger.
 */
export async function downscaleImage(file: File, maxEdge: number): Promise<File> {
  if (maxEdge <= 0 || !RESIZABLE.has(file.type) || typeof createImageBitmap !== "function")
    return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // undecodable here: let the server decide
  }
  try {
    const scale = maxEdge / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, file.type, 0.9);
    });
    if (blob?.type !== file.type || blob.size >= file.size) return file;
    return new File([blob], file.name, { type: file.type, lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}
