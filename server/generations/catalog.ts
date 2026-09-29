import { ErrorCode } from "@shared/errors";
import type { ModelDto, ProviderDto, ProviderModelsDto } from "@shared/generations";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { ProviderEntry } from "../providers/config.ts";
import { ProviderError, type Provider, type ProviderModel } from "../providers/types.ts";

/** How long a successful discovery is fresh; older lists are served while revalidating. */
export const DISCOVERY_TTL_MS = 30_000;

export interface RegisteredProvider {
  entry: ProviderEntry;
  provider: Provider;
}

interface CacheState {
  models: ProviderModel[] | null;
  fetchedAt: number;
  /** The last refresh failed; `models` is the last good list. */
  stale: boolean;
  refreshing: Promise<void> | null;
}

/**
 * Server-side model discovery per provider (Phase 5). The model key is
 * `(providerId, modelId)`; ids are opaque. Only a successful response
 * replaces a list; a failed refresh keeps the last good list marked stale,
 * and a provider that never answered is `unavailable` with no models.
 * Discovery never blocks startup.
 */
export class ModelCatalog {
  private readonly providers = new Map<string, RegisteredProvider>();
  private invalid: { id: string | null; name: string | null }[];
  private readonly cache = new Map<string, CacheState>();
  private readonly defaultContextTokens: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly onDiscovered: (providerId: string, provider: Provider) => void;

  constructor(options: {
    providers: RegisteredProvider[];
    invalid?: { id: string | null; name: string | null }[];
    defaultContextTokens: number;
    logger: Logger;
    now?: () => number;
    /** Called after each successful discovery (e.g. to learn slot counts). */
    onDiscovered?: (providerId: string, provider: Provider) => void;
  }) {
    for (const p of options.providers) this.providers.set(p.entry.id, p);
    this.invalid = options.invalid ?? [];
    this.defaultContextTokens = options.defaultContextTokens;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.onDiscovered = options.onDiscovered ?? (() => undefined);
  }

  /** Installs the loaded provider configuration (startup, before serving). */
  configure(
    providers: RegisteredProvider[],
    invalid: { id: string | null; name: string | null }[],
  ): void {
    this.providers.clear();
    this.cache.clear();
    for (const p of providers) this.providers.set(p.entry.id, p);
    this.invalid = invalid;
  }

  providerIds(): string[] {
    return [...this.providers.keys()];
  }

  entry(providerId: string): ProviderEntry | undefined {
    return this.providers.get(providerId)?.entry;
  }

  /** The provider for an id, or PROVIDER_NOT_FOUND (unknown, removed or invalid). */
  provider(providerId: string): Provider {
    const registered = this.providers.get(providerId);
    if (!registered)
      throw new AppError(ErrorCode.PROVIDER_NOT_FOUND, "The selected provider is not available");
    return registered.provider;
  }

  private state(providerId: string): CacheState {
    let state = this.cache.get(providerId);
    if (!state) {
      state = { models: null, fetchedAt: 0, stale: false, refreshing: null };
      this.cache.set(providerId, state);
    }
    return state;
  }

  /** Refreshes one provider's list (deduplicated while in flight). */
  refresh(providerId: string): Promise<void> {
    const registered = this.providers.get(providerId);
    if (!registered) return Promise.resolve();
    const state = this.state(providerId);
    state.refreshing ??= registered.provider
      .listModels()
      .then(
        (models) => {
          state.models = models;
          state.fetchedAt = this.now();
          state.stale = false;
          this.onDiscovered(providerId, registered.provider);
        },
        (error: unknown) => {
          state.stale = state.models !== null;
          state.fetchedAt = this.now();
          this.logger.warn(
            { providerId, reason: error instanceof ProviderError ? error.kind : "error" },
            state.models
              ? "model refresh failed; keeping the last good list"
              : "provider unavailable",
          );
        },
      )
      .finally(() => {
        state.refreshing = null;
      });
    return state.refreshing;
  }

