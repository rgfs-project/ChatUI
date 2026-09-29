import { ErrorCode } from "@shared/errors";
import { z } from "zod";
import { AppError } from "../errors.ts";
import type { ModelCatalog } from "../generations/catalog.ts";
import {
  capabilitiesSchema,
  providerEntrySchema,
  type ProviderEntry,
} from "../providers/config.ts";
import {
  checkUrl,
  resolveChecked,
  SsrfError,
  type Resolver,
  type SsrfPolicy,
} from "../providers/ssrf.ts";
import { ProviderError } from "../providers/types.ts";
import { atomicWrite, ensureDir, readOrNull } from "../storage/fs.ts";
import type { KeyedLocks } from "../storage/locks.ts";
import type { DataPaths } from "../storage/paths.ts";

/** What admins see of a provider: never the API key (INV-25). */
export interface AdminProviderDto {
  id: string;
  name: string;
  kind: "openai-compatible";
  baseUrl: string;
  hasApiKey: boolean;
  timeoutMs: number | null;
  maxActiveGenerations: number | null;
  contextTokens: number | null;
  samplingExtensions: boolean;
  capabilities: z.infer<typeof capabilitiesSchema>;
  status: "enabled" | "invalid";
  problem: string | null;
}

const editable = {
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().min(1).max(2048),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).nullable(),
  maxActiveGenerations: z.number().int().min(1).max(1_000).nullable(),
  contextTokens: z.number().int().min(256).max(10_000_000).nullable(),
  samplingExtensions: z.boolean(),
  capabilities: capabilitiesSchema,
};

export const providerCreateSchema = z.strictObject({
  id: providerEntrySchema.shape.id,
  ...editable,
  timeoutMs: editable.timeoutMs.optional(),
  maxActiveGenerations: editable.maxActiveGenerations.optional(),
  contextTokens: editable.contextTokens.optional(),
  samplingExtensions: editable.samplingExtensions.optional(),
  /** Write-only secret. */
  apiKey: z.string().min(1).max(4096).optional(),
});

/** Edit: `apiKey` replaces, `clearApiKey` removes, neither keeps the stored key. */
export const providerUpdateSchema = z
  .strictObject({
    name: editable.name.optional(),
    baseUrl: editable.baseUrl.optional(),
    timeoutMs: editable.timeoutMs.optional(),
    maxActiveGenerations: editable.maxActiveGenerations.optional(),
    contextTokens: editable.contextTokens.optional(),
    samplingExtensions: editable.samplingExtensions.optional(),
    capabilities: editable.capabilities.optional(),
    apiKey: z.string().min(1).max(4096).optional(),
    clearApiKey: z.literal(true).optional(),
  })
  .refine((v) => !(v.apiKey && v.clearApiKey), "Send either apiKey or clearApiKey, not both");

