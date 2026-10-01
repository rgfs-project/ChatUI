import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";
import type { SessionDto } from "@shared/auth";
import type { ConversationDto, MessageDto } from "@shared/conversations";
import type { ModelListDto } from "@shared/generations";
import { authStore, resetAuthStoreForTests } from "../../app/lib/auth-store";
import { createQueryClient, queryKeys } from "../../app/lib/query";
import { ShellProvider } from "../../app/lib/shell-context";

export const USER = "11111111-1111-4111-8111-111111111111";
export const CONV = "22222222-2222-4222-8222-222222222222";
export const GEN = "33333333-3333-4333-8333-333333333333";
export const REPLY = "44444444-4444-4444-8444-444444444444";

export function message(
  n: number,
  role: MessageDto["role"],
  content: string,
  extra: Partial<MessageDto> = {},
): MessageDto {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    role,
    content,
    reasoning: null,
    status: role === "assistant" ? "complete" : null,
    provider: role === "assistant" ? "local" : null,
    model: role === "assistant" ? "m1" : null,
    attachments: [],
    time: null,
    ...extra,
  };
}

export function conversation(
  messages: MessageDto[],
  activeGeneration: string | null = null,
): ConversationDto {
  return {
    id: CONV,
    title: "Test chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: "a".repeat(64),
    messages,
    activeGeneration: activeGeneration ? { generationId: activeGeneration } : null,
  };
}

export const MODELS = {
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
          id: "m1",
          contextTokens: 4096,
          status: "loaded",
          capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
          capabilitySources: { inputModalities: "config", reasoning: "config", tools: "config" },
        },
      ],
    },
  ],
} as unknown as ModelListDto;

/** A controllable EventSource: tests push named SSE events by hand. */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  readyState = 1;
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  static latest(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (!last) throw new Error("no EventSource opened");
    return last;
  }
}

export function seededClient(conv?: ConversationDto): QueryClient {
  const client = createQueryClient();
  client.setQueryData(queryKeys.models(USER), MODELS);
  client.setQueryData(queryKeys.conversations(USER), []);
  if (conv) client.setQueryData(queryKeys.conversation(USER, conv.id), conv);
  return client;
}

/** Renders `routes` inside the app's providers, starting at `initial`. */
export function AppHarness(props: {
  client: QueryClient;
  routes: RouteObject[];
  initial: string;
  children?: ReactNode;
}) {
  const router = createMemoryRouter(props.routes, { initialEntries: [props.initial] });
  return (
    <QueryClientProvider client={props.client}>
      <ShellProvider>
        <RouterProvider router={router} />
      </ShellProvider>
    </QueryClientProvider>
  );
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const SESSION: SessionDto = {
  user: { id: USER, username: "alice", role: "user" },
  csrfToken: "csrf-alice",
  registrationOpen: false,
};

/** A signed-in browser: the auth store as the root would bootstrap it. */
export function signInStore(session: SessionDto = SESSION): void {
  resetAuthStoreForTests();
  authStore.applySession(session);
}

/** The signed-in user the Sidebar shows in tests. */
export const TEST_USER = { id: USER, username: "tester", role: "user" };
export const noop = () => undefined;

/**
 * Chooses a model in the composer's model menu: `value` is the JSON
 * provider/model pair, or the first model when omitted. The first use opens
 * the placeholder (which loads the menu); later ones open the Radix menu.
 */
export async function chooseModel(value?: string) {
  const trigger = screen.getByRole("button", { name: /^Model: / });
  if (trigger.getAttribute("aria-expanded") !== "true") {
    if (trigger.dataset.state === undefined) fireEvent.click(trigger);
    else fireEvent.keyDown(trigger, { key: "Enter" });
  }
  const item = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      value === undefined ? "[data-model]" : `[data-model='${value}']`,
    );
    if (!found) throw new Error(`no model item ${value ?? ""}`);
    return found;
  });
  fireEvent.click(item);
  await waitFor(() => {
    expect(document.querySelector("[data-model]")).toBeNull();
  });
}
