import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.ts';
import { createLogger } from '../logger.ts';
import { SessionManager } from '../auth/sessions.ts';
import { ARGON2_TEST_OPTIONS, UserStore } from '../auth/users.ts';
import { signIn, type TestClient } from '../auth/testClient.ts';
import { AttachmentStore } from '../attachments/store.ts';
import { pngBytes } from '../attachments/testImages.ts';
import { GenerationManager } from '../generation/manager.ts';
import { GenerationService } from '../generation/service.ts';
import { LlamaCppProvider } from '../provider/llamacpp.ts';
import { ProviderHub } from '../provider/hub.ts';
import { DEFAULT_HOST_POLICY } from '../provider/ssrf.ts';
import { startMockProvider, type MockProvider } from '../provider/mockServer.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';
import { StoragePaths } from '../storage/paths.ts';

/**
 * `MAX_HISTORY_IMAGES`, asserted on what actually leaves the process.
 *
 * The prompt-assembly tests measure the function; this one measures the
 * request. It drives real HTTP against a real attachment store and reads the
 * body the provider received, so a setting that is parsed but never threaded
 * through to `assemblePrompt` — the mistake this kind of option invites —
 * fails here rather than passing on a unit test that calls the assembler
 * directly.
 */

/*
 * Each test boots an HTTP server, a mock provider, a provider refresh and an
 * argon2 account. That is comfortably fast on its own and can outlast the
 * default five seconds when the whole suite is running in parallel around it,
 * which shows up as two or three tests timing out at random.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const logger = createLogger({ level: 'error', write: () => undefined });

let dataDir: string;
let server: Server | undefined;
let base: string;
let mock: MockProvider | undefined;
let store: ConversationStore;
let attachments: AttachmentStore;
let reader: TestClient;

/** `Qwen Mini` is the model the mock advertises as taking text and images. */
const VISION_MODEL = 'Qwen Mini';

/**
 * Builds the whole stack with one value of the setting.
 *
 * Called from the test body rather than from `beforeEach`, because the setting
 * is read when the service is constructed: a `beforeEach` would have built the
 * app before the test could choose, and every case would have run unset — which
 * is exactly what this harness did on its first draft, passing the uncapped
 * test and failing the other three for the wrong reason.
 */
async function boot(historyImages?: number): Promise<void> {
  dataDir = await mkdtemp(join(tmpdir(), 'history-images-'));
  const paths = new StoragePaths(dataDir);

  mock = await startMockProvider({ contentChunks: ['I can see it.'] });
  const provider = new LlamaCppProvider(
    {
      baseUrl: mock.url,
      apiKey: undefined,
      timeoutMs: 5_000,
      defaultContextTokens: 8_192,
      maxOutputTokens: 128,
    },
    logger
  );

  const users = new UserStore({ paths, logger, argon2Options: ARGON2_TEST_OPTIONS });
  const sessions = new SessionManager({
    paths,
    logger,
    absoluteTtlMs: 3_600_000,
    idleTtlMs: 3_600_000,
  });

  store = new ConversationStore({ paths, logger });
  const index = new ChatIndex({ store, logger });
  attachments = new AttachmentStore(paths, {
    maxBytes: 1_000_000,
    maxTotalBytesPerUser: 8_000_000,
    pendingTtlMs: 60_000,
    maxImagePixels: 50_000_000,
  });

  const manager = new GenerationManager({ provider, logger, maxOutputTokens: 128 });
  const hub = new ProviderHub({
    logger,
    policy: DEFAULT_HOST_POLICY,
    defaultContextTokens: 8_192,
    maxOutputTokens: 128,
    factory: () => provider,
  });
  hub.setProviders([
    {
      id: 'local',
      name: 'Local',
      kind: 'openai-compatible',
      baseUrl: mock.url,
      timeoutMs: 5_000,
      capabilities: {},
    },
  ]);
  await hub.refresh();

  const service = new GenerationService({
    store,
    index,
    manager,
    hub,
    logger,
    defaultContextTokens: 8_192,
    maxOutputTokens: 128,
    attachments,
    ...(historyImages === undefined ? {} : { maxHistoryImages: historyImages }),
  });

  const app = createApp({
    logger,
    users,
    sessions,
    authConfig: { registrationMode: 'closed', absoluteTtlMs: 3_600_000, idleTtlMs: 3_600_000 },
    store,
    index,
    manager,
    hub,
    service,
    attachments,
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const account = await users.create({ username: 'reader', password: 'a-good-password' });
  reader = await signIn(base, sessions, account.id);
}

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  await mock?.close();
  mock = undefined;

  /* A generation's last write can still be landing as the server closes, and
     removing the tree under it fails with ENOTEMPTY. Retry rather than assert
     on the timing of a background flush. */
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dataDir, { recursive: true, force: true });
      break;
    } catch (err) {
      if (attempt >= 20) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});

