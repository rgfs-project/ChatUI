import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@shared/auth';
import type * as ApiModule from './api.ts';

/**
 * An attachment must appear the instant it is sent, exactly as text does.
 *
 * The optimistic user message built in `useSendMessage`'s `onMutate` carried
 * `body` but dropped `attachmentIds` entirely, so a sent image was invisible
 * until the post-generation refetch pulled the persisted message down from
 * the server — a gap of the whole generation, not a network round trip. This
 * asserts the image is on screen while the request that carries it is still
 * outstanding, which is the one moment the bug hid the attachment.
 */

type Api = typeof ApiModule;

const listConversations = vi.fn<Api['listConversations']>();
const getConversation = vi.fn<Api['getConversation']>();
const fetchModels = vi.fn<Api['fetchModels']>();
const fetchMyPreferences = vi.fn<Api['fetchMyPreferences']>();
const fetchProposals = vi.fn<Api['fetchProposals']>();
const createConversation = vi.fn<Api['createConversation']>();
const startGeneration = vi.fn<Api['startGeneration']>();
const uploadAttachment = vi.fn<Api['uploadAttachment']>();
const getAttachment = vi.fn<Api['getAttachment']>();

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<Api>('./api.ts');
  return {
    ...actual,
    listConversations,
    getConversation,
    fetchModels,
    fetchMyPreferences,
    fetchProposals,
    createConversation,
    startGeneration,
    uploadAttachment,
    getAttachment,
  };
});

const { App } = await import('./App.tsx');
const { createQueryClient } = await import('./queries.ts');

const USER: UserDto = {
  id: 'u-1',
  username: 'tester',
  role: 'user',
  status: 'active',
  createdAt: new Date().toISOString(),
};

const NOW = new Date().toISOString();
const ATTACHMENT = {
  id: '11111111-1111-4111-8111-111111111111',
  filename: 'diagram.png',
  mediaType: 'image/png' as const,
  kind: 'image' as const,
  size: 128,
  createdAt: NOW,
};

/** Never settles on its own — the test decides when the server has answered. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  listConversations.mockResolvedValue([]);
  fetchModels.mockResolvedValue({
    providers: [
      {
        providerId: 'local',
        providerName: 'Local',
        status: 'ready',
        models: [{ id: 'vision', loaded: true, inputModalities: ['text', 'image'] }],
      },
    ],
    defaultModel: null,
  } as unknown as Awaited<ReturnType<Api['fetchModels']>>);
  fetchMyPreferences.mockResolvedValue({ pinned: [], defaultModel: null } as unknown as Awaited<
    ReturnType<Api['fetchMyPreferences']>
  >);
  fetchProposals.mockResolvedValue([]);
  getConversation.mockResolvedValue({
    id: 'c-1',
    title: 'New conversation',
    createdAt: NOW,
    updatedAt: NOW,
    messages: [],
    activeGenerationId: null,
  });
  createConversation.mockResolvedValue({ id: 'c-1' } as unknown as Awaited<
    ReturnType<Api['createConversation']>
  >);
  uploadAttachment.mockResolvedValue(ATTACHMENT);
  getAttachment.mockResolvedValue(ATTACHMENT);
  vi.stubGlobal(
    'EventSource',
    class {
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderApp(): void {
  function Shell(): React.JSX.Element {
    const [id, setId] = useState<string | null>('c-1');
    const [value, setValue] = useState('');

    return (
      <App
        user={USER}
        currentId={id}
        onSelectConversation={setId}
        draft={value}
        onDraftChange={setValue}
        onConversationCreated={setId}
        onOpenSettings={vi.fn()}
        onOpenAdmin={vi.fn()}
        onSignOut={vi.fn()}
      />
    );
  }

  render(
    <QueryClientProvider client={createQueryClient()}>
      <Shell />
    </QueryClientProvider>
  );
}

const sendButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' });

async function attach(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');

  const file = new File([new Uint8Array([1, 2, 3])], 'diagram.png', { type: 'image/png' });
  await user.upload(input, file);
  await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
  await waitFor(() => expect(sendButton().disabled).toBe(false));
}

describe('sending an image', () => {
  it('shows the image in the transcript while the generation request is still pending', async () => {
    const server = deferred<Awaited<ReturnType<Api['startGeneration']>>>();
    startGeneration.mockReturnValue(server.promise);

    const user = userEvent.setup();
    renderApp();
    await screen.findByLabelText('Message');

    await attach(user);
    await user.click(sendButton());

    // The request that would carry the image to the server has not answered
    // yet — this is exactly the window the bug left empty.
    await waitFor(() => expect(startGeneration).toHaveBeenCalled());
    expect(await screen.findByRole('img', { name: 'diagram.png' })).toBeTruthy();

    server.resolve({ generationId: 'g-1', userMessageId: 'u-new', assistantMessageId: 'a-new' });

    // Still there once the server has answered and the id is reconciled.
    await waitFor(() => expect(screen.queryByText('diagram.png')).toBeNull()); // the composer tray, not the transcript
    expect(screen.getByRole('img', { name: 'diagram.png' })).toBeTruthy();
  });

  it('keeps the same image element across the temporary-to-server id swap', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByLabelText('Message');

    await attach(user);
    await user.click(sendButton());

    const beforeReconcile = await screen.findByRole('img', { name: 'diagram.png' });
    await waitFor(() => expect(startGeneration).toHaveBeenCalled());

    // Reconciliation happens once `mutateAsync` resolves; the same DOM node
    // (not a remove-then-add) is what proves this is a reconciled id swap
    // rather than the optimistic message vanishing and a fresh one arriving.
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'diagram.png' })).toBe(beforeReconcile)
    );
  });
});
