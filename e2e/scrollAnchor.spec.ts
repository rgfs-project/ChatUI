import {
  expect,
  signIn,
  startGeneration,
  composerField,
  scrollUpAwayFromEnd,
  test,
} from './fixtures.ts';
import type { Page } from '@playwright/test';

/**
 * The question stays where it was put, for the whole of the answer.
 *
 * Sending a message places it near the top of the transcript with empty space
 * reserved below, so the answer grows into the space underneath it. That part
 * worked. What did not was the end of it: the reserve is consumed as the answer
 * gets longer and reaches zero in a single step, which shortens the scrollable
 * content — and a view sitting at the bottom of it is clamped down by the same
 * amount, sliding everything *down* the screen. The question ended up near the
 * bottom with the previous exchange back in view, in the middle of a reply the
 * reader was still reading.
 *
 * Only a browser can settle this: it is a question about `scrollTop`, real
 * layout, and a Markdown table that changes height as it renders. So the
 * question's viewport coordinate is measured after every chunk, including the
 * one that exhausts the reserve, and it is never allowed to move down.
 */

/** Where the last question sits on screen, or null once it is scrolled off. */
async function questionY(page: Page): Promise<number | null> {
  const box = await page.locator('.msg--user').last().boundingBox();
  return box === null ? null : box.y;
}

/** A table big enough to change height as it renders, and to fill a viewport. */
const TABLE_ROWS = 14;
const TABLE = [
  '',
  '| Element | Nvidia | AMD |',
  '| --- | --- | --- |',
  ...Array.from(
    { length: TABLE_ROWS },
    (_, row) =>
      `| Row ${row + 1} with a reasonably long label | Dedicated hardware for the ${row + 1}th thing | A general-purpose unit doing the ${row + 1}th thing |`
  ),
  '',
];

/** Fills the transcript with enough history that it can scroll backwards. */
async function withHistory(
  page: Page,
  app: {
    provider: {
      send: (text: string) => void;
      finish: () => void;
      waitForStream: () => Promise<void>;
    };
  }
): Promise<void> {
  await startGeneration(page, 'the first question');
  await app.provider.waitForStream();
  app.provider.send('An answer long enough to matter.\n\n'.repeat(12));
  app.provider.finish();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

  const composer = composerField(page);
  await composer.fill('the second question');
  await composer.press('Enter');
  await app.provider.waitForStream();
  app.provider.send('Another answer, also long.\n\n'.repeat(12));
  app.provider.finish();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
}

test('the question keeps its place while the answer streams past the reserve', async ({
  app,
  page,
}) => {
  await signIn(page, app.baseUrl);
  await withHistory(page, app);

  // The question under test, sent into a transcript that already scrolls.
  const composer = composerField(page);
  await composer.fill('nvidia vs amd');
  await composer.press('Enter');
  await app.provider.waitForStream();

  await expect(page.locator('.msg--user').last()).toContainText('nvidia vs amd');
  const anchored = await questionY(page);
  expect(anchored).not.toBeNull();

  /*
   * Grown in chunks, with the table in the middle: a table is the case that
   * changes size *after* the text arrives, as the browser lays its columns
   * out, which is exactly when a naive "scroll to the bottom" loses the anchor.
   */
  const chunks = [
    '## Nvidia vs AMD — a snapshot\n\n',
    'Here is the comparison you asked for, with the detail underneath.\n\n',
    TABLE.join('\n'),
    '\n\nSome prose after the table, to push it further.\n\n',
    'More prose again, longer this time, so the reply outgrows the room held for it.\n\n'.repeat(4),
    'And a final paragraph that takes it well past the bottom of the viewport.\n\n'.repeat(4),
  ];

  let lowest = anchored as number;
  for (const chunk of chunks) {
    app.provider.send(chunk);
    // Let the deltas flush and the layout settle before measuring.
    await page.waitForTimeout(150);

    const y = await questionY(page);
    if (y === null) break; // Scrolled off the top, which is where it belongs.

    /*
     * The assertion. It may move *up* — a long answer is supposed to push the
     * question off the top — but never down, because moving down is the
     * transcript jumping backwards and bringing the previous exchange with it.
     */
    expect(y).toBeLessThanOrEqual(lowest + 2);
    lowest = Math.min(lowest, y);
  }

  // Completion swaps the streaming block for the persisted message; that must
  // not move the view either.
  const before = await questionY(page);
  app.provider.finish();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  await page.waitForTimeout(250);

  const after = await questionY(page);
  if (before !== null && after !== null) {
    expect(after).toBeLessThanOrEqual(before + 2);
  }
});

