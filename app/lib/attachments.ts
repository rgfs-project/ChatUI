import { useSyncExternalStore } from "react";
import type { AttachmentDto, AttachmentKind } from "@shared/attachments";
import { currentSession, refreshSession } from "./api";
import { authStore } from "./auth-store";
import { apiJson } from "./query";

/**
 * Attachments on the composer (Phase 12), per signed-in user and draft key,
 * in tab memory only (like drafts). Each file uploads as soon as it is added
 * (POST /api/attachments, progress through XHR); a chip is removable while it
 * uploads (abort) or once pending on the server (DELETE). An account change
 * aborts every upload and clears every tray (contracts §12). The server
 * sniffs and limits everything; the checks here only save a round trip.
 */

export interface DraftAttachment {
  localId: string;
  name: string;
  size: number;
  /** From the browser's type until the server's sniffed answer arrives. */
  kind: AttachmentKind;
  /** Local object URL for image previews (revoked when the chip goes away). */
  previewUrl: string | null;
  status: "uploading" | "ready" | "error";
  /** 0–1 while uploading. */
  progress: number;
  error: string | null;
  dto: AttachmentDto | null;
}

export class UploadError extends Error {
  override name = "UploadError";
  readonly code: string | null;
  constructor(code: string | null, message: string) {
    super(message);
    this.code = code;
  }
}

/** Default longest edge for client-side shrinking when the preference is unset. */
export const DEFAULT_IMAGE_MAX_EDGE = 2048;

const EMPTY: readonly DraftAttachment[] = Object.freeze([]);
const trays = new Map<string, readonly DraftAttachment[]>();
const aborts = new Map<string, () => void>();
const listeners = new Set<() => void>();
let owner: string | null = null;

const slot = (userId: string, key: string) => `${userId}\u0000${key}`;

function emit(): void {
  for (const listener of listeners) listener();
}

function setTray(id: string, next: readonly DraftAttachment[]): void {
  if (next.length === 0) trays.delete(id);
  else trays.set(id, next);
  emit();
}

function update(id: string, localId: string, change: Partial<DraftAttachment>): void {
  const tray = trays.get(id);
  if (!tray?.some((a) => a.localId === localId)) return;
  setTray(
    id,
    tray.map((a) => (a.localId === localId ? { ...a, ...change } : a)),
  );
}

function release(attachment: DraftAttachment): void {
  aborts.get(attachment.localId)?.();
  aborts.delete(attachment.localId);
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

/** Drops everything that does not belong to `userId` (account boundary). */
function purge(userId: string | null): void {
  let changed = false;
  for (const [id, tray] of trays) {
    if (userId !== null && id.startsWith(`${userId}\u0000`)) continue;
    for (const attachment of tray) release(attachment);
    trays.delete(id);
    changed = true;
  }
  if (changed) emit();
}

let watching = false;

/** Follows the signed-in account from the first attachment on (browser only). */
function watchAccount(): void {
  if (watching) return;
  watching = true;
  authStore.subscribe(() => {
    const auth = authStore.get();
    const next = auth.status === "authenticated" ? (auth.session?.user?.id ?? null) : null;
    // An expired session keeps the tray for the same user's re-authentication.
    if (auth.expired && next === null) return;
    if (next !== owner) {
      owner = next;
      purge(next);
    }
  });
}

export function guessKind(type: string): AttachmentKind {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  return "text";
}

/**
 * Client-side image shrinking (contracts §7, `imageMaxEdge`): PNG, JPEG and
 * WebP larger than `maxEdge` are redrawn at that longest edge in the same
 * format (EXIF orientation applied, metadata dropped). 0 never shrinks; GIF
 * keeps its animation. Only an optimization: the server still sniffs, checks
 * pixels and quotas.
 */
export async function shrinkImage(file: Blob, maxEdge: number): Promise<Blob> {
  if (maxEdge <= 0 || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = maxEdge / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, file.type, 0.9);
    });
    return blob?.type === file.type ? blob : file;
  } catch {
    return file;
  }
}