function stringField(raw: unknown, key: string): string | undefined {
  const value = (raw as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : undefined;
}

interface ProvidersFile {
  version: 1;
  providers: unknown[];
}

/**
 * Provider administration over `_system/providers.json` (Phase 10). Every
 * create/edit re-runs the full SSRF validation (syntax and resolution of
 * every address, INV-19); writes are atomic and the registry reloads
 * in-process. Secrets are write-only (INV-25).
 */
export class ProviderAdmin {
  private readonly o: {
    paths: DataPaths;
    locks: KeyedLocks;
    policy: SsrfPolicy;
    resolver: Resolver;
    catalog: ModelCatalog;
    /** Re-reads providers.json into the running registry. */
    reload: () => Promise<{ invalid: { id: string | null; reason: string }[] }>;
  };
  private lastInvalid: { id: string | null; reason: string }[] = [];

  constructor(options: ProviderAdmin["o"]) {
    this.o = options;
  }

  private get file(): string {
    return `${this.o.paths.systemDir()}/providers.json`;
  }

  private async read(): Promise<ProvidersFile> {
    const bytes = await readOrNull(this.file);
    if (!bytes) return { version: 1, providers: [] };
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as Partial<ProvidersFile>;
      if (parsed.version === 1 && Array.isArray(parsed.providers))
        return { version: 1, providers: parsed.providers };
    } catch {
      // fall through: an unreadable file is replaced only by an explicit save
    }
    throw new AppError(ErrorCode.CONFLICT, "providers.json is unreadable; fix it on disk first");
  }

  private async write(file: ProvidersFile): Promise<void> {
    await ensureDir(this.o.paths.systemDir());
    await atomicWrite(this.file, `${JSON.stringify(file, null, 2)}\n`);
    this.lastInvalid = (await this.o.reload()).invalid;
  }

  /** Full SSRF validation of a base URL: syntax, then every resolved address. */
  async validateUrl(raw: string): Promise<string> {
    try {
      const url = checkUrl(raw, this.o.policy);
      await resolveChecked(url, this.o.policy, this.o.resolver);
      return raw.replace(/\/+$/, "");
    } catch (error) {
      if (error instanceof SsrfError)
        throw new AppError(
          ErrorCode.ENDPOINT_NOT_ALLOWED,
          `Endpoint not allowed: ${error.message}`,
        );
      throw error;
    }
  }

  private dto(raw: unknown): AdminProviderDto | null {
    const parsed = providerEntrySchema.safeParse(raw);
    const entry = parsed.success ? parsed.data : null;
    const id = (raw as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return null;
    const invalid = this.lastInvalid.find((i) => i.id === id);
    const enabled = entry !== null && this.o.catalog.entry(id) !== undefined;
    return {
      id,
      name: entry?.name ?? stringField(raw, "name") ?? id,
      kind: "openai-compatible",
      baseUrl: entry?.baseUrl ?? stringField(raw, "baseUrl") ?? "",
      hasApiKey: typeof (raw as { apiKey?: unknown }).apiKey === "string",
      timeoutMs: entry?.timeoutMs ?? null,
      maxActiveGenerations: entry?.maxActiveGenerations ?? null,
      contextTokens: entry?.contextTokens ?? null,
      samplingExtensions: entry?.samplingExtensions ?? true,
      capabilities: entry?.capabilities ?? {
        inputModalities: ["text"],
        reasoning: false,
        tools: false,
      },
      status: enabled ? "enabled" : "invalid",
      problem: enabled ? null : (invalid?.reason ?? "invalid configuration"),
    };
  }

  async list(): Promise<AdminProviderDto[]> {
    const file = await this.read();
    return file.providers.map((p) => this.dto(p)).filter((p) => p !== null);
  }

  async create(input: z.infer<typeof providerCreateSchema>): Promise<AdminProviderDto> {
    const baseUrl = await this.validateUrl(input.baseUrl);
    return this.o.locks.run("providers", async () => {
      const file = await this.read();
      if (file.providers.some((p) => (p as { id?: unknown }).id === input.id))
        throw new AppError(ErrorCode.CONFLICT, "A provider with this id exists");
      const entry: ProviderEntry = providerEntrySchema.parse({
        id: input.id,
        name: input.name,
        kind: "openai-compatible",
        baseUrl,
        capabilities: input.capabilities,
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.maxActiveGenerations ? { maxActiveGenerations: input.maxActiveGenerations } : {}),
        ...(input.contextTokens ? { contextTokens: input.contextTokens } : {}),
        ...(input.samplingExtensions === undefined
          ? {}
          : { samplingExtensions: input.samplingExtensions }),
      });
      file.providers.push(entry);
      await this.write(file);
      return this.dto(entry) as AdminProviderDto;
    });
  }

  async update(id: string, patch: z.infer<typeof providerUpdateSchema>): Promise<AdminProviderDto> {
    const baseUrl = patch.baseUrl === undefined ? undefined : await this.validateUrl(patch.baseUrl);
    return this.o.locks.run("providers", async () => {
      const file = await this.read();
      const index = file.providers.findIndex((p) => (p as { id?: unknown }).id === id);
      if (index < 0) throw new AppError(ErrorCode.NOT_FOUND, "Provider not found");
      const current = { ...(file.providers[index] as Record<string, unknown>) };
      // Revalidate the stored URL too when it is kept (policy may have changed).
      if (baseUrl === undefined && typeof current.baseUrl === "string")
        await this.validateUrl(current.baseUrl);
      const removed = new Set<string>([
        ...(patch.clearApiKey ? ["apiKey"] : []),
        ...(["timeoutMs", "maxActiveGenerations", "contextTokens"] as const).filter(
          (key) => patch[key] === null,
        ),
      ]);
      const next: Record<string, unknown> = Object.fromEntries(
        Object.entries(current).filter(([key]) => !removed.has(key)),
      );
      if (patch.name !== undefined) next.name = patch.name;
      if (baseUrl !== undefined) next.baseUrl = baseUrl;
      if (patch.capabilities !== undefined) next.capabilities = patch.capabilities;
      if (patch.samplingExtensions !== undefined)
        next.samplingExtensions = patch.samplingExtensions;
      for (const key of ["timeoutMs", "maxActiveGenerations", "contextTokens"] as const) {
        const value = patch[key];
        if (value !== undefined && value !== null) next[key] = value;
      }
      if (patch.apiKey) next.apiKey = patch.apiKey;
      const entry = providerEntrySchema.parse(next);
      file.providers[index] = entry;
      await this.write(file);
      return this.dto(entry) as AdminProviderDto;
    });
  }

  async remove(id: string): Promise<void> {
    await this.o.locks.run("providers", async () => {
      const file = await this.read();
      const before = file.providers.length;
      file.providers = file.providers.filter((p) => (p as { id?: unknown }).id !== id);
      if (file.providers.length === before)
        throw new AppError(ErrorCode.NOT_FOUND, "Provider not found");
      await this.write(file);
    });
  }

  /** Connection test through the same SSRF-guarded client used for chat. */
  async test(id: string): Promise<{ ok: boolean; models: number; problem: string | null }> {
    const entry = this.o.catalog.entry(id);
    if (!entry) throw new AppError(ErrorCode.NOT_FOUND, "Provider not found or not enabled");
    await this.validateUrl(entry.baseUrl);
    try {
      const models = await this.o.catalog.provider(id).listModels(AbortSignal.timeout(15_000));
      return { ok: true, models: models.length, problem: null };
    } catch (error) {
      return {
        ok: false,
        models: 0,
        // Our own classification, never an upstream body (INV-04).
        problem: error instanceof ProviderError ? error.kind : "unreachable",
      };
    }
  }
}