  /** Starts discovery for every provider without waiting (startup). */
  warmUp(): void {
    for (const id of this.providers.keys()) void this.refresh(id);
  }

  private isFresh(state: CacheState): boolean {
    return state.fetchedAt > 0 && this.now() - state.fetchedAt <= DISCOVERY_TTL_MS;
  }

  private toModelDto(entry: ProviderEntry, model: ProviderModel): ModelDto {
    const discovered = model.inputModalities;
    const inputModalities: ("text" | "image" | "audio")[] =
      discovered ?? entry.capabilities.inputModalities;
    return {
      providerId: entry.id,
      id: model.id,
      contextTokens: model.contextTokens ?? entry.contextTokens ?? this.defaultContextTokens,
      status: model.status,
      capabilities: {
        // Text is the baseline; unverified optional capabilities are false.
        inputModalities: inputModalities.includes("text")
          ? inputModalities
          : ["text", ...inputModalities],
        reasoning: entry.capabilities.reasoning,
        tools: entry.capabilities.tools,
      },
      capabilitySources: {
        inputModalities: discovered ? "discovery" : "config",
        reasoning: "config",
        tools: "config",
      },
    };
  }

  private providerDto(entry: ProviderEntry): ProviderDto {
    const state = this.state(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      status:
        state.models === null
          ? state.fetchedAt === 0
            ? "pending"
            : "unavailable"
          : state.stale
            ? "stale"
            : "ok",
      capabilities: entry.capabilities,
    };
  }

  /** Non-sensitive provider list (never baseUrl or apiKey). */
  listProviders(): ProviderDto[] {
    const valid = [...this.providers.values()].map((p) => this.providerDto(p.entry));
    const invalid: ProviderDto[] = this.invalid.map((p, index) => ({
      id: p.id ?? `invalid-${String(index + 1)}`,
      name: p.name ?? "Invalid provider",
      status: "invalid",
      capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
    }));
    return [...valid, ...invalid];
  }

  /**
   * Models grouped by provider. Stale-while-revalidate: a cached list is
   * returned immediately while an expired one refreshes in the background;
   * a provider with no list yet is awaited (bounded by the discovery timeout).
   */
  async listModels(options: { fresh?: boolean } = {}): Promise<ProviderModelsDto[]> {
    await Promise.all(
      [...this.providers.keys()].map(async (id) => {
        const state = this.state(id);
        if (options.fresh === true || state.models === null) await this.refresh(id);
        else if (!this.isFresh(state)) void this.refresh(id);
      }),
    );
    return [...this.providers.values()].map(({ entry }) => {
      const state = this.state(entry.id);
      const provider = this.providerDto(entry);
      return {
        provider,
        stale: state.stale,
        models: (state.models ?? []).map((m) => this.toModelDto(entry, m)),
      };
    });
  }

  /**
   * Validates a browser-supplied pair against the server-side cache,
   * refreshing that provider once on a miss (INV-18).
   */
  async resolve(providerId: string, modelId: string): Promise<ModelDto> {
    const registered = this.providers.get(providerId);
    if (!registered)
      throw new AppError(ErrorCode.PROVIDER_NOT_FOUND, "The selected provider is not available");
    const state = this.state(providerId);
    let found = state.models?.find((m) => m.id === modelId);
    if (!found) {
      await this.refresh(providerId);
      found = state.models?.find((m) => m.id === modelId);
    }
    if (!found) {
      if (state.models === null) {
        throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, "The model server is unreachable");
      }
      throw new AppError(ErrorCode.MODEL_NOT_FOUND, "The selected model is not available");
    }
    return this.toModelDto(registered.entry, found);
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ProviderError) return new AppError(error.code, error.message);
  return new AppError(ErrorCode.PROVIDER_UNAVAILABLE, "The model server is unreachable");
}
