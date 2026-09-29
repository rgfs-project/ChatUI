import { z } from "zod";

/** Response DTO for `GET /api/health`. Exposes no environment, paths or dependency versions. */
export const healthDtoSchema = z.strictObject({
  status: z.literal("ok"),
  version: z.string(),
});

export type HealthDto = z.infer<typeof healthDtoSchema>;
