import { createHash } from "node:crypto";
import type { Provider } from "../providers/types.ts";
import { estimateCounter, type PromptMessage, type TokenCounter } from "./prompt.ts";

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

  constructor(provider: Provider, model: string, templateOverheadTokens: number) {
    this.provider = provider;
    this.model = model;
    this.overhead = templateOverheadTokens;
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
    return counts.reduce((sum, n) => sum + n + this.overhead, 0);
  }

  async countPrompt(messages: PromptMessage[]): Promise<number> {
    const prompt = await this.provider.applyTemplate(this.model, messages);
    return this.provider.tokenize(this.model, prompt, { special: true });
  }
}

/** Picks exact counting when the provider supports it, else the byte estimate. */
export async function counterFor(
  provider: Provider,
  model: string,
  templateOverheadTokens: number,
): Promise<TokenCounter> {
  try {
    await provider.tokenize(model, "probe");
    return new ProviderTokenCounter(provider, model, templateOverheadTokens);
  } catch {
    return estimateCounter(templateOverheadTokens);
  }
}
