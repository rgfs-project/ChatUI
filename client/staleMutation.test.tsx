import { QueryClientProvider, type Query, type QueryClient } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accountEpoch,
  beginAccountEpoch,
  createQueryClient,
  keys,
  usePinConversation,
  useRenameConversation,
} from './queries.ts';
import { installTestServer, type TestServer } from './test-server.ts';

/**
 * Work that outlives the account that started it.
 *
 * Clearing the cache when the account changes deals with what is already in it.
 * It does nothing about what is still on its way: a mutation is not a query, so
 * cancelling queries does not touch it, and its callbacks write to the cache at
 * the moment they run rather than the moment they were scheduled. A rename that
 * the server answers after somebody else has signed in was being applied to the
 * new account's cache; a failed mutation's rollback was putting back a snapshot
 * taken before the change.
 *
 * Both are driven here with the response held open across the change, which is
 * the only way to be sure the ordering is the one that matters.
 */

let server: TestServer;
let client: QueryClient;

beforeEach(() => {
  server = installTestServer();
  client = createQueryClient();
});

afterEach(() => {
  server.restore();
});

/** Renders a hook with the shared client, returning a handle to call it. */
function mountHook<T>(use: () => T): { current: T } {
  const handle = { current: undefined as unknown as T };

  function Probe(): null {
    handle.current = use();
    return null;
  }

  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>
  );
  return handle;
}

/** What Root does the moment the signed-in account changes. */
function accountChanges(): void {
  beginAccountEpoch();
  client.removeQueries({ predicate: (query: Query) => query.queryKey[0] !== 'session' });
}

describe('a mutation that resolves after the account changed', () => {
  it('does not write the previous account’s conversation into the cache', async () => {
    const rename = mountHook(useRenameConversation);

    act(() => {
      rename.current.mutate({ id: 'c-alice', title: 'Alice renamed this' });
    });
    await server.waitFor('/api/conversations/c-alice');

    // Alice leaves, Bob arrives; the rename is still in flight.
    act(accountChanges);

    // Now the server answers Alice's rename.
    act(() => {
      server.respond('/api/conversations/c-alice', {
        id: 'c-alice',
        title: 'Alice renamed this',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [],
        activeGenerationId: null,
      });
    });

    await waitFor(() => {
      expect(rename.current.isPending).toBe(false);
    });

    expect(client.getQueryData(keys.conversation('c-alice'))).toBeUndefined();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it('does not roll back into the new account’s cache when it fails', async () => {
    // Alice's list, as it stood before she pinned anything.
    client.setQueryData(keys.conversations(), [
      { id: 'c-alice', title: 'Alice private notes', pinned: false },
    ]);

    const pin = mountHook(usePinConversation);

    act(() => {
      pin.current.mutate({ id: 'c-alice', pinned: true });
    });
    await server.waitFor('/api/conversations/c-alice/pin');

    act(accountChanges);

    // The pin fails, which is what triggers the rollback.
    act(() => {
      server.fail('/api/conversations/c-alice/pin', 500, 'INTERNAL');
    });

    await waitFor(() => {
      expect(pin.current.isPending).toBe(false);
    });

    // The rollback would have restored Alice's list. It must not have.
    expect(client.getQueryData(keys.conversations())).toBeUndefined();
  });
});

describe('the ordinary case is untouched', () => {
  it('applies a mutation that resolves while the same account is signed in', async () => {
    const rename = mountHook(useRenameConversation);

    act(() => {
      rename.current.mutate({ id: 'c-alice', title: 'Renamed' });
    });
    await server.waitFor('/api/conversations/c-alice');

    act(() => {
      server.respond('/api/conversations/c-alice', {
        id: 'c-alice',
        title: 'Renamed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [],
        activeGenerationId: null,
      });
    });

    await waitFor(() => {
      expect(client.getQueryData(keys.conversation('c-alice'))).toMatchObject({ title: 'Renamed' });
    });
  });

  it('counts a sign-out and a sign-in back as two different sessions', () => {
    const before = accountEpoch();
    beginAccountEpoch();
    beginAccountEpoch();
    expect(accountEpoch()).toBe(before + 2);
  });
});
