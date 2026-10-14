import { z } from "zod";
import { AVATAR_COLOR_NAMES, type AvatarColor } from "./avatar";

export { AVATAR_COLOR_NAMES, AVATAR_COLORS, photoUrl, type AvatarColor } from "./avatar";

/**
 * The signed-in user's profile (Settings → Account): a display name and email
 * of their own choosing, a photo or coloured initials, and their username.
 * Browser code imports only the types and constants.
 */
export const ACCOUNT_LIMITS = {
  displayName: 60,
  email: 254,
  /** A profile photo, after the browser has cropped and shrunk it. */
  photoBytes: 1024 * 1024,
  /** The longest side the browser shrinks a photo to. */
  photoEdge: 256,
} as const;

/** Photos are stored and served as one of these. */
export const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

export const accountDtoSchema = z.strictObject({
  id: z.uuid(),
  username: z.string(),
  role: z.enum(["user", "admin"]),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  avatarColor: z.enum(AVATAR_COLOR_NAMES as [AvatarColor, ...AvatarColor[]]),
  /** Changes whenever the photo does (cache key for its URL); null when there is none. */
  photoVersion: z.string().nullable(),
  createdAt: z.string(),
});
export type AccountDto = z.infer<typeof accountDtoSchema>;

export const updateAccountSchema = z
  .strictObject({
    displayName: z.string().trim().max(ACCOUNT_LIMITS.displayName).nullable(),
    email: z
      .union([z.literal(""), z.email().max(ACCOUNT_LIMITS.email)])
      .nullable()
      .transform((value) => (value === "" ? null : value)),
    username: z.string().trim().toLowerCase().min(3).max(32),
    avatarColor: z.enum(AVATAR_COLOR_NAMES as [AvatarColor, ...AvatarColor[]]),
  })
  .partial();
export type UpdateAccount = z.input<typeof updateAccountSchema>;
