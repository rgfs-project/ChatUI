import { z } from "zod";

/** Browser-safe session bootstrap (contracts §5): never the cookie or its hash. */
export interface SessionDto {
  user: { id: string; username: string; role: "user" | "admin" } | null;
  /** Synchronizer token for X-CSRF-Token; null when signed out. */
  csrfToken: string | null;
  registrationOpen: boolean;
}

export const sessionDtoSchema = z.strictObject({
  user: z
    .strictObject({ id: z.uuid(), username: z.string(), role: z.enum(["user", "admin"]) })
    .nullable(),
  csrfToken: z.string().nullable(),
  registrationOpen: z.boolean(),
});

const username = z.string().trim().min(1).max(64);
const password = z.string().min(1).max(256);

export const loginRequestSchema = z.strictObject({ username, password });
export const registerRequestSchema = z.strictObject({ username, password });
export const changePasswordRequestSchema = z.strictObject({
  currentPassword: password,
  newPassword: password,
});

/** Headers every state-changing request carries (contracts §5). */
export const CSRF_HEADER = "X-CSRF-Token";
export const EXPECTED_USER_HEADER = "X-Expected-User";