/* The same thing on a phone, where the reserve is a larger share of the view. */
test.describe('on a narrow viewport', () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test('the question still never slides back down', async ({ app, page }) => {
    await signIn(page, app.baseUrl);
    await withHistory(page, app);

    const composer = composerField(page);
    await composer.fill('nvidia vs amd');
    await composer.press('Enter');
    await app.provider.waitForStream();

    await expect(page.locator('.msg--user').last()).toContainText('nvidia vs amd');
    let lowest = (await questionY(page)) as number;
    expect(lowest).not.toBeNull();

    for (const chunk of [
      'A heading and then some text.\n\n',
      TABLE.join('\n'),
      '\n\nProse after the table.\n\n'.repeat(6),
    ]) {
      app.provider.send(chunk);
      await page.waitForTimeout(150);

      const y = await questionY(page);
      if (y === null) break;
      expect(y).toBeLessThanOrEqual(lowest + 2);
      lowest = Math.min(lowest, y);
    }

    app.provider.finish();
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  });
});

/*
 * The reader's own scroll still wins. Anchoring is for the case where nobody
 * touched anything; a deliberate scroll away must not be undone by it.
 */
test('a deliberate scroll away is left alone', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await withHistory(page, app);

  const composer = composerField(page);
  await composer.fill('nvidia vs amd');
  await composer.press('Enter');
  await app.provider.waitForStream();
  app.provider.send('The beginning of the answer.\n\n');
  await page.waitForTimeout(150);

  // Up into the history, on purpose.
  await page.locator('[data-testid="transcript"]').evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.waitForTimeout(150);

  const top = await page.locator('[data-testid="transcript"]').evaluate((node) => node.scrollTop);

  app.provider.send('More of the answer, arriving while the reader is elsewhere.\n\n'.repeat(6));
  await page.waitForTimeout(250);

  const after = await page.locator('[data-testid="transcript"]').evaluate((node) => node.scrollTop);

  // Still where they left it, and the way back is on offer.
  expect(Math.abs(after - top)).toBeLessThanOrEqual(4);
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

  app.provider.finish();
});

/*
 * Nothing crosses a conversation change: not the scroll position, not the
 * anchor, not the loader, not the reply that is still streaming into the chat
 * behind it — and not the jump-to-latest arrow, which is the one that showed.
 */
test('opening another conversation starts from its own state', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await withHistory(page, app);

  const composer = composerField(page);
  await composer.fill('the streaming question');
  await composer.press('Enter');
  await app.provider.waitForStream();
  app.provider.send('The answer is arriving.\n\n'.repeat(4));
  await expect(page.locator('.msg--streaming')).toBeVisible();

  // Scrolled up, so the way back is on offer in this conversation.
  await page.locator('[data-testid="transcript"]').evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

  // New chat, mid-generation.
  await page.getByRole('button', { name: 'New chat' }).click();

  // Nothing of the conversation behind it: no arrow over an empty screen, no
  // loader, no cursor, no partial reply.
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeHidden();
  await expect(page.locator('.msg--streaming')).toHaveCount(0);
  await expect(page.locator('.thinking')).toHaveCount(0);
  await expect(page.getByText('The answer is arriving.')).toHaveCount(0);

  // And the transcript it left is where it was, still running.
  app.provider.send('And the rest of it.\n\n');
  await expect(page.getByText('And the rest of it.')).toHaveCount(0);

  app.provider.finish();
});

test('the jump control is never offered on a transcript that fits', async ({ app, page }) => {
  await signIn(page, app.baseUrl);

  // A single short exchange: nothing to scroll, so nothing to jump to.
  await startGeneration(page, 'hello');
  await app.provider.waitForStream();
  app.provider.send('Hi.');
  app.provider.finish();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeHidden();

  // Even after a scroll attempt, which a short transcript cannot act on.
  await page.locator('[data-testid="transcript"]').evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeHidden();
});

/**
 * A reload is not a scroll either.
 *
 * The reserve is rebuilt from scratch against a transcript the page has only
 * just rendered, and the view follows the bottom it produces. If the two get
 * out of step — a measurement taken before the text settled at its final
 * height, and then kept, because nothing React renders changed afterwards —
 * the transcript comes back at a different position than the one the reader
 * left, which is the whole of "the chat moves when I refresh".
 */
