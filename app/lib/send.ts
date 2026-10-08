import type { StartGenerationResponse } from "@shared/generations";
import { api, ApiError } from "./api";

/** Resends after an unknown outcome, with the same key and bytes. */
export const sendTiming = { retries: 3, baseMs: 1_000 };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Accepts a send or a regeneration. The operation key makes retries safe:
 * the server answers a repeat with the first result. A contract error other
 * than INTERNAL is final; anything else (network, INTERNAL) is retried.
 */
export async function accept(
  url: string,
  body: Record<string, unknown>,
): Promise<StartGenerationResponse> {
  const payload = JSON.stringify({
    ...body,
    operationKey: crypto.randomUUID(),
    operationIssuedAt: new Date().toISOString(),
  });
  for (let attempt = 0; ; attempt++) {
    try {
      return await api<StartGenerationResponse>(url, { method: "POST", body: payload });
    } catch (error) {
      const final =
        error instanceof ApiError && error.code !== undefined && error.code !== "INTERNAL";
      if (final || attempt >= sendTiming.retries) throw error;
    }
    await sleep(sendTiming.baseMs * (attempt + 1));
  }
}