/** An uploaded, unattached image, as the composer would have left it. */
async function uploadImage(filename = 'diagram.png'): Promise<string> {
  const bytes = pngBytes(16, 16);
  const { meta } = await attachments.create(reader.userId, filename, {
    // eslint-disable-next-line @typescript-eslint/require-await -- the bytes are already in hand
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(bytes);
    },
  });
  return meta.id;
}

async function newConversation(): Promise<string> {
  const response = await reader.fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return ((await response.json()) as { id: string }).id;
}

interface SendOptions {
  content?: string;
  attachmentIds?: string[];
  model?: string;
}

async function send(conversationId: string, options: SendOptions = {}): Promise<Response> {
  return reader.fetch('/api/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      providerId: 'local',
      model: options.model ?? VISION_MODEL,
      content: options.content ?? '',
      ...(options.attachmentIds === undefined ? {} : { attachmentIds: options.attachmentIds }),
    }),
  });
}

/** Waits for the generation to be written back into the conversation. */
async function settled(conversationId: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const conversation = await store.load(reader.userId, conversationId);
    if (conversation.messages.some((message) => message.type === 'assistant')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the generation never landed');
}

/** The images in the newest chat request the provider received. */
function imagesSentUpstream(): number {
  const completions = (mock?.requests ?? []).filter((request) =>
    request.path.startsWith('/v1/chat/completions')
  );
  const body = completions.at(-1)?.body as { messages?: { content?: unknown }[] } | undefined;
  return (body?.messages ?? [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => (part as { type?: string }).type === 'image_url').length;
}

/** Sends `count` picture-carrying turns, and settles each one. */
async function pictureTurns(conversationId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const image = await uploadImage(`shot-${String(i)}.png`);
    await send(conversationId, { content: `look at shot ${String(i)}`, attachmentIds: [image] });
    await settled(conversationId);
  }
}

describe('MAX_HISTORY_IMAGES, over real HTTP', () => {
  it('re-sends every earlier image when it is unset', async () => {
    await boot();
    const conversationId = await newConversation();

    await pictureTurns(conversationId, 4);

    // Four turns, four pictures, all of them encoded again on the last request.
    expect(imagesSentUpstream()).toBe(4);
  });

  it('re-sends only the newest earlier image at 1, plus the current turn', async () => {
    await boot(1);
    const conversationId = await newConversation();

    await pictureTurns(conversationId, 4);

    expect(imagesSentUpstream()).toBe(2);
  });

  it('re-sends nothing from before at 0, and still sends what was just asked', async () => {
    await boot(0);
    const conversationId = await newConversation();

    await pictureTurns(conversationId, 4);

    expect(imagesSentUpstream()).toBe(1);
  });

  it('keeps the words of the turns whose pictures it withheld', async () => {
    await boot(0);
    const conversationId = await newConversation();

    await pictureTurns(conversationId, 3);

    const completions = (mock?.requests ?? []).filter((request) =>
      request.path.startsWith('/v1/chat/completions')
    );
    const body = completions.at(-1)?.body as { messages?: { content?: unknown }[] };
    const text = JSON.stringify(body.messages ?? []);

    // Every turn is still there in words, and the gap is stated rather than silent.
    expect(text).toContain('look at shot 0');
    expect(text).toContain('look at shot 1');
    expect(text).toContain('earlier image omitted');
  });
});
