import { z } from "zod";

/** Canonical lowercase UUID, the only id form storage accepts (contracts §1). */
export const canonicalUuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "must be a canonical lowercase UUID",
  );
