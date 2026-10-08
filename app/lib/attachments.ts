import type { AttachmentDto } from "@shared/attachments";
import { ApiError, apiFetch, ensureOk } from "./api";

export const DEFAULT_IMAGE_MAX_EDGE = 3072;

/** Draws a large still image smaller in the browser (GIFs keep their frames). */
async function shrink(file: File, maxEdge: number): Promise<File> {
  if (maxEdge <= 0 || !/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = maxEdge / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, file.type, 0.9);
  });
  return blob ? new File([blob], file.name, { type: file.type }) : file;
}

/** Uploads one file as a pending attachment (linked when the message is sent). */
export async function uploadAttachment(
  file: File,
  maxEdge: number,
  signal?: AbortSignal,
): Promise<AttachmentDto> {
  const body = new FormData();
  body.append("file", await shrink(file, maxEdge), file.name);
  let response: Response;
  try {
    response = await apiFetch("/api/attachments", { method: "POST", body, signal: signal ?? null });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, undefined, "Couldn’t upload. Check your connection.");
  }
  await ensureOk(response);
  return (await response.json()) as AttachmentDto;
}

export async function deletePendingAttachment(id: string): Promise<void> {
  await apiFetch(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(
    () => undefined,
  );
}