test('the transcript comes back where the reader left it', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await withHistory(page, app);

  const composer = composerField(page);
  await composer.fill('the last question');
  await composer.press('Enter');
  await app.provider.waitForStream();
  // Short enough to leave the reserve standing, with `code` in it: the font it
  // loads in is the layout change that arrives after the first measurement.
  app.provider.send('Stored under `data/<user-uuid>/`, as before.');
  app.provider.finish();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

  const before = await questionY(page);
  expect(before).not.toBeNull();

  await page.reload();
  await expect(page.getByText('as before.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

  // The reserve is rebuilt asynchronously, so this is the settled position
  // rather than the first one painted.
  await expect
    .poll(async () => Math.round((await questionY(page)) ?? -1))
    .toBe(Math.round(before as number));
});

/**
 * Stopping just short of the end is a place too.
 *
 * Scroll memory used to treat anything within 48px of the bottom as "the
 * bottom" and delete the saved position outright — a figure borrowed from the
 * scroll pin, which uses it to answer a different question. A reader who
 * stopped forty pixels short had nothing saved, the reload started at the
 * bottom, and the whole transcript jumped up by exactly the distance they had
 * chosen to sit at. Small, repeatable, and entirely on refresh, which is what
 * made it look like a layout bug.
 */
test('a reader stopped just short of the bottom is put back there', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await withHistory(page, app);

  const composer = composerField(page);
  await composer.fill('the last question');
  await composer.press('Enter');
  await app.provider.waitForStream();
  app.provider.send('Stored under `data/<user-uuid>/`, as before.');
  app.provider.finish();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

  const transcript = page.locator('[data-testid="transcript"]');

  // Inside the old 48px window, and far enough in to be unmistakably deliberate.
  const OFFSET_PX = 40;
  await transcript.evaluate((node, offset) => {
    node.scrollTop = node.scrollHeight - node.clientHeight - offset;
  }, OFFSET_PX);

  const distance = async (): Promise<number> =>
    transcript.evaluate((node) =>
      Math.round(node.scrollHeight - node.scrollTop - node.clientHeight)
    );

  // The premise: this is a position the reader can actually hold.
  await expect.poll(distance).toBe(OFFSET_PX);

  await page.reload();
  await expect(page.getByText('as before.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

  // Settled rather than first painted: the reserve is rebuilt asynchronously.
  await expect.poll(distance).toBe(OFFSET_PX);
});

/**
 * A long answer is read from the top, and a reload does not lose the place.
 *
 * Once a reply outgrows its reserve the transcript is released and the view
 * stays where the reader is reading — several screens above the end of it.
 * Nothing recorded that, and a transcript nobody has scrolled starts at the
 * bottom, so a refresh in the middle of a long answer threw the reader past
 * everything they had not read yet: measured at 5,713px on a 3,000-word reply.
 */
test('a reload in the middle of a long answer keeps the place', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await withHistory(page, app);

  const composer = composerField(page);
  await composer.fill('explain the whole architecture at length');
  await composer.press('Enter');
  await app.provider.waitForStream();
  // Several screens of it, arriving a chunk at a time the way a reply really
  // does: the reserve runs out part way through, the transcript is released
  // there, and the view stays in the middle rather than at either end. Sent in
  // one burst it never releases, and the test would prove nothing.
  for (let paragraph = 1; paragraph <= 30; paragraph += 1) {
    app.provider.send(
      `Paragraph ${paragraph}. The transcript is canonical Markdown on disk and the index is derived from it, so the file is the truth and everything else is a cache that can be rebuilt.\n\n`
    );
    await page.waitForTimeout(25);
  }
  app.provider.finish();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

  const transcript = page.locator('[data-testid="transcript"]');
  const before = await transcript.evaluate((node) => Math.round(node.scrollTop));
  const height = await transcript.evaluate((node) => node.scrollHeight - node.clientHeight);
  // The premise: the reader is genuinely not at the end of it.
  expect(before).toBeLessThan(height - 200);

  await page.reload();
  await expect(page.getByText('Paragraph 30.')).toBeVisible();

  await expect
    .poll(async () => transcript.evaluate((node) => Math.round(node.scrollTop)))
    .toBeCloseTo(before, -1);
  // And it is still the reader's view, with the way back down on offer.
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
});

/**
 * Jump to latest arrives at the latest, not near it.
 *
 * The jump is animated, and assigning `scrollTop` cancels an animation in
 * flight — so the correction that holds the question still, firing while the
 * jump was on its way, stopped it and parked the view at whatever the
 * correction had computed. The reader was left short of the end by however far
 * the animation had got, which is a different distance every time.
 */
test('the jump control goes all the way to the bottom', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await withHistory(page, app);

  const composer = composerField(page);
  await composer.fill('a question with a long answer');
  await composer.press('Enter');
  await app.provider.waitForStream();
  for (let paragraph = 1; paragraph <= 25; paragraph += 1) {
    app.provider.send(`Paragraph ${paragraph}, long enough to take a line or two of its own.\n\n`);
    await page.waitForTimeout(20);
  }
  app.provider.finish();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

  const transcript = page.locator('[data-testid="transcript"]');
  await scrollUpAwayFromEnd(page, transcript);

  const jump = page.getByRole('button', { name: 'Jump to latest' });
  await expect(jump).toBeVisible();
  await jump.click();

  // At the end, not merely nearer to it. Polled because the scroll is animated.
  await expect
    .poll(async () =>
      transcript.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))
    )
    .toBe(0);
  await expect(jump).toBeHidden();
});
