import { useCallback, useSyncExternalStore } from "react";
import type { AttachmentDto, AttachmentKind, AttachmentRef } from "@shared/attachments";
import { apiFetch, apiUpload } from "../lib/api";
import { downscaleImage } from "./downscale";

/** At most this many files per message (the server enforces its own limit too). */
export const MAX_FILES_PER_MESSAGE = 10;

/** File types offered by the picker; the server decides by the bytes. */
export const ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,audio/wav,audio/x-wav,audio/mpeg,audio/flac,.wav,.mp3,.flac," +
  ".txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.yaml,.yml,.toml,.ini,.log,.sql,.js,.mjs,.ts,.tsx,.jsx," +
  ".py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cc,.cpp,.hpp,.cs,.php,.sh,.css,.scss,.diff,.patch,.tex,.rst";

/** One file in the composer: uploading, ready (a pending server attachment) or failed. */
export interface ComposerFile {
  localId: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  /** Object URL for an image preview (revoked when the file leaves the composer). */
  previewUrl: string | null;
  progress: number;
  status: "uploading" | "ready" | "error";
  error: string | null;
  attachment: AttachmentDto | null;
}

function guessKind(file: File): AttachmentKind {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/") || /\.(wav|mp3|flac)$/i.test(file.name)) return "audio";
  return "text";
}

/** The reference a sent message shows for a ready file (the same shape the server returns). */
export function refOf(attachment: AttachmentDto): AttachmentRef {
  return {
    id: attachment.id,
    missing: false,
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    kind: attachment.kind,
    size: attachment.size,
    width: attachment.width,
    height: attachment.height,
  };
}

const EMPTY: readonly ComposerFile[] = [];

/**
 * Composer files per draft key (user + conversation), in tab memory only like
 * drafts. Uploads start as soon as a file is added; removing a file cancels its
 * upload or deletes the pending server copy.
 */
class ComposerFileStore {
  private readonly files = new Map<string, readonly ComposerFile[]>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get = (key: string): readonly ComposerFile[] => this.files.get(key) ?? EMPTY;

  private write(key: string, next: readonly ComposerFile[]): void {
    if (next.length === 0) this.files.delete(key);
    else this.files.set(key, next);
    for (const listener of this.listeners) listener();
  }

  private patch(key: string, localId: string, change: Partial<ComposerFile>): void {
    const list = this.files.get(key);
    if (!list?.some((f) => f.localId === localId)) return;
    this.write(
      key,
      list.map((f) => (f.localId === localId ? { ...f, ...change } : f)),
    );
  }

  /** Adds files and starts their uploads. Returns how many were refused for the limit. */
  add(
    key: string,
    incoming: File[],
    options: { imageMaxEdge: number; onUploaded?: () => void },
  ): number {
    const room = MAX_FILES_PER_MESSAGE - this.get(key).length;
    const accepted = incoming.slice(0, Math.max(0, room));
    const entries = accepted.map((file): ComposerFile => ({
      localId: crypto.randomUUID(),
      name: file.name || "Pasted file",
      size: file.size,
      kind: guessKind(file),
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      progress: 0,
      status: "uploading",
      error: null,
      attachment: null,
    }));
    this.write(key, [...this.get(key), ...entries]);
    entries.forEach((entry, i) => {
      const file = accepted[i];
      if (file) void this.upload(key, entry, file, options);
    });
    return incoming.length - accepted.length;
  }

  private async upload(
    key: string,
    entry: ComposerFile,
    file: File,
    options: { imageMaxEdge: number; onUploaded?: () => void },
  ): Promise<void> {
    const controller = new AbortController();
    // A function, so the check is re-read after each await (removal aborts it).
    const cancelled = () => controller.signal.aborted;
    this.controllers.set(entry.localId, controller);
    try {
      const prepared =
        entry.kind === "image" ? await downscaleImage(file, options.imageMaxEdge) : file;
      if (cancelled()) return;
      const attachment = await apiUpload<AttachmentDto>("/api/attachments", prepared, entry.name, {
        signal: controller.signal,
        onProgress: (fraction) => {
          this.patch(key, entry.localId, { progress: fraction });
        },
      });
      if (cancelled()) {
        void deletePending(attachment.id);
        return;
      }
      this.patch(key, entry.localId, {
        status: "ready",
        progress: 1,
        size: attachment.size,
        kind: attachment.kind,
        attachment,
      });
      options.onUploaded?.();
    } catch (error) {
      if (cancelled()) return;
      this.patch(key, entry.localId, {
        status: "error",
        error: error instanceof Error ? error.message : "The upload failed",
      });
    } finally {
      this.controllers.delete(entry.localId);
    }
  }

  /** Removes one file: cancels its upload, or deletes the unsent server copy. */
  remove(key: string, localId: string): void {
    const file = this.get(key).find((f) => f.localId === localId);
    if (!file) return;
    this.controllers.get(localId)?.abort();
    if (file.attachment) void deletePending(file.attachment.id);
    if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    this.write(
      key,
      this.get(key).filter((f) => f.localId !== localId),
    );
  }

  /** Takes the files for sending (the server copies stay; they become linked). */
  take(key: string): readonly ComposerFile[] {
    const list = this.get(key);
    this.write(key, []);
    return list;
  }

  /** Puts files back after a rejected send. */
  restore(key: string, list: readonly ComposerFile[]): void {
    this.write(key, [...list, ...this.get(key)]);
  }

  /** After a send was accepted: previews are no longer needed. */
  release(list: readonly ComposerFile[]): void {
    for (const file of list) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
  }

  /** Account change: cancel every upload and forget every file (never sent as someone else). */
  clearAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    for (const list of this.files.values()) this.release(list);
    this.files.clear();
    for (const listener of this.listeners) listener();
  }
}

function deletePending(id: string): Promise<unknown> {
  return apiFetch(`/api/attachments/${id}`, { method: "DELETE" }).catch(() => undefined);
}

export const composerFiles = new ComposerFileStore();

export function useComposerFiles(key: string): readonly ComposerFile[] {
  const get = useCallback(() => composerFiles.get(key), [key]);
  return useSyncExternalStore(composerFiles.subscribe, get, () => EMPTY);
}
