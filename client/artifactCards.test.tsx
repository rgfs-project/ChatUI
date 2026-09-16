import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppRoot } from './Root.tsx';
import {
  conversationBody,
  conversationsBody,
  installTestServer,
  modelsBody,
  preferencesBody,
  sessionBody,
  type TestServer,
} from './test-server.ts';

/**
 * The files a reply produced, under that reply.
 *
 * An artifact was reachable only through the dialog, which is the wrong way
 * round for the moment it is made: the reply says "here is the file" and the
 * transcript showed a code block with the file itself somewhere else entirely.
 *
 * What these assert, and why each one is here rather than left to the eye:
 * a card appears under the turn that made it and not under any other turn
 * (the back-link is per-message, so grouping by it is the whole feature);
 * an artifact belonging to no turn stays out of the transcript instead of
 * defaulting into the first one; and opening a card opens the panel, which is
 * the card's only job.
 */

let server: TestServer;

beforeEach(() => {
  server = installTestServer();
  window.localStorage.clear();
});

afterEach(() => {
  server.restore();
});

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1',
    name: 'chart-test.html',
    mediaType: 'text/html',
    description: 'Chart/data visualization test',
    size: 128,
    createdAt: '2026-01-01T00:00:00.000Z',
    conversationId: 'c1',
    messageId: 'm2',
    ...overrides,
  };
}

/** Signs in, opens a conversation of two turns, and answers the artifact list. */
async function mountWithArtifacts(artifacts: Record<string, unknown>[]): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/chat/new']}>
      <AppRoot />
    </MemoryRouter>
  );

  await server.waitFor('/api/auth/session');
  server.respond('/api/auth/session', sessionBody());
  await server.waitFor('/api/conversations');
  server.respond('/api/conversations', conversationsBody([{ id: 'c1', title: 'First' }]));
  await server.waitFor('/api/models');
  server.respond('/api/models', modelsBody());
  await server.waitFor('/api/me/preferences');
  server.respond('/api/me/preferences', preferencesBody());
  await screen.findByLabelText('Message');

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'First' }));
  await server.waitFor('/api/conversations/c1');
  server.respond(
    '/api/conversations/c1',
    conversationBody('c1', [
      { type: 'user', id: 'm1', body: 'make me a chart' },
      { type: 'assistant', id: 'm2', body: 'Here it is.' },
    ])
  );
  await screen.findByText('Here it is.');

  await server.waitFor('/api/artifacts');
  server.respond('/api/artifacts', { artifacts });
}

describe('artifacts under the reply that produced them', () => {
  it('shows a card for the turn named by the back-link', async () => {
    await mountWithArtifacts([artifact()]);
    expect(await screen.findByRole('button', { name: /chart-test\.html/ })).toBeTruthy();
  });

  it('does not show one whose turn is a different message', async () => {
    await mountWithArtifacts([artifact({ messageId: 'some-other-turn' })]);

    // The transcript rendered; the card did not follow it in.
    expect(screen.getByText('Here it is.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /chart-test\.html/ })).toBeNull();
  });

  /*
   * An imported artifact carries no `messageId`, and neither does one whose
   * turn has since been edited away. Left ungrouped, `undefined` is a key like
   * any other and every such artifact would pile up under whichever message
   * happened to match it.
   */
  it('keeps an artifact belonging to no turn out of the transcript', async () => {
    await mountWithArtifacts([artifact({ messageId: undefined })]);

    expect(screen.getByText('Here it is.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /chart-test\.html/ })).toBeNull();
  });

  it('opens the panel when the card is chosen', async () => {
    await mountWithArtifacts([artifact()]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /chart-test\.html/ }));

    // The panel asks for the bytes, which nothing else in this screen does.
    await server.waitFor('/api/artifacts/a1/source');
  });
});
