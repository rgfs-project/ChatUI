import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createRoutesStub, useParams } from "react-router";
import type { ConversationDto, ConversationResult } from "@shared/conversations";
import type { ProviderModelsDto } from "@shared/generations";
import { ChatProvider } from "../../app/chat/chat-context";
import { ChatView } from "../../app/chat/chat-view";
import { Sidebar } from "../../app/chat/sidebar";
import { makeQueryClient } from "../../app/lib/query/client";
import { qk } from "../../app/lib/query/keys";
import { UiProvider } from "../../app/lib/ui-context";
import { ConfirmProvider } from "../../app/ui/dialog";
import { ToastProvider } from "../../app/ui/toast";
import { TooltipProvider } from "../../app/ui/tooltip";

export const USER = {
  id: "a1a1a1a1-0000-4000-8000-000000000001",
  username: "alice",
  role: "user" as const,
};
export const CONV = "c0c0c0c0-0000-4000-8000-000000000001";
export const GEN = "9e9e9e9e-0000-4000-8000-000000000001";

const caps = { inputModalities: ["text" as const], reasoning: false, tools: false };
export const MODELS: ProviderModelsDto[] = [
  {
    provider: { id: "local", name: "Local", status: "ok", capabilities: caps },
    stale: false,
    models: [
      {
        providerId: "local",
        id: "mock-chat",
        contextTokens: 4096,
        status: "loaded",
        capabilities: caps,
        capabilitySources: { inputModalities: "config", reasoning: "config", tools: "config" },
      },
    ],
  },
];

export function conversation(overrides: Partial<ConversationDto> = {}): ConversationDto {
  return {
    id: CONV,
    title: "Seeded",
    createdAt: "2026-10-29T10:00:00.000Z",
    updatedAt: "2026-10-29T10:00:00.000Z",
    revision: "0".repeat(64),
    activeGeneration: null,
    messages: [
      {
        id: "11111111-0000-4000-8000-000000000001",
        role: "user",
        content: "Hello",
        reasoning: null,
        status: null,
        provider: null,
        model: null,
        attachments: [],
        time: null,
      },
      {
        id: "11111111-0000-4000-8000-000000000002",
        role: "assistant",
        content: "Hi **there**",
        reasoning: null,
        status: "complete",
        provider: "local",
        model: "mock-chat",
        attachments: [],
        time: null,
      },
    ],
    ...overrides,
  };
}

/** A query cache filled the way a document's dehydrated state would be. */
export function seededClient(result?: ConversationResult): QueryClient {
  const client = makeQueryClient();
  client.setQueryData(qk.session(), { user: USER, csrfToken: "tok", registrationOpen: false });
  client.setQueryData(qk.models(USER.id), MODELS);
  client.setQueryData(qk.preferences(USER.id), {
    pins: [],
    defaultProvider: null,
    defaultModel: null,
    historyImages: null,
    imageMaxEdge: null,
  });
  client.setQueryData(qk.conversations(USER.id), [
    { id: CONV, title: "Seeded", createdAt: "", updatedAt: "", messageCount: 2, malformed: false },
  ]);
  if (result) client.setQueryData(qk.conversation(USER.id, CONV), result);
  return client;
}

function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <UiProvider
        hints={{ sidebarCollapsed: false, timeZone: "UTC", locale: "en-US" }}
        renderedAt="2026-10-29T12:00:00.000Z"
      >
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>{children}</ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </UiProvider>
    </QueryClientProvider>
  );
}

function ChatScreen() {
  const params = useParams();
  return (
    <ChatProvider user={USER} conversationId={params.conversationId ?? null}>
      <Sidebar />
      <ChatView />
    </ChatProvider>
  );
}

/** The shell's chat surfaces under an in-memory router. */
export function chatApp(client: QueryClient) {
  const Stub = createRoutesStub([
    { path: "/chat/new", Component: ChatScreen },
    { path: "/chat/:conversationId", Component: ChatScreen },
    { path: "/login", Component: () => <p>login page</p> },
  ]);
  return function App({ at }: { at: string }) {
    return (
      <Providers client={client}>
        <Stub initialEntries={[at]} />
      </Providers>
    );
  };
}

/** EventSource double: tests push SSE events by name. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown): void {
    for (const l of this.listeners.get(type) ?? [])
      l(new MessageEvent(type, { data: JSON.stringify(data) }));
  }

  close(): void {
    this.closed = true;
  }
}
