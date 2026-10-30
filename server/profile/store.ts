// Profile photo and shape (Phase 12b): data/<user>/profile/{profile.json,photo}.
import { createHash, randomBytes } from "node:crypto";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import { ErrorCode } from "@shared/errors";
import { PHOTO_SHAPES, type PhotoShape } from "@shared/profile";
import { sniff, SniffError } from "../attachments/sniff.ts";
import { AppError } from "../errors.ts";
import { atomicWrite, ensureDirUnder, FILE_MODE, readOrNull } from "../storage/fs.ts";
import type { KeyedLocks } from "../storage/locks.ts";
import type { DataPaths } from "../storage/paths.ts";

/** The browser crops to a square and sends at most 1024 px; this leaves room. */
export const MAX_PHOTO_BYTES = 5 * 1_048_576;
const MAX_PHOTO_EDGE = 4_096;
const PHOTO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const profileSchema = z.strictObject({
  version: z.literal(1),
  photo: z
    .strictObject({
      mediaType: z.string(),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      updatedAt: z.string(),
    })
    .nullable(),
  shape: z.enum(PHOTO_SHAPES),
});
export type Profile = z.infer<typeof profileSchema>;

const DEFAULT_PROFILE: Profile = { version: 1, photo: null, shape: "circle" };

/**
 * Canonical per-user profile. The photo is stored like an attachment: bytes
 * streamed to a temp file with the size enforced per chunk, sniffed from the
 * bytes (PNG, JPEG or WebP only), renamed into place, then the record.
 */
export class ProfileStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;
  private readonly now: () => Date;

  constructor(paths: DataPaths, locks: KeyedLocks, now: () => Date = () => new Date()) {
    this.paths = paths;
    this.locks = locks;
    this.now = now;
  }

  private lock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(`profile:${userId}`, fn);
  }

  async get(userId: string): Promise<Profile> {
    const raw = await readOrNull(this.paths.profileFile(userId));
    if (!raw) return DEFAULT_PROFILE;
    try {
      const parsed = profileSchema.safeParse(JSON.parse(raw.toString("utf8")));
      return parsed.success ? parsed.data : DEFAULT_PROFILE;
    } catch {
      return DEFAULT_PROFILE;
    }
  }

  private async write(userId: string, profile: Profile): Promise<void> {
    await ensureDirUnder(this.paths.userDir(userId), this.paths.profileDir(userId));
    await atomicWrite(this.paths.profileFile(userId), `${JSON.stringify(profile, null, 2)}\n`);
  }

  async setShape(userId: string, shape: PhotoShape): Promise<Profile> {
    return this.lock(userId, async () => {
      const next = { ...(await this.get(userId)), shape };
      await this.write(userId, next);
      return next;
    });
  }

  async setPhoto(
    userId: string,
    source: Readable,
    info: { filename: string; clientType: string },
  ): Promise<Profile> {
    await ensureDirUnder(this.paths.userDir(userId), this.paths.profileDir(userId));
    const dir = this.paths.profileDir(userId);
    const temp = path.join(dir, `.photo.${randomBytes(8).toString("hex")}.tmp`);
    const hash = createHash("sha256");
    let size = 0;
    let handle: FileHandle | null = await open(temp, "wx+", FILE_MODE);
    try {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_PHOTO_BYTES)
          throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "The photo is too large");
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      const reader = handle;
      const sniffed = await sniff({
        size,
        read: async (offset, length) => {
          const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
          if (buffer.length === 0) return buffer;
          const { bytesRead } = await reader.read(buffer, 0, buffer.length, offset);
          return buffer.subarray(0, bytesRead);
        },
        text: false,
        filename: info.filename,
        clientType: info.clientType,
        maxImagePixels: MAX_PHOTO_EDGE * MAX_PHOTO_EDGE,
      }).catch((error: unknown) => {
        if (error instanceof SniffError)
          throw new AppError(
            error.reason === "too_large"
              ? ErrorCode.PAYLOAD_TOO_LARGE
              : ErrorCode.UNSUPPORTED_MEDIA_TYPE,
            "Use a PNG, JPEG or WebP image",
          );
        throw error;
      });
      if (!PHOTO_TYPES.has(sniffed.mediaType))
        throw new AppError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "Use a PNG, JPEG or WebP image");
      await handle.close();
      handle = null;
      return await this.lock(userId, async () => {
        await rename(temp, this.paths.profilePhoto(userId));
        const next: Profile = {
          ...(await this.get(userId)),
          photo: {
            mediaType: sniffed.mediaType,
            size,
            sha256: hash.digest("hex"),
            updatedAt: this.now().toISOString(),
          },
        };
        await this.write(userId, next);
        return next;
      });
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  async removePhoto(userId: string): Promise<Profile> {
    return this.lock(userId, async () => {
      const next = { ...(await this.get(userId)), photo: null };
      await this.write(userId, next);
      await rm(this.paths.profilePhoto(userId), { force: true });
      return next;
    });
  }
}
