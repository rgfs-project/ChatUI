// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryRouter, MemoryRouter, RouterProvider, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactList, MessageArtifactDto } from "@shared/artifacts";
import type { ConversationDto } from "@shared/conversations";
import ArtifactSettings from "../../app/components/ArtifactSettings";
import { ConversationView } from "../../app/components/ConversationView";
import { authStore } from "../../app/lib/auth-store";
import { createQueryClient, queryKeys } from "../../app/lib/query";
import { useAccountBoundary } from "../../app/lib/use-account-boundary";
import {
  AppHarness,
  conversation,
  CONV,
  FakeEventSource,
  json,
  message,
  seededClient,
  SESSION,
  signInStore,
  USER,
} from "./support";

/** Phase 13c: file cards, the inert source panel, Settings → Files. */

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  signInStore();
  fetchMock = vi.fn(() => Promise.resolve(json(404, {})));
  vi.stubGlobal("fetch", fetchMock);
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ART = "77777777-7777-4777-8777-000000000001";
const PAYLOAD = '<script>window.pwned = true</script><img src=x onerror="window.pwned=true">';
const REPLY_ID = message(2, "assistant", "").id;

const card: MessageArtifactDto = {
  id: ART,
  name: "page.html",
  language: "html",
  size: PAYLOAD.length + 1,
  assistantMessageId: REPLY_ID,
  captureIndex: 0,
};

function withArtifacts(): ConversationDto {
  return {
    ...conversation([message(1, "user", "make a page"), message(2, "assistant", "Here it is")]),
    artifacts: [card],
  };
}

function Page() {
  const { conversationId } = useParams();
  return <ConversationView userId={USER} conversationId={conversationId} />;
}

function renderConversation(conv: ConversationDto, client: QueryClient = seededClient(conv)) {
  render(
    <AppHarness
      client={client}
      initial={`/chat/${CONV}`}
      routes={[{ path: "/chat/:conversationId", element: <Page /> }]}
    />,
  );
  return client;
}

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

describe("file cards and the source panel (INV-41)", () => {
  it("opens the lazy panel, shows HTML as text only, and returns focus on Escape", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith("/source") ? text(200, `${PAYLOAD}\n`) : json(404, {})),
    );
    renderConversation(withArtifacts());
    const open = await screen.findByRole("button", { name: /page\.html.*view source/ });
    await user.click(open);
    const panel = await screen.findByRole("dialog", { name: "page.html" });
    const source = await within(panel).findByTestId("artifact-source");
    // Focus starts on the scrollable source, not on a destructive control.
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Source");
    expect(source.textContent).toBe(`${PAYLOAD}\n`);
    // Never parsed: no script or img element exists, nothing ran.
    expect(panel.querySelector("script, img")).toBeNull();
    expect((window as { pwned?: boolean }).pwned).toBeUndefined();
    const download = within(panel).getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe(`/api/artifacts/${ART}/source?download=1`);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(open);
    });
  });

  it("deletes from the panel after confirming and refreshes the conversation", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "DELETE"
          ? json(200, { deleted: true })
          : url.endsWith("/source")
            ? text(200, "x\n")
            : url === `/api/conversations/${CONV}`
              ? json(200, { ...withArtifacts(), artifacts: [] })
              : json(404, {}),
      ),
    );
    renderConversation(withArtifacts());
    await user.click(await screen.findByTestId("artifact-card"));
    const panel = await screen.findByRole("dialog", { name: "page.html" });
    await user.click(within(panel).getByRole("button", { name: "Delete file" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete this file?" });
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(screen.queryByTestId("artifact-card")).toBeNull();
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => init?.method === "DELETE" && url === `/api/artifacts/${ART}`,
      ),
    ).toBe(true);
  });
});

describe("Settings → Files", () => {
  const LIST: ArtifactList = {
    artifacts: [
      {
        id: ART,
        name: "page.html",
        language: "html",
        size: 2048,
        sha256: "a".repeat(64),
        createdAt: "2026-01-02T00:00:00.000Z",
        conversationId: CONV,
        assistantMessageId: REPLY_ID,
        captureIndex: 0,
        backlinkAvailable: true,
      },
      {
        id: "77777777-7777-4777-8777-000000000002",
        name: "old.py",
        language: "python",
        size: 10,
        sha256: "b".repeat(64),
        createdAt: "2026-01-01T00:00:00.000Z",
        conversationId: "88888888-8888-4888-8888-000000000001",
        assistantMessageId: null,
        captureIndex: 0,
        backlinkAvailable: false,
      },
    ],
    usedBytes: 2058,
    quotaBytes: 100 * 1024 * 1024,
  };

  it("lists files with live and dead backlinks and download links", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url === "/api/artifacts" ? json(200, LIST) : json(404, {})),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ArtifactSettings userId={USER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const rows = await screen.findAllByTestId("artifact-row");
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0] as HTMLElement)
        .getByRole("link", { name: "Open chat" })
        .getAttribute("href"),
    ).toBe(`/chat/${CONV}#m-${REPLY_ID}`);
    expect(rows[1]?.textContent).toContain("Chat deleted");
    expect(
      within(rows[1] as HTMLElement)
        .getByRole("link", { name: "Download old.py" })
        .getAttribute("href"),
    ).toBe("/api/artifacts/77777777-7777-4777-8777-000000000002/source?download=1");
  });
});

describe("account switch (INV-39)", () => {
  function Boundary({ client }: { client: QueryClient }) {
    useAccountBoundary(client);
    return null;
  }

  it("drops the previous user's file list and cached sources", () => {
    const client = createQueryClient();
    client.setQueryData(queryKeys.artifacts(USER), { artifacts: [] });
    client.setQueryData(queryKeys.artifactSource(USER, ART), PAYLOAD);
    const router = createMemoryRouter([{ path: "/", element: <Boundary client={client} /> }]);
    render(<RouterProvider router={router} />);
    act(() => {
      authStore.applySession({
        ...SESSION,
        user: { id: "99999999-9999-4999-8999-999999999999", username: "bob", role: "user" },
      });
    });
    expect(client.getQueryData(queryKeys.artifacts(USER))).toBeUndefined();
    expect(client.getQueryData(queryKeys.artifactSource(USER, ART))).toBeUndefined();
  });
});
