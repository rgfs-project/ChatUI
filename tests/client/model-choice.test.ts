import { describe, expect, it } from "vitest";
import type { ConversationDto } from "@shared/conversations";
import type { ProviderModelsDto } from "@shared/generations";
import { chooseModel } from "../../app/chat/model-choice";

const caps = { inputModalities: ["text" as const], reasoning: false, tools: false };
const model = (providerId: string, id: string, status: "loaded" | "unloaded" = "unloaded") => ({
  providerId,
  id,
  contextTokens: 4096,
  status,
  capabilities: caps,
  capabilitySources: {
    inputModalities: "config" as const,
    reasoning: "config" as const,
    tools: "config" as const,
  },
});
const groups: ProviderModelsDto[] = [
  {
    provider: { id: "a", name: "A", status: "ok", capabilities: caps },
    stale: false,
    models: [model("a", "one"), model("a", "two", "loaded")],
  },
  {
    provider: { id: "b", name: "B", status: "ok", capabilities: caps },
    stale: false,
    models: [model("b", "one")],
  },
];
const conversation = (provider: string, m: string): ConversationDto => ({
  id: "0b7e7c2a-1111-4a1a-8a1a-111111111111",
  title: "t",
  createdAt: "",
  updatedAt: "",
  revision: "0".repeat(64),
  activeGeneration: null,
  proposals: [],
  temporary: false,
  messages: [
    {
      id: "0b7e7c2a-1111-4a1a-8a1a-222222222222",
      role: "assistant",
      content: "x",
      reasoning: null,
      status: "complete",
      provider,
      model: m,
      attachments: [],
      time: null,
      tools: [],
      artifacts: [],
    },
  ],
});

describe("model selection order", () => {
  it("tab choice → conversation's last reply → last used → preference → loaded model", () => {
    expect(
      chooseModel({ groups, chosen: ["b", "one"], conversation: conversation("a", "one") }),
    ).toEqual(["b", "one"]);
    expect(
      chooseModel({ groups, conversation: conversation("a", "one"), lastUsed: ["b", "one"] }),
    ).toEqual(["a", "one"]);
    expect(chooseModel({ groups, lastUsed: ["b", "one"] })).toEqual(["b", "one"]);
    expect(
      chooseModel({
        groups,
        preferences: {
          pins: [],
          defaultProvider: "a",
          defaultModel: "one",
          historyImages: null,
          imageMaxEdge: null,
        },
      }),
    ).toEqual(["a", "one"]);
    expect(chooseModel({ groups })).toEqual(["a", "two"]);
  });

  it("pairs that are no longer offered are skipped, never sent", () => {
    expect(chooseModel({ groups, chosen: ["gone", "x"], lastUsed: ["a", "missing"] })).toEqual([
      "a",
      "two",
    ]);
    expect(chooseModel({ groups: [] })).toBeNull();
  });
});
