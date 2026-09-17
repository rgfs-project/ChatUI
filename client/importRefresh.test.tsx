import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@shared/auth';
import type * as ApiModule from './api.ts';

/**
 * What a finished import refreshes.
 *
 * An export carries conversations, memories and artifacts, and all three are
 * written before the request returns. Any list left un-invalidated keeps
 * serving what it cached — the artifact list said "nothing here yet" over a
 * store that had just received six, and only a reload disagreed. The data was
 * never the problem, so this asserts on the cache rather than on the server.
 */

type Api = typeof ApiModule;

const importExport = vi.fn<Api['importExport']>();
const fetchArtifacts = vi.fn<Api['fetchArtifacts']>();
const fetchMyMemories = vi.fn<Api['fetchMyMemories']>();
const fetchMyPreferences = vi.fn<Api['fetchMyPreferences']>();
const listConversations = vi.fn<Api['listConversations']>();
const fetchModels = vi.fn<Api['fetchModels']>();

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<Api>('./api.ts');
  return {
    ...actual,
    importExport,
    fetchArtifacts,
    fetchMyMemories,
    fetchMyPreferences,
    listConversations,
    fetchModels,
  };
});

const { SettingsPanel } = await import('./SettingsPanel.tsx');
const { createQueryClient, keys } = await import('./queries.ts');

const USER: UserDto = {
  id: 'u-1',
  username: 'tester',
  role: 'user',
  status: 'active',
  createdAt: new Date().toISOString(),
};

describe('after an import finishes', () => {
  it('invalidates the artifact list, not only conversations and memories', async () => {
    // The shape the real endpoint returns after an export with artifacts in it.
    importExport.mockResolvedValue({
      imported: 6,
      skippedExisting: 0,
      skippedEmpty: 0,
      memories: 2,
      memoriesSkipped: 0,
      artifacts: 6,
      artifactsSkipped: 0,
      toolBlocks: 0,
      attachments: 0,
    });
    fetchArtifacts.mockResolvedValue([]);
    fetchMyMemories.mockResolvedValue([]);
    fetchMyPreferences.mockResolvedValue({} as Awaited<ReturnType<Api['fetchMyPreferences']>>);
    listConversations.mockResolvedValue([]);
    fetchModels.mockResolvedValue({ providers: [], defaultModel: null });

    const client = createQueryClient();
    // A list already read and cached — the state the bug needed to show up.
    client.setQueryData(keys.artifacts(), []);

    render(
      <QueryClientProvider client={client}>
        <SettingsPanel user={USER} onClose={vi.fn()} />
      </QueryClientProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: 'Import' }));

    // The input is `sr-only` and driven by the visible button, so it is
    // addressed by type rather than by role.
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('the import file input is not in the document');
    await userEvent.upload(
      input,
      new File(['[]'], 'conversations.json', { type: 'application/json' })
    );

    await waitFor(() => {
      expect(importExport).toHaveBeenCalled();
    });

    await waitFor(() => {
      const state = client.getQueryState(keys.artifacts());
      expect(state?.isInvalidated).toBe(true);
    });
  });
});
