import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@shared/auth';
import type * as ApiModule from './api.ts';

/**
 * Discovery failure in the Models pane.
 *
 * A provider whose discovery fails contributes no model rows, and the refresh
 * request itself still succeeds — a failed fetch keeps the last known list by
 * design, so the route reports success and there is no mutation error to show.
 * Together that produced an empty pane for a provider that was in fact
 * unreachable, with the only account of it in the server log.
 */

type Api = typeof ApiModule;

const fetchModels = vi.fn<Api['fetchModels']>();
const fetchAdminUsers = vi.fn<Api['fetchAdminUsers']>();
const fetchAdminProviders = vi.fn<Api['fetchAdminProviders']>();
const fetchAdminSettings = vi.fn<Api['fetchAdminSettings']>();

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<Api>('./api.ts');
  return {
    ...actual,
    fetchModels,
    fetchAdminUsers,
    fetchAdminProviders,
    fetchAdminSettings,
  };
});

const { AdminPanel } = await import('./AdminPanel.tsx');
const { createQueryClient } = await import('./queries.ts');

const ADMIN: UserDto = {
  id: 'u-1',
  username: 'admin',
  role: 'admin',
  status: 'active',
  createdAt: new Date().toISOString(),
};

async function openModels(group: ApiModule.ProviderModelGroup): Promise<void> {
  fetchModels.mockResolvedValue({ providers: [group], defaultModel: null });
  fetchAdminUsers.mockResolvedValue([]);
  fetchAdminProviders.mockResolvedValue([]);
  fetchAdminSettings.mockResolvedValue({
    settings: { version: 1 },
    resolved: {
      registrationMode: 'closed',
      defaultModel: null,
      hiddenModels: [],
      samplers: [],
    },
  });

  render(
    <QueryClientProvider client={createQueryClient()}>
      <AdminPanel user={ADMIN} onClose={vi.fn()} />
    </QueryClientProvider>
  );

  await userEvent.click(screen.getByRole('button', { name: 'Models' }));
}

describe('Models pane, when discovery failed', () => {
  it('names the provider and the reason instead of showing nothing', async () => {
    await openModels({
      providerId: 'llamacpp',
      providerName: 'llamacpp',
      status: 'unavailable',
      stale: true,
      lastError: 'The model provider rejected the request.',
      models: [],
    });

    await waitFor(() => {
      expect(screen.getByText('llamacpp')).toBeTruthy();
    });
    expect(screen.getByText('The model provider rejected the request.')).toBeTruthy();
    expect(screen.getByText('Unavailable')).toBeTruthy();
  });

  it('marks a provider still serving an older list as stale, not unavailable', async () => {
    await openModels({
      providerId: 'llamacpp',
      providerName: 'llamacpp',
      status: 'ready',
      stale: true,
      lastError: 'The model provider could not be reached.',
      models: [{ id: 'GPT', inputModalities: [], loaded: false }],
    });

    await waitFor(() => {
      expect(screen.getByText('Stale')).toBeTruthy();
    });
    // The models it was serving stay listed and selectable.
    expect(screen.getByText('GPT')).toBeTruthy();
  });

  it('says nothing at all when every provider is healthy', async () => {
    await openModels({
      providerId: 'llamacpp',
      providerName: 'llamacpp',
      status: 'ready',
      stale: false,
      lastError: null,
      models: [{ id: 'GPT', inputModalities: [], loaded: false }],
    });

    await waitFor(() => {
      expect(screen.getByText('GPT')).toBeTruthy();
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
