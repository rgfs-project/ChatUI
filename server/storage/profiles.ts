// The user's own profile (`<user>/profile.json` and `<user>/profile-photo`):
// how they appear, never used for authorization.
import { randomBytes } from "node:crypto";
import { ACCOUNT_LIMITS, PHOTO_TYPES, type PhotoType } from "@shared/account";
import { isAvatarColor, type AvatarColor } from "@shared/avatar";
import type { AccountWrites } from "./account.ts";
import { atomicWrite, durableUnlink, readOrNull } from "./fs.ts";
import type { KeyedLocks } from "./locks.ts";
import type { DataPaths } from "./paths.ts";

export interface Profile {
  displayName: string | null;
  email: string | null;
  avatarColor: AvatarColor;
  photo: { type: PhotoType; version: string } | null;
}

const DEFAULT_COLOR: AvatarColor = "black";

function sanitize(raw: unknown): Profile {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
  const photo = r.photo as Record<string, unknown> | null | undefined;
  return {
    displayName: text(r.displayName, ACCOUNT_LIMITS.displayName),
    email: text(r.email, ACCOUNT_LIMITS.email),
    avatarColor: isAvatarColor(r.avatarColor) ? r.avatarColor : DEFAULT_COLOR,
    photo:
      photo &&
      typeof photo === "object" &&
      (PHOTO_TYPES as readonly unknown[]).includes(photo.type) &&
      typeof photo.version === "string" &&
      /^[0-9a-f]{16}$/.test(photo.version)
        ? { type: photo.type as PhotoType, version: photo.version }
        : null,
  };
}

/** Recognizes the three photo formats by their bytes, not the declared type. */
export function sniffPhoto(bytes: Uint8Array): PhotoType | null {
  const at = (i: number) => bytes[i];
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

export class ProfileStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;
  private readonly writes: AccountWrites | undefined;
  /** Read on every authenticated request (the session carries it), so cached. */
  private readonly cache = new Map<string, Profile>();

  constructor(options: { paths: DataPaths; locks: KeyedLocks; writes?: AccountWrites }) {
    this.paths = options.paths;
    this.locks = options.locks;
    this.writes = options.writes;
  }

  async get(userId: string): Promise<Profile> {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    const bytes = await readOrNull(this.paths.profileFile(userId));
    let profile: Profile;
    try {
      profile = sanitize(bytes ? JSON.parse(bytes.toString("utf8")) : null);
    } catch {
      profile = sanitize(null);
    }
    this.cache.set(userId, profile);
    return profile;
  }

  /** Forgets a closed account's cached profile. */
  forget(userId: string): void {
    this.cache.delete(userId);
  }

  private async modify(
    userId: string,
    change: (current: Profile) => Promise<Profile> | Profile,
  ): Promise<Profile> {
    const write = () =>
      this.locks.run(`profile:${userId}`, async () => {
        this.cache.delete(userId);
        const next = await change(await this.get(userId));
        await atomicWrite(this.paths.profileFile(userId), `${JSON.stringify(next, null, 2)}\n`);
        this.cache.set(userId, next);
        return next;
      });
    return this.writes ? this.writes.run(userId, write) : write();
  }

  async update(
    userId: string,
    patch: Partial<Pick<Profile, "displayName" | "email" | "avatarColor">>,
  ): Promise<Profile> {
    return this.modify(userId, (current) => sanitize({ ...current, ...patch }));
  }

  /** Stores already-sniffed photo bytes; a new version busts caches. */
  async setPhoto(userId: string, bytes: Uint8Array, type: PhotoType): Promise<Profile> {
    return this.modify(userId, async (current) => {
      await atomicWrite(this.paths.profilePhotoFile(userId), bytes);
      return { ...current, photo: { type, version: randomBytes(8).toString("hex") } };
    });
  }

  async clearPhoto(userId: string): Promise<Profile> {
    return this.modify(userId, async (current) => {
      await durableUnlink(this.paths.profilePhotoFile(userId));
      return { ...current, photo: null };
    });
  }

  async readPhoto(
    userId: string,
  ): Promise<{ bytes: Buffer; type: PhotoType; version: string } | null> {
    const profile = await this.get(userId);
    if (!profile.photo) return null;
    const bytes = await readOrNull(this.paths.profilePhotoFile(userId));
    return bytes ? { bytes, ...profile.photo } : null;
  }
}
