// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FEATURES, modelProvides } from "../../shared/features";
import type { ModelListDto } from "../../shared/generations";
import { FeatureSettings } from "../../app/components/FeatureSettings";
import { createQueryClient, queryKeys } from "../../app/lib/query";
import { USER } from "./support";

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

describe("Settings → Features", () => {
  it("groups features by origin and names the models that provide each capability", () => {
    const client = createQueryClient();
    client.setQueryData(queryKeys.models(USER), MODELS);
    render(
      <QueryClientProvider client={client}>
        <FeatureSettings userId={USER} />
      </QueryClientProvider>,
    );
    const builtIn = screen.getByTestId("features-chatui");
    expect(within(builtIn).getByText("Math")).toBeTruthy();
    const model = screen.getByTestId("features-model");
    const images = within(model).getByText("Image input").closest("li");
    expect(images?.textContent).toContain("With seer.");
    const audio = within(model).getByText("Audio input").closest("li");
    expect(audio?.textContent).toContain("None of the available models.");
    expect(within(model).getByText("Memory suggestions").closest("li")?.textContent).toContain(
      "With helper.",
    );
    const unavailable = screen.getByTestId("features-unavailable");
    expect(within(unavailable).getByText("Web search and research")).toBeTruthy();
    // Descriptions, never controls: nothing here can be switched on.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});

describe("the UI never implies unavailable tools", () => {
  it("no component offers web search, voice, image generation or code running", () => {
    const dir = path.join(import.meta.dirname, "../../app");
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
      (f) => f.endsWith(".tsx") && !f.endsWith("FeatureSettings.tsx"),
    );
    const offers =
      /["'>]\s*(Search the web|Web search|Deep research|Research mode|Study mode|Voice mode|Start voice|Generate (an )?image|Run code|Run preview)\b/i;
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), "utf8");
      expect(source, file).not.toMatch(offers);
    }
  });
});
