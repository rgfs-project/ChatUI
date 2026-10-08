import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "@shared/conversations";
import type { GenerationSnapshot, ModelListDto } from "@shared/generations";
import { safeReturnTo } from "../../app/lib/api";
import { applyEvent } from "../../app/lib/generation";
import { modelLabel, resolveModel } from "../../app/lib/models";
import { documentPathOf, paths } from "../../app/lib/paths";
import { splitConversations } from "../../app/components/Sidebar";
import { matchCommands } from "../../app/components/Composer";
import { formatBytes } from "../../app/lib/format";

const snapshot = (over: Partial<GenerationSnapshot> = {}): GenerationSnapshot => ({
  generationId: "00000000-0000-4000-8000-000000000001",
  assistantMessageId: "00000000-0000-4000-8000-000000000002",
  conversationId: "00000000-0000-4000-8000-000000000003",
  providerId: "local",
  model: "m",
  state: "streaming",
  content: "Hel",
  reasoning: "",
  finishReason: null,
  error: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
  revision: null,
  lastEventId: 1,
  ...over,
});

describe("applyEvent", () => {
  it("builds a reply from a snapshot and appends deltas", () => {
    let live = applyEvent(null, "snapshot", snapshot());
    live = applyEvent(live, "delta", { content: "lo", reasoning: "hm" });
    expect(live?.content).toBe("Hello");
    expect(live?.reasoning).toBe("hm");
    expect(live?.state).toBe("streaming");
  });

  it("ends with the terminal state and error", () => {
    const live = applyEvent(applyEvent(null, "snapshot", snapshot()), "terminal", {
      state: "failed",
      finishReason: null,
      error: { code: "PROVIDER_ERROR", message: "boom" },
      revision: null,
    });
    expect(live?.state).toBe("failed");
    expect(live?.error?.message).toBe("boom");
  });

  it("a resync replaces everything; deltas before any snapshot are ignored", () => {
    expect(applyEvent(null, "delta", { content: "x" })).toBeNull();
    const live = applyEvent(
      applyEvent(null, "snapshot", snapshot()),
      "resync",
      snapshot({ content: "Fresh" }),
    );
    expect(live?.content).toBe("Fresh");
  });
});

const models: ModelListDto = {
  defaultModel: { providerId: "local", modelId: "b" },
  providers: [
    {
      provider: {
        id: "local",
        name: "Local",
        status: "ok",
        capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
      },
      stale: false,
      models: ["a", "b"].map((id) => ({
        providerId: "local",
        id,
        contextTokens: 4096,
        status: "unknown" as const,
        capabilities: { inputModalities: ["text" as const], reasoning: false, tools: false },
        capabilitySources: {
          inputModalities: "config" as const,
          reasoning: "config" as const,
          tools: "config" as const,
        },
      })),
    },
  ],
};

describe("resolveModel", () => {
  it("prefers the first available candidate", () => {
    expect(resolveModel(models, [{ providerId: "local", model: "a" }])).toEqual({
      providerId: "local",
      model: "a",
    });
  });
  it("skips unknown candidates and falls back to the instance default", () => {
    expect(resolveModel(models, [{ providerId: "x", model: "y" }, null])).toEqual({
      providerId: "local",
      model: "b",
    });
  });
  it("is null without models", () => {
    expect(resolveModel(undefined, [])).toBeNull();
  });
  it("labels models by their last path segment", () => {
    expect(modelLabel("org/Qwen3-8B.gguf")).toBe("Qwen3-8B");
  });
});

describe("sidebar order", () => {
  const c = (id: string, updatedAt: string, pinnedRank: number | null): ConversationSummary => ({
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 2,
    malformed: false,
    pinnedRank,
  });
  it("pins first in pin order, then recents newest first", () => {
    const { pinned, recents } = splitConversations([
      c("old", "2026-01-01", null),
      c("p2", "2026-01-05", 1),
      c("new", "2026-01-09", null),
      c("p1", "2026-01-02", 0),
    ]);
    expect(pinned.map((x) => x.id)).toEqual(["p1", "p2"]);
    expect(recents.map((x) => x.id)).toEqual(["new", "old"]);
  });
});

describe("slash commands", () => {
  const skill = {
    id: "00000000-0000-4000-8000-000000000009",
    name: "summarize",
    description: "Sum it up",
    instructions: "x",
    enabled: true,
    createdAt: "",
    updatedAt: "",
  };
  it("lists skills first, then built-ins, filtered by prefix", () => {
    expect(matchCommands("", [skill], true).map((c) => c.name)).toEqual([
      "summarize",
      "model",
      "new",
      "rename",
      "delete",
      "settings",
    ]);
    expect(matchCommands("s", [skill], true).map((c) => c.name)).toEqual(["summarize", "settings"]);
  });
  it("leaves out chat-only commands in a new chat and disabled skills", () => {
    const names = matchCommands("", [{ ...skill, enabled: false }], false).map((c) => c.name);
    expect(names).toEqual(["model", "new", "settings"]);
  });
});

describe("paths", () => {
  it("encodes ids and return-to values", () => {
    expect(paths.chat("a/b")).toBe("/chat/a%2Fb");
    expect(paths.login("/chat/x")).toBe("/login?returnTo=%2Fchat%2Fx");
  });
  it("maps data requests to their document", () => {
    expect(documentPathOf("http://h/chat/abc.data?_routes=x")).toBe("/chat/abc");
    expect(documentPathOf("http://h/_root.data")).toBe("/");
  });
  it("only accepts in-app return-to paths", () => {
    expect(safeReturnTo("//evil.example/")).toBe("/chat");
    expect(safeReturnTo("https://evil.example/")).toBe("/chat");
    expect(safeReturnTo("/settings?section=data")).toBe("/settings?section=data");
  });
});

describe("formatBytes", () => {
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
  });
});

describe("escapeCurrency", () => {
  it("keeps prices literal and real math as math", async () => {
    const { escapeCurrency } = await import("../../app/lib/format");
    expect(escapeCurrency("your $350 card beats the $8,000 one")).toBe(
      "your \\$350 card beats the \\$8,000 one",
    );
    expect(escapeCurrency("area $x^2$ here")).toBe("area $x^2$ here");
    expect(escapeCurrency("costs $5")).toBe("costs \\$5");
    expect(escapeCurrency("$$a+b$$ and `$1 $2`")).toBe("$$a+b$$ and `$1 $2`");
    expect(escapeCurrency("an escaped \\$5 stays")).toBe("an escaped \\$5 stays");
  });
});
