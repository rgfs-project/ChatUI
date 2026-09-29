import { ErrorCode } from "@shared/errors";
import type { ModelDto } from "@shared/generations";
import { AppError } from "../errors.ts";
import type { Provider, ProviderModel } from "../providers/types.ts";
import { ProviderError } from "../providers/types.ts";

/** How long a successful model discovery is reused before asking the provider again. */
const CACHE_TTL_MS = 30_000;

/**
 * Discovered models. Every generation's model must be in this list; a miss
 * refreshes discovery once before failing with MODEL_NOT_FOUND.
 */
export class ModelCatalog {
  private cache: { models: ProviderModel[]; at: number } | undefined;
  private inflight: Promise<ProviderModel[]> | undefined;

  private readonly provider: Provider;
  private readonly defaultContextTokens: number;
  private readonly now: () => number;

  constructor(provider: Provider, defaultContextTokens: number, now: () => number = Date.now) {
    this.provider = provider;
    this.defaultContextTokens = defaultContextTokens;
    this.now = now;
  }

  private async refresh(): Promise<ProviderModel[]> {
    this.inflight ??= this.provider
      .listModels()
      .then((models) => {
        this.cache = { models, at: this.now() };
        return models;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  /** Current model list (cached briefly). Throws a normalized AppError on provider failure. */
  async list(options: { fresh?: boolean } = {}): Promise<ModelDto[]> {
    try {
      const fresh =
        options.fresh === true || !this.cache || this.now() - this.cache.at > CACHE_TTL_MS;
      const models = fresh ? await this.refresh() : (this.cache?.models ?? []);
      return models.map((model) => this.toDto(model));
    } catch (error) {
      throw toAppError(error);
    }
  }

  /** Resolves a model id against discovery, refreshing once on a miss. */
  async resolve(modelId: string): Promise<ModelDto> {
    const cached = this.cache?.models.find((model) => model.id === modelId);
    if (cached && this.cache && this.now() - this.cache.at <= CACHE_TTL_MS)
      return this.toDto(cached);
    const models = await this.list({ fresh: true });
    const found = models.find((model) => model.id === modelId);
    if (!found)
      throw new AppError(ErrorCode.MODEL_NOT_FOUND, "The selected model is not available");
    return found;
  }

  private toDto(model: ProviderModel): ModelDto {
    return {
      id: model.id,
      contextTokens: model.contextTokens ?? this.defaultContextTokens,
      status: model.status,
    };
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ProviderError) return new AppError(error.code, error.message);
  return new AppError(ErrorCode.PROVIDER_UNAVAILABLE, "The model server is unreachable");
}
