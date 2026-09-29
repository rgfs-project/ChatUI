import type { HealthDto } from "@shared/api";

/** Internal health service shared by the API route and the SSR document loader. */
export function createHealthService(version: string): () => HealthDto {
  return () => ({ status: "ok", version });
}
