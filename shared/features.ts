import type { ModelDto } from "./generations";

/**
 * Feature capability register (Phase 14, INV-52, contracts §11). Every
 * user-facing feature is classified by where it truly comes from:
 *
 * - `chatui`: built into ChatUI and always available;
 * - `model`: ChatUI supports it, but only with a model that has the named
 *   capability (discovered from the provider or set by an administrator);
 * - `unavailable`: not implemented, however it may look elsewhere. The UI
 *   never offers these.
 */

export type FeatureOrigin = "chatui" | "model" | "unavailable";

/** Model capabilities a `model` feature can depend on. */
export type ModelCapability = "image" | "audio" | "reasoning" | "tools";

export interface Feature {
  id: string;
  name: string;
  description: string;
  origin: FeatureOrigin;
  /** For `model` features: the capability the selected model needs. */
  requires?: ModelCapability;
}

export const FEATURES: readonly Feature[] = [
  {
    id: "markdown",
    name: "Formatted answers",
    description: "Markdown with tables, lists and links; untrusted HTML is never run.",
    origin: "chatui",
  },
  {
    id: "math",
    name: "Math",
    description: "LaTeX formulas shown as accessible MathML, with their source to copy.",
    origin: "chatui",
  },
  {
    id: "code",
    name: "Code blocks",
    description: "Syntax colors for common languages, copy and download.",
    origin: "chatui",
  },
  {
    id: "search",
    name: "Search your chats",
    description: "Titles and messages of your own conversations.",
    origin: "chatui",
  },
  {
    id: "operations",
    name: "Edit, regenerate, pin",
    description: "Change a message, get another reply, keep chats at the top.",
    origin: "chatui",
  },
  {
    id: "files",
    name: "Files from replies",
    description: "Files a reply creates are kept as source you can view and download.",
    origin: "chatui",
  },
  {
    id: "skills",
    name: "Skills",
    description: "Your saved instructions, used with a slash command.",
    origin: "chatui",
  },
  {
    id: "memories",
    name: "Memories",
    description: "Notes you approve, included with every chat.",
    origin: "chatui",
  },
  {
    id: "portability",
    name: "Export and import",
    description:
      "One chat as Markdown, or everything as an archive; imports from Claude and duck.ai.",
    origin: "chatui",
  },
  {
    id: "images",
    name: "Image input",
    description: "Attach images for the model to read.",
    origin: "model",
    requires: "image",
  },
  {
    id: "audio",
    name: "Audio input",
    description: "Attach audio for the model to hear.",
    origin: "model",
    requires: "audio",
  },
  {
    id: "reasoning",
    name: "Thought process",
    description: "The model's reasoning, shown separately from its answer.",
    origin: "model",
    requires: "reasoning",
  },
  {
    id: "memory-suggestions",
    name: "Memory suggestions",
    description: "The model proposes memories for you to approve; nothing is saved without you.",
    origin: "model",
    requires: "tools",
  },
  {
    id: "web",
    name: "Web search and research",
    description: "ChatUI has no web access; answers never cite sources it didn't receive.",
    origin: "unavailable",
  },
  {
    id: "voice",
    name: "Voice conversation",
    description: "Spoken replies and live voice are not available.",
    origin: "unavailable",
  },
  {
    id: "image-generation",
    name: "Image generation",
    description: "Replies are text; models can't create images here.",
    origin: "unavailable",
  },
  {
    id: "code-execution",
    name: "Running code and app previews",
    description: "Code and generated files are shown as source and never run.",
    origin: "unavailable",
  },
  {
    id: "study",
    name: "Study and other modes",
    description: "There are no special modes beyond your skills and memories.",
    origin: "unavailable",
  },
];

/** Whether a model has the capability a feature needs. */
export function modelProvides(
  model: Pick<ModelDto, "capabilities">,
  capability: ModelCapability,
): boolean {
  const { capabilities } = model;
  switch (capability) {
    case "image":
    case "audio":
      return capabilities.inputModalities.includes(capability);
    case "reasoning":
      return capabilities.reasoning;
    case "tools":
      return capabilities.tools;
  }
}
