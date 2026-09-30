import { z } from "zod";
import type { Logger } from "../logger.ts";
import { atomicWrite, ensureDir, readOrNull } from "../storage/fs.ts";
import type { DataPaths } from "../storage/paths.ts";
import { checkUrl, SsrfError, type SsrfPolicy } from "./ssrf.ts";

/** Typed capabilities shared by provider configuration and model metadata. */
export const capabilitiesSchema = z.strictObject({
  inputModalities: z
    .array(z.enum(["text", "image", "audio"]))
    .min(1)
    .max(3),
  reasoning: z.boolean(),
  tools: z.boolean(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export const providerEntrySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "ids are 1-64 of a-z 0-9 _ -"),
  name: z.string().trim().min(1).max(100),
  kind: z.literal("openai-compatible"),
  baseUrl: z.string().max(2048),
  /** Secret: never logged, never returned by any API. */
  apiKey: z.string().min(1).max(4096).optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
  maxActiveGenerations: z.number().int().min(1).max(1_000).optional(),
  capabilities: capabilitiesSchema,
  contextTokens: z.number().int().min(256).max(10_000_000).optional(),
  /**
   * The server accepts llama.cpp's extra sampling fields (top_k, min_p,
   * repeat_penalty). Default true; set false for plain OpenAI-compatible APIs.
   */
  samplingExtensions: z.boolean().optional(),
});
export type ProviderEntry = z.infer<typeof providerEntrySchema>;

export interface LoadedProviders {
  valid: ProviderEntry[];
  /** Entries that failed validation: disabled and logged, never fatal. */
  invalid: { id: string | null; name: string | null; reason: string }[];
  bootstrapped: boolean;
}

function describe(entry: unknown): { id: string | null; name: string | null } {
  const e = entry as { id?: unknown; name?: unknown } | null;
  return {
    id: typeof e?.id === "string" ? e.id.slice(0, 64) : null,
    name: typeof e?.name === "string" ? e.name.slice(0, 100) : null,
  };
}

/**
 * Loads `_system/providers.json`. When missing, bootstraps one `local`
 * provider from LLAMA_BASE_URL/LLAMA_API_KEY (Phase 2–4 behaviour); from then
 * on the file is authoritative. Invalid entries (schema, duplicate id, or a
 * URL the SSRF policy refuses) are disabled and logged.
 */
export async function loadProviders(options: {
  paths: DataPaths;
  policy: SsrfPolicy;
  logger: Logger;
  bootstrap: { baseUrl: string | undefined; apiKey: string | undefined };
}): Promise<LoadedProviders> {
  const file = `${options.paths.systemDir()}/providers.json`;
  const bytes = await readOrNull(file);
  let bootstrapped = false;
  let raw: unknown;
  if (!bytes) {
    const { baseUrl, apiKey } = options.bootstrap;
    const providers: ProviderEntry[] = baseUrl
      ? [
          {
            id: "local",
            name: "Local llama.cpp",
            kind: "openai-compatible",
            baseUrl,
            ...(apiKey ? { apiKey } : {}),
            capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
          },
        ]
      : [];
    raw = { version: 1, providers };
    await ensureDir(options.paths.systemDir());
    await atomicWrite(file, `${JSON.stringify(raw, null, 2)}\n`);
    bootstrapped = true;
    options.logger.info({ providers: providers.length }, "bootstrapped providers.json");
  } else {
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch {
      options.logger.error("providers.json is not valid JSON; no providers are enabled");
      return {
        valid: [],
        invalid: [{ id: null, name: null, reason: "providers.json is not valid JSON" }],
        bootstrapped,
      };
    }
  }
  const list = (raw as { version?: unknown; providers?: unknown } | null)?.providers;
  if ((raw as { version?: unknown } | null)?.version !== 1 || !Array.isArray(list)) {
    options.logger.error(
      "providers.json must be { version: 1, providers: [...] }; no providers are enabled",
    );
    return {
      valid: [],
      invalid: [{ id: null, name: null, reason: "unexpected file shape" }],
      bootstrapped,
    };
  }
  const valid: ProviderEntry[] = [];
  const invalid: LoadedProviders["invalid"] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const parsed = providerEntrySchema.safeParse(entry);
    let reason: string | undefined;
    if (!parsed.success) {
      reason = parsed.error.issues
        .map((i) => `${i.path.join(".") || "entry"}: ${i.message}`)
        .join("; ");
    } else if (seen.has(parsed.data.id)) {
      reason = "duplicate id";
    } else {
      try {
        checkUrl(parsed.data.baseUrl, options.policy);
      } catch (error) {
        reason = error instanceof SsrfError ? `baseUrl: ${error.message}` : "baseUrl is invalid";
      }
    }
    if (reason !== undefined || !parsed.success) {
      invalid.push({ ...describe(entry), reason: reason ?? "invalid" });
      options.logger.warn(
        { provider: describe(entry).id, reason },
        "provider disabled: invalid configuration",
      );
      continue;
    }
    seen.add(parsed.data.id);
    valid.push({ ...parsed.data, baseUrl: parsed.data.baseUrl.replace(/\/+$/, "") });
  }
  return { valid, invalid, bootstrapped };
}
