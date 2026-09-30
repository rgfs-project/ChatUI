import { createHash } from "node:crypto";
import type { Provider } from "../providers/types.ts";
import { estimateCounter, mediaCount, type PromptMessage, type TokenCounter } from "./prompt.ts";

const CACHE_LIMIT = 10_000;

/**
 * Counts through the model's own chat template and tokenizer (llama-server
 * `/apply-template` + `/tokenize`, docs/provider-notes.md). Group costs are
 * cached by content so each turn only tokenizes new history.
 */
export class ProviderTokenCounter implements TokenCounter {
  readonly exact = true;
  private readonly cache = new Map<string, number>();
  private readonly provider: Provider;
  private readonly model: string;
  private readonly overhead: number;
  /** Image/audio parts are not tokenized: each counts this reserve (contracts §7). */
  private readonly mediaReserve: number;

  constructor(
    provider: Provider,
    model: string,
    templateOverheadTokens: number,
    mediaTokenReserve = 0,
  ) {
    this.provider = provider;
    this.model = model;
    this.overhead = templateOverheadTokens;
    this.mediaReserve = mediaTokenReserve;
  }

  private async tokens(text: string): Promise<number> {
    const key = createHash("sha256").update(`${this.model}\u0000${text}`).digest("hex");
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const count = await this.provider.tokenize(this.model, text);
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, count);
    return count;
  }

  async countGroup(messages: PromptMessage[]): Promise<number> {
    const counts = await Promise.all(messages.map((m) => this.tokens(m.content)));
    return counts.reduce(
      (sum, n, i) =>
        sum +
        n +
        this.overhead +
        mediaCount(messages[i] ?? { role: "user", content: "" }) * this.mediaReserve,
      0,
    );
  }

  async countPrompt(messages: PromptMessage[]): Promise<number> {
    // The template is applied to the text only; media parts add their reserve.
    const prompt = await this.provider.applyTemplate(
      this.model,
      messages.map((m) => ({ role: m.role, content: m.content })),
    );
    const media = messages.reduce((sum, m) => sum + mediaCount(m), 0);
    return (
      (await this.provider.tokenize(this.model, prompt, { special: true })) +
      media * this.mediaReserve
    );
  }
}

/** Picks exact counting when the provider supports it, else the byte estimate. */
export async function counterFor(
  provider: Provider,
  model: string,
  templateOverheadTokens: number,
  mediaTokenReserve = 0,
): Promise<TokenCounter> {
  try {
    await provider.tokenize(model, "probe");
    return new ProviderTokenCounter(provider, model, templateOverheadTokens, mediaTokenReserve);
  } catch {
    return estimateCounter(templateOverheadTokens, mediaTokenReserve);
  }
}
