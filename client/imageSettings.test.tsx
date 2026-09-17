import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@shared/auth';
import type * as ApiModule from './api.ts';

/**
 * The switch and the number beside it.
 *
 * One stored value with two independent parts: whether this reader has an
 * opinion at all, and what it is. `0` is one of the numbers they can choose, so
 * "re-send none" and "no opinion" are different states that a single number
 * could not tell apart — the tests that matter here are the ones about that
 * distinction, not about the widget.
 */

type Api = typeof ApiModule;

const fetchMyPreferences = vi.fn<Api['fetchMyPreferences']>();
const setMyHistoryImages = vi.fn<Api['setMyHistoryImages']>();
const setMyImageMaxEdge = vi.fn<Api['setMyImageMaxEdge']>();
const fetchModels = vi.fn<Api['fetchModels']>();
const fetchMyMemories = vi.fn<Api['fetchMyMemories']>();

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<Api>('./api.ts');
  return {
    ...actual,
    fetchMyPreferences,
    setMyHistoryImages,
    setMyImageMaxEdge,
    fetchModels,
    fetchMyMemories,
  };
});

const { SettingsPanel } = await import('./SettingsPanel.tsx');
const { createQueryClient } = await import('./queries.ts');

const USER: UserDto = {
  id: 'u-1',
  username: 'tester',
  role: 'user',
  status: 'active',
  createdAt: new Date().toISOString(),
};

async function openModelPane(
  historyImages: number | null,
  imageMaxEdge: number | null = null
): Promise<void> {
  fetchMyPreferences.mockResolvedValue({ defaultModel: null, historyImages, imageMaxEdge });
  setMyHistoryImages.mockResolvedValue({ defaultModel: null, historyImages, imageMaxEdge });
  setMyImageMaxEdge.mockResolvedValue({ defaultModel: null, historyImages, imageMaxEdge });
  fetchModels.mockResolvedValue({ providers: [], defaultModel: null });
  fetchMyMemories.mockResolvedValue([]);

  render(
    <QueryClientProvider client={createQueryClient()}>
      <SettingsPanel user={USER} onClose={vi.fn()} />
    </QueryClientProvider>
  );

  await userEvent.click(screen.getByRole('button', { name: 'Model' }));
}

function toggle(): HTMLInputElement {
  return screen.getByRole('checkbox', {
    name: /limit how many earlier images are re-sent/i,
  });
}

function stepper(): HTMLInputElement {
  return screen.getByRole('spinbutton', { name: /earlier images to re-send/i });
}

describe('the re-sent images setting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is off, with the number inert, for a reader who has never set it', async () => {
    await openModelPane(null);

    await waitFor(() => {
      expect(toggle().checked).toBe(false);
    });
    expect(stepper().disabled).toBe(true);
  });

  it('saves a limit when switched on', async () => {
    await openModelPane(null);
    await waitFor(() => {
      expect(toggle().checked).toBe(false);
    });

    await userEvent.click(toggle());

    expect(setMyHistoryImages).toHaveBeenCalledWith(2);
  });

  it('clears back to the instance setting when switched off', async () => {
    await openModelPane(2);
    await waitFor(() => {
      expect(toggle().checked).toBe(true);
    });

    await userEvent.click(toggle());

    // `null`, not `0`: turning it off is having no opinion, not asking for none.
    expect(setMyHistoryImages).toHaveBeenCalledWith(null);
  });

  it('shows zero as on, not as off', async () => {
    await openModelPane(0);

    await waitFor(() => {
      expect(toggle().checked).toBe(true);
    });
    expect(stepper().value).toBe('0');
    expect(stepper().disabled).toBe(false);
  });

  it('saves a number the reader types', async () => {
    await openModelPane(2);
    await waitFor(() => {
      expect(stepper().value).toBe('2');
    });

    await userEvent.clear(stepper());
    await userEvent.type(stepper(), '5');
    await userEvent.tab();

    expect(setMyHistoryImages).toHaveBeenCalledWith(5);
  });
});

function shrinkToggle(): HTMLInputElement {
  return screen.getByRole('checkbox', { name: /shrink pictures before sending/i });
}

describe('the picture size setting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is on for a reader who has never set it', async () => {
    await openModelPane(null, null);

    await waitFor(() => {
      expect(shrinkToggle().checked).toBe(true);
    });
  });

  it('is off when pictures are set to go up untouched', async () => {
    await openModelPane(null, 0);

    await waitFor(() => {
      expect(shrinkToggle().checked).toBe(false);
    });
  });

  it('stores zero when switched off, which is what stops the shrinking', async () => {
    await openModelPane(null, null);
    await waitFor(() => {
      expect(shrinkToggle().checked).toBe(true);
    });

    await userEvent.click(shrinkToggle());

    expect(setMyImageMaxEdge).toHaveBeenCalledWith(0);
  });

  it('turns back on at the default edge', async () => {
    await openModelPane(null, 0);
    await waitFor(() => {
      expect(shrinkToggle().checked).toBe(false);
    });

    await userEvent.click(shrinkToggle());

    expect(setMyImageMaxEdge).toHaveBeenCalledWith(1536);
  });
});