function send(
  file: Blob,
  filename: string,
  onProgress: (fraction: number) => void,
): { promise: Promise<AttachmentDto>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<AttachmentDto>((resolve, reject) => {
    const form = new FormData();
    form.append("file", file, filename);
    xhr.open("POST", "/api/attachments");
    xhr.responseType = "json";
    xhr.setRequestHeader("Accept", "application/json");
    const session = currentSession();
    if (session?.csrfToken && session.user) {
      xhr.setRequestHeader("X-CSRF-Token", session.csrfToken);
      xhr.setRequestHeader("X-Expected-User", session.user.id);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      const body = xhr.response as
        (AttachmentDto & { error?: { code?: string; message?: string } }) | null;
      if (xhr.status === 201 && body) resolve(body);
      else
        reject(
          new UploadError(
            body?.error?.code ?? null,
            body?.error?.message ?? `Upload failed (${String(xhr.status)})`,
          ),
        );
    };
    xhr.onerror = () => {
      reject(new UploadError(null, "The upload failed. Check your connection and try again."));
    };
    xhr.onabort = () => {
      reject(new UploadError("ABORTED", "Upload cancelled"));
    };
    xhr.send(form);
  });
  return {
    promise,
    abort: () => {
      xhr.abort();
    },
  };
}

/**
 * Uploads with the shared adapter's rules (contracts §5): a 401 opens
 * re-authentication; CSRF_INVALID refetches the session and retries once
 * only for the same account and epoch.
 */
async function upload(
  localId: string,
  file: Blob,
  filename: string,
  onProgress: (fraction: number) => void,
): Promise<AttachmentDto> {
  const origin = { userId: currentSession()?.user?.id ?? null, epoch: authStore.get().epoch };
  for (let attempt = 0; ; attempt++) {
    const request = send(file, filename, onProgress);
    aborts.set(localId, request.abort);
    try {
      return await request.promise;
    } catch (error) {
      if (!(error instanceof UploadError)) throw error;
      if (error.code === "UNAUTHENTICATED") authStore.expire();
      if (error.code !== "CSRF_INVALID" || attempt > 0) throw error;
      const fresh = await refreshSession(false);
      if (fresh?.user?.id !== origin.userId || authStore.get().epoch !== origin.epoch)
        throw new UploadError("SESSION_CHANGED", "The signed-in account changed");
      authStore.applySession(fresh);
    }
  }
}

const REASONS: Record<string, string> = {
  UNSUPPORTED_MEDIA_TYPE: "Unsupported file",
  PAYLOAD_TOO_LARGE: "Too large",
  QUOTA_EXCEEDED: "Storage full",
  RATE_LIMITED: "Too many uploads at once",
};

export interface AddOptions {
  maxPerMessage: number;
  maxFileBytes: number;
  /** The `imageMaxEdge` preference: null = default, 0 = never shrink. */
  imageMaxEdge: number | null;
  onUploaded?: () => void;
}

