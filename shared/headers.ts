/**
 * Headers every state-changing request carries (contracts §5). Kept apart
 * from shared/auth.ts so the browser can use them without loading zod.
 */
export const CSRF_HEADER = "X-CSRF-Token";
export const EXPECTED_USER_HEADER = "X-Expected-User";
