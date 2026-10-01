// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FEATURES, modelProvides } from "../../shared/features";
import type { ModelListDto } from "../../shared/generations";

/** INV-52: every feature's origin is stated truthfully, and unavailable ones are never offered. */

afterEach(cleanup);

const caps = (inputModalities: string[], reasoning: boolean, tools: boolean) => ({
  capabilities: { inputModalities, reasoning, tools },
  capabilitySources: { inputModalities: "config", reasoning: "config", tools: "config" },
});

const MODELS = {
  providers: [
    {
      provider: {
        id: "local",
        name: "Local",
        status: "ok",
        capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
      },
      stale: false,
      models: [
        {
          providerId: "local",
          id: "plain",
          contextTokens: 4096,
          status: "loaded",
          ...caps(["text"], false, false),
        },
        {
          providerId: "local",
          id: "seer",
          contextTokens: 4096,
          status: "loaded",
          ...caps(["text", "image"], true, false),
        },
        {
          providerId: "local",
          id: "helper",
          contextTokens: 4096,
          status: "loaded",
          ...caps(["text"], false, true),
        },
      ],
    },
  ],
} as unknown as ModelListDto;

describe("feature register", () => {
  it("classifies every feature once, and model features name their capability", () => {
    const ids = FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const feature of FEATURES) {
      if (feature.origin === "model") expect(feature.requires).toBeDefined();
      else expect(feature.requires).toBeUndefined();
    }
    for (const id of ["web", "voice", "image-generation", "code-execution", "study"])
      expect(FEATURES.find((f) => f.id === id)?.origin).toBe("unavailable");
    for (const id of ["math", "code", "markdown", "search"])
      expect(FEATURES.find((f) => f.id === id)?.origin).toBe("chatui");
  });

  it("reads model capabilities", () => {
    const [plain, seer, helper] = MODELS.providers.flatMap((group) => group.models);
    if (!plain || !seer || !helper) throw new Error("fixture models");
    expect(modelProvides(plain, "image")).toBe(false);
    expect(modelProvides(seer, "image")).toBe(true);
    expect(modelProvides(seer, "audio")).toBe(false);
    expect(modelProvides(seer, "reasoning")).toBe(true);
    expect(modelProvides(helper, "tools")).toBe(true);
  });
});

describe("the UI never implies unavailable tools", () => {
  it("no component offers web search, voice, image generation or code running", () => {
    const dir = path.join(import.meta.dirname, "../../app");
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) =>
      f.endsWith(".tsx"),
    );
    const offers =
      /["'>]\s*(Search the web|Web search|Deep research|Research mode|Study mode|Voice mode|Start voice|Generate (an )?image|Run code|Run preview)\b/i;
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), "utf8");
      expect(source, file).not.toMatch(offers);
    }
  });
});