/** Adds files to a tray and starts their uploads. Returns a notice when some were refused. */
export function addFiles(
  userId: string,
  key: string,
  files: readonly File[],
  options: AddOptions,
): string | null {
  const id = slot(userId, key);
  owner ??= userId;
  watchAccount();
  const tray = trays.get(id) ?? EMPTY;
  const room = Math.max(0, options.maxPerMessage - tray.filter((a) => a.status !== "error").length);
  const accepted = files.slice(0, room);
  const added: DraftAttachment[] = accepted.map((file) => {
    const kind = guessKind(file.type);
    const tooLarge = file.size > options.maxFileBytes && kind !== "image";
    return {
      localId: crypto.randomUUID(),
      name: file.name || "pasted-image",
      size: file.size,
      kind,
      previewUrl: kind === "image" ? URL.createObjectURL(file) : null,
      status: tooLarge ? "error" : "uploading",
      progress: 0,
      error: tooLarge ? "Too large" : null,
      dto: null,
    };
  });
  setTray(id, [...tray, ...added]);
  accepted.forEach((file, index) => {
    const entry = added[index];
    if (!entry || entry.status === "error") return;
    void (async () => {
      const blob =
        entry.kind === "image"
          ? await shrinkImage(file, options.imageMaxEdge ?? DEFAULT_IMAGE_MAX_EDGE)
          : file;
      if (blob.size > options.maxFileBytes) {
        update(id, entry.localId, { status: "error", error: "Too large" });
        return;
      }
      try {
        const dto = await upload(entry.localId, blob, entry.name, (progress) => {
          update(id, entry.localId, { progress });
        });
        aborts.delete(entry.localId);
        if (!trays.get(id)?.some((a) => a.localId === entry.localId)) {
          // Removed while uploading: the server copy is not wanted either.
          void deletePending(dto.id);
          return;
        }
        update(id, entry.localId, {
          status: "ready",
          progress: 1,
          dto,
          kind: dto.kind,
          name: dto.filename,
          size: dto.size,
        });
        options.onUploaded?.();
      } catch (error) {
        aborts.delete(entry.localId);
        if (error instanceof UploadError && error.code === "ABORTED") return;
        const code = error instanceof UploadError ? error.code : null;
        update(id, entry.localId, {
          status: "error",
          error: (code && REASONS[code]) ?? "Upload failed",
        });
      }
    })();
  });
  const refused = files.length - accepted.length;
  return refused > 0
    ? `A message can have at most ${String(options.maxPerMessage)} attachments.`
    : null;
}

function deletePending(attachmentId: string): Promise<unknown> {
  return apiJson(`/api/attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
  }).catch(() => undefined);
}

/** Removes a chip: aborts its upload, or deletes the pending server copy. */
export function removeAttachment(userId: string, key: string, localId: string): void {
  const id = slot(userId, key);
  const tray = trays.get(id) ?? EMPTY;
  const target = tray.find((a) => a.localId === localId);
  if (!target) return;
  release(target);
  if (target.dto) void deletePending(target.dto.id);
  setTray(
    id,
    tray.filter((a) => a.localId !== localId),
  );
}

export function getTray(userId: string, key: string): readonly DraftAttachment[] {
  return trays.get(slot(userId, key)) ?? EMPTY;
}

/** Takes the uploaded attachments for a send (the server keeps them pending until linked). */
export function takeReady(userId: string, key: string): AttachmentDto[] {
  const id = slot(userId, key);
  const tray = trays.get(id) ?? EMPTY;
  const ready = tray.filter((a) => a.status === "ready" && a.dto);
  for (const attachment of ready) release(attachment);
  setTray(
    id,
    tray.filter((a) => !ready.includes(a)),
  );
  return ready.flatMap((a) => (a.dto ? [a.dto] : []));
}

/** Puts attachments back (a rejected send): still pending on the server. */
export function restoreReady(userId: string, key: string, dtos: readonly AttachmentDto[]): void {
  if (dtos.length === 0) return;
  const id = slot(userId, key);
  const present = new Set((trays.get(id) ?? EMPTY).map((a) => a.dto?.id));
  const back: DraftAttachment[] = dtos
    .filter((dto) => !present.has(dto.id))
    .map((dto) => ({
      localId: crypto.randomUUID(),
      name: dto.filename,
      size: dto.size,
      kind: dto.kind,
      previewUrl: null,
      status: "ready",
      progress: 1,
      error: null,
      dto,
    }));
  setTray(id, [...back, ...(trays.get(id) ?? EMPTY)]);
}

/** The draft became a conversation: its tray follows. */
export function moveTray(userId: string, from: string, to: string): void {
  const source = trays.get(slot(userId, from));
  if (!source || from === to) return;
  trays.delete(slot(userId, from));
  setTray(slot(userId, to), [...(trays.get(slot(userId, to)) ?? EMPTY), ...source]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTray(userId: string, key: string): readonly DraftAttachment[] {
  return useSyncExternalStore(
    subscribe,
    () => getTray(userId, key),
    () => EMPTY,
  );
}

/** Test helper: a new page load. */
export function resetAttachmentsForTests(): void {
  purge(null);
  owner = null;
  watching = false;
}
