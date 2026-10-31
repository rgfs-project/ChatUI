/**
 * One deliberate break per invariant (Phase 17). `find` must occur exactly
 * once in `file`; the check (vitest files, Playwright specs or verify) must
 * then fail. Keep each mutation the smallest change that defeats the
 * enforcement the register names.
 */
export interface Mutation {
  id: string;
  title: string;
  edits: { file: string; find: string; replace: string }[];
  vitest?: string[];
  e2e?: string[];
  verify?: boolean;
  /** Narrows the run to tests whose name matches (vitest -t / playwright -g). */
  grep?: string;
}

const T = (name: string) => `tests/${name}`;

export const MUTATIONS: Mutation[] = [
  {
    id: "INV-01",
    title: "unhandled errors expose their message and stack",
    edits: [
      {
        file: "server/errors.ts",
        find: 'sendError(res, new AppError(ErrorCode.INTERNAL, "Internal server error"));',
        replace:
          'sendError(res, new AppError(ErrorCode.INTERNAL, err instanceof Error ? `${err.message} ${err.stack ?? ""}` : String(err)));',
      },
    ],
    vitest: [T("server/errors.test.ts")],
  },
  {
    id: "INV-02",
    title: "unknown fields are silently dropped instead of rejected",
    edits: [
      {
        file: "server/validation.ts",
        find: 'const parsed = schema.safeParse(part === "body" ? raw : { ...(raw as object) });',
        replace: `const input: unknown = part === "body" ? raw : { ...(raw as object) };
    const shape = (schema as { shape?: Record<string, unknown> }).shape;
    const parsed = schema.safeParse(
      shape && input && typeof input === "object" && !Array.isArray(input)
        ? Object.fromEntries(Object.entries(input).filter(([k]) => k in shape))
        : input,
    );`,
      },
    ],
    vitest: [T("server/errors.test.ts")],
  },
  {
    id: "INV-03",
    title: "handler results are sent without their response schema",
    edits: [
      {
        file: "server/registry.ts",
        find: "const dto: unknown = route.response.parse(output);",
        replace: "const dto: unknown = output;",
      },
    ],
    vitest: [T("server/errors.test.ts"), T("server/registry.test.ts")],
  },
  {
    id: "INV-04",
    title: "upstream error bodies reach the browser",
    edits: [
      {
        file: "server/providers/llamacpp.ts",
        find: `    let type: unknown;
    try {
      const body: unknown = JSON.parse(await readCapped(res, 64 * 1024));`,
        replace: `    let type: unknown;
    let leaked = "";
    try {
      leaked = await readCapped(res, 64 * 1024);
      const body: unknown = JSON.parse(leaked);`,
      },
      {
        file: "server/providers/llamacpp.ts",
        find: `      "http",
      "The model server returned an error",
    );`,
        replace: `      "http",
      \`The model server returned an error: \${leaked}\`,
    );`,
      },
    ],
    vitest: [T("server/generations.test.ts")],
  },
  {
    id: "INV-05",
    title: "a generation can be decided twice",
    edits: [
      {
        file: "server/generations/manager.ts",
        find: `    if (generation.decided) return;
    generation.decided = true;
    clearTimeout(generation.maxTimer);`,
        replace: `    generation.decided = true;
    clearTimeout(generation.maxTimer);`,
      },
      {
        // The cancel path guards too; both must go for a second decision.
        file: "server/generations/manager.ts",
        find: `  private abort(generation: Generation, reason: AbortReason): void {
    if (generation.decided) return;`,
        replace: `  private abort(generation: Generation, reason: AbortReason): void {`,
      },
    ],
    vitest: [T("server/manager.test.ts"), T("server/generations.test.ts")],
  },
  {
    id: "INV-06",
    title: "closing the SSE stream cancels the generation",
    edits: [
      {
        file: "server/routes/generations.ts",
        find: `      () => {
        unsubscribe();
        untrack();
      },`,
        replace: `      () => {
        unsubscribe();
        untrack();
        void services.generations.cancel(params.id, auth.userId);
      },`,
      },
    ],
    vitest: [T("server/generations.test.ts")],
  },
  {
    id: "INV-07",
    title: "the reply is persisted twice",
    edits: [
      {
        file: "server/generations/manager.ts",
        find: "        revision = await generation.persist(outcome);",
        replace:
          "        revision = await generation.persist(outcome);\n        revision = await generation.persist(outcome);",
      },
    ],
    vitest: [T("server/conversations.test.ts"), T("server/manager.test.ts")],
  },
  {
    id: "INV-08",
    title: "202 is returned before the user message is written",
    edits: [
      {
        file: "server/chat/send-service.ts",
        find: "      await this.o.store.writeUnlocked(userId, conversationId, next);\n      await this.o.hooks?.afterMarkdownWrite?.();",
        replace:
          "      setTimeout(() => void this.o.store.writeUnlocked(userId, conversationId, next), 300);\n      await this.o.hooks?.afterMarkdownWrite?.();",
      },
    ],
    vitest: [T("server/conversations.test.ts")],
  },
  {
    id: "INV-09",
    title: "body lines that look like delimiters are not escaped",
    edits: [
      {
        file: "server/storage/markdown.ts",
        find: "    .map((line) => (NEEDS_ESCAPE.test(line) ? `\\\\${line}` : line))",
        replace: "    .map((line) => line)",
      },
    ],
    vitest: [T("storage/markdown.test.ts")],
  },
  {
    id: "INV-10",
    title: "a malformed conversation is treated as empty and overwritten",
    edits: [
      {
        file: "server/chat/send-service.ts",
        find: `    if (read.kind === "malformed") {
      throw new AppError(
        ErrorCode.CONVERSATION_MALFORMED,
        "This conversation file is malformed and cannot be changed",
      );
    }
    return read.conversation;`,
        replace: `    if (read.kind === "malformed") {
      const now = new Date().toISOString();
      return {
        id: conversationId,
        model: { title: "Recovered", createdAt: now, updatedAt: now, blocks: [] },
        bytes: Buffer.alloc(0),
        revision: read.revision,
      };
    }
    return read.conversation;`,
      },
    ],
    vitest: [T("server/conversations.test.ts")],
  },
  {
    id: "INV-11",
    title: "a missing index starts empty instead of being rebuilt",
    edits: [
      {
        file: "server/storage/chat-index.ts",
        find: `        "rebuilding conversation index",
      );
      await this.rebuild(userId);`,
        replace: `        "rebuilding conversation index",
      );
      this.entries.set(userId, new Map());`,
      },
    ],
    vitest: [T("storage/storage.test.ts"), T("server/conversations.test.ts")],
  },
  {
    id: "INV-12",
    title: "path components are no longer validated",
    edits: [
      {
        file: "server/storage/paths.ts",
        find: "if (!isUuid(value)) throw new PathError(`${what} must be a canonical lowercase UUID`);",
        replace: "void what;",
      },
    ],
    vitest: [T("storage/storage.test.ts"), T("server/security.test.ts")],
  },
  {
    id: "INV-13",
    title: "a second generation may start in a busy conversation",
    edits: [
      {
        file: "server/generations/manager.ts",
        find: `  assertIdle(conversationKey: string): void {
    if (this.active.has(conversationKey)) {`,
        replace: `  assertIdle(conversationKey: string): void {
    if (conversationKey === "never") {`,
      },
    ],
    vitest: [T("server/manager.test.ts"), T("server/conversations.test.ts")],
  },
  {
    id: "INV-14",
    title: "a route reads the acting user from the request",
    edits: [
      {
        file: "server/routes/conversations.ts",
        find: 'import { z } from "zod";',
        replace:
          'import { z } from "zod";\nexport const actAs = (ctx: { req: { headers: Record<string, unknown> } }) => ctx.req.headers["x-user"];',
      },
    ],
    vitest: [T("server/registry.test.ts")],
  },
  {
    id: "INV-15",
    title: "another user's generation is visible",
    edits: [
      {
        file: "server/generations/manager.ts",
        find: "if (!generation || (userId !== undefined && generation.userId !== userId)) {",
        replace: "if (!generation) {",
      },
    ],
    vitest: [T("server/auth.test.ts")],
  },
  {
    id: "INV-16",
    title: "state-changing routes skip the CSRF check",
    edits: [
      {
        file: "server/registry.ts",
        find: '      if (route.csrf === "token") services.auth.checkMutation(req, auth);',
        replace: "",
      },
    ],
    vitest: [T("server/registry.test.ts")],
  },
  {
    id: "INV-17",
    title: "sessions survive a role change or disabling",
    edits: [
      {
        file: "server/auth/service.ts",
        find: 'if (user?.status !== "active" || user.role !== session.role) {',
        replace: "if (!user) {",
      },
    ],
    vitest: [T("server/auth.test.ts")],
  },
  {
    id: "INV-18",
    title: "an unknown model is sent to the provider",
    edits: [
      {
        file: "server/generations/catalog.ts",
        find: `      throw new AppError(ErrorCode.MODEL_NOT_FOUND, "The selected model is not available");
    }
    return this.toModelDto(registered.entry, found);`,
        replace: `      return { providerId, id: modelId, contextTokens: 8192, status: "loaded", capabilities: registered.entry.capabilities, capabilitySources: { inputModalities: "config", reasoning: "config", tools: "config" } } as never;
    }
    return this.toModelDto(registered.entry, found);`,
      },
    ],
    vitest: [T("server/providers.test.ts")],
  },
  {
    id: "INV-19",
    title: "resolved provider addresses are not checked",
    edits: [
      {
        file: "server/providers/ssrf.ts",
        find: '  if (!ipaddr.isValid(address)) return "invalid address";',
        replace: '  if (address !== "") return undefined;',
      },
    ],
    vitest: [T("server/providers.test.ts"), T("server/admin.test.ts")],
  },
  {
    id: "INV-20",
    title: "a too-old Last-Event-ID replays silently instead of resyncing",
    edits: [
      {
        file: "server/generations/manager.ts",
        find: "} else if (cursor > generation.seq || cursor < oldest - 1) {",
        replace: "} else if (cursor > generation.seq) {",
      },
    ],
    vitest: [T("server/streaming.test.ts")],
  },
  {
    id: "INV-21",
    title: "an interrupted reply loses its partial output at restart",
    edits: [
      {
        file: "server/storage/recovery.ts",
        find: "      content: decided ? decided.content : checkpoint.content,",
        replace: '      content: decided ? decided.content : "",',
      },
    ],
    vitest: [T("server/streaming.test.ts")],
  },
  {
    id: "INV-22",
    title: "link URLs are not filtered",
    edits: [
      {
        file: "app/chat/markdown.tsx",
        find: '  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned) && !SAFE_SCHEME.test(cleaned)) return "";',
        replace: "",
      },
      {
        file: "app/chat/markdown.tsx",
        find: "  const cleaned = defaultUrlTransform(url);",
        replace: "  const cleaned = url;",
      },
    ],
    vitest: [T("client/markdown.test.tsx")],
  },
  {
    id: "INV-23",
    title: "an older conversation response overwrites newer data",
    edits: [
      {
        file: "app/lib/query/queries.ts",
        find: "  if (cached?.ok && cached.conversation.updatedAt > conversation.updatedAt) return false;",
        replace: "",
      },
    ],
    vitest: [T("client/resilience.test.tsx"), T("client/prefetch.test.ts")],
  },
  {
    id: "INV-24",
    title: "admin routes accept any signed-in user",
    edits: [
      {
        file: "server/registry.ts",
        find: '      if (route.auth === "admin" && auth?.role !== "admin")',
        replace: '      if (route.auth === "admin" && auth?.role === "none")',
      },
    ],
    vitest: [T("server/admin.test.ts")],
  },
  {
    id: "INV-25",
    title: "the provider API key is written to the audit log",
    edits: [
      {
        file: "server/admin/service.ts",
        find: "        hasApiKey: entry.apiKey !== undefined,\n      });\n      return this.providerDto(entry);",
        replace:
          "        hasApiKey: entry.apiKey !== undefined,\n        key: entry.apiKey ?? null,\n      });\n      return this.providerDto(entry);",
      },
    ],
    vitest: [T("server/admin.test.ts")],
  },
  {
    id: "INV-26",
    title: "the last admin can be demoted",
    edits: [
      {
        file: "server/admin/service.ts",
        find: "    if (admins.length <= 1)",
        replace: "    if (admins.length < 1)",
      },
    ],
    vitest: [T("server/admin.test.ts")],
  },
  {
    id: "INV-27",
    title: "SVG and HTML uploads are accepted",
    edits: [
      {
        file: "server/attachments/sniff.ts",
        find: '  if (ACTIVE_TEXT.test(start)) throw unsupported("HTML, SVG and XML documents are not supported");',
        replace: "",
      },
    ],
    vitest: [T("server/attachments.test.ts")],
  },
  {
    id: "INV-28",
    title: "the storage id is derived from the uploaded filename",
    edits: [
      {
        file: "server/attachments/store.ts",
        find: "    const id = randomUUID();\n    const dir = this.o.paths.attachmentDir(userId, id);",
        replace:
          "    const id = String((info as { filename?: string }).filename ?? randomUUID());\n    const dir = this.o.paths.attachmentDir(userId, id);",
      },
    ],
    vitest: [T("server/attachments.test.ts")],
    grep: "INV-28",
  },
  {
    id: "INV-29",
    title: "a critical startup load waits for another one first",
    edits: [
      {
        file: "app/routes/app-layout.tsx",
        find: "        queryFn: () => services.bootstrap.preferences(userId),",
        replace:
          "        queryFn: async () => {\n          await services.bootstrap.models(auth.role);\n          return services.bootstrap.preferences(userId);\n        },",
      },
    ],
    vitest: [T("client/query-ssr.test.ts")],
  },
  {
    id: "INV-30",
    title: "the secondary chat list holds the document",
    edits: [
      {
        file: "app/routes/app-layout.tsx",
        find: `          withBudget(
            Promise.resolve(services.bootstrap.conversations(userId)),
            SECONDARY_BUDGET_MS,
          ),`,
        replace: "          Promise.resolve(services.bootstrap.conversations(userId)),",
      },
    ],
    vitest: [T("client/query-ssr.test.ts")],
  },
  {
    id: "INV-31",
    title: "prefetch uses its own cache key",
    edits: [
      {
        file: "app/lib/prefetch.ts",
        find: "      .query(conversationQuery(userId, id))",
        replace:
          '      .query({ ...conversationQuery(userId, id), queryKey: ["prefetch", userId, id] })',
      },
    ],
    vitest: [T("client/prefetch.test.ts")],
  },
  {
    id: "INV-32",
    title: "stored messages re-render on every streamed token",
    edits: [
      {
        file: "app/chat/message.tsx",
        find: "export const Message = memo(function Message({",
        replace: "export const Message = (function Message({",
      },
      {
        // The transcript's memo is what keeps stored messages out of a delta's render.
        file: "app/chat/transcript.tsx",
        find: "export const Transcript = memo(function Transcript({",
        replace: "export const Transcript = (function Transcript({",
      },
    ],
    vitest: [T("client/render-isolation.test.tsx")],
  },
  {
    id: "INV-33",
    title: "the document loads a third-party stylesheet",
    edits: [
      {
        file: "app/root.tsx",
        find: "        <Meta />",
        replace:
          '        <Meta />\n        <link rel="stylesheet" href="https://cdn.example.com/x.css" />',
      },
    ],
    verify: true,
  },
  {
    id: "INV-34",
    title: "deleting a chat keeps its pin",
    edits: [
      {
        file: "server/chat/mutations.ts",
        find: "    await this.forgetPin(userId, conversationId);",
        replace: "",
      },
    ],
    vitest: [T("server/mutations.test.ts")],
  },
  {
    id: "INV-35",
    title: "edits ignore the expected revision",
    edits: [
      {
        file: "server/chat/mutations.ts",
        find: "  if (read.conversation.revision !== expectedRevision) {",
        replace:
          '  if (read.conversation.revision !== expectedRevision && expectedRevision === "never") {',
      },
    ],
    vitest: [T("server/mutations.test.ts")],
  },
  {
    id: "INV-36",
    title: "search results are unbounded",
    edits: [
      {
        file: "server/chat/search.ts",
        find: "    const max = Math.min(Math.max(1, limit), SEARCH_MAX_CHATS);",
        replace: "    const max = 100_000;",
      },
    ],
    vitest: [T("server/mutations.test.ts")],
  },
  {
    id: "INV-37",
    title: "a remember call saves the memory without the user",
    edits: [
      {
        file: "server/chat/send-service.ts",
        find: "    await this.writeSidecar(userId, conversationId, outcome);\n    if (\n      this.o.artifacts &&",
        replace:
          '    await this.writeSidecar(userId, conversationId, outcome);\n    for (const p of outcome.proposals)\n      if (p.tool === "remember" && p.content !== null)\n        await this.o.memories?.createUnlocked(userId, { name: p.name, body: p.content }).catch(() => undefined);\n    if (\n      this.o.artifacts &&',
      },
    ],
    vitest: [T("server/memories.test.ts")],
  },
  {
    id: "INV-38",
    title: "acceptance ignores a note changed since the reply's snapshot",
    edits: [
      {
        file: "server/memory/service.ts",
        find: "    if (target.revision !== record.baselineRevision) return null;",
        replace: "",
      },
    ],
    vitest: [T("server/memories.test.ts")],
  },
  {
    id: "INV-39",
    title: "memories are stored in one directory for every account",
    edits: [
      {
        file: "server/storage/paths.ts",
        find: `  memoriesDir(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "memories");
  }

  memoryFile(userId: string, memoryId: string): string {
    return this.inside(
      this.uuid(userId, "user id"),
      "memories",`,
        replace: `  memoriesDir(userId: string): string {
    void userId;
    return this.inside(SYSTEM_DIR, "memories");
  }

  memoryFile(userId: string, memoryId: string): string {
    void userId;
    return this.inside(
      SYSTEM_DIR,
      "memories",`,
      },
    ],
    vitest: [T("server/memories.test.ts")],
  },
  {
    id: "INV-40",
    title: "a cancelled reply's files are captured",
    edits: [
      {
        file: "server/chat/send-service.ts",
        find: `      assistantMessageId &&
      outcome.state === "completed" &&
      outcome.artifacts.length > 0 &&`,
        replace: `      assistantMessageId &&
      (outcome.state === "completed" || outcome.state === "cancelled") &&
      outcome.artifacts.length > 0 &&`,
      },
      {
        // The manager stages files only for completed replies; both checks must go.
        file: "server/generations/manager.ts",
        find: '      artifacts: state === "completed" ? this.captures(generation) : [],',
        replace: "      artifacts: this.captures(generation),",
      },
    ],
    vitest: [T("server/artifacts.test.ts")],
  },
  {
    id: "INV-41",
    title: "captured files are served as HTML",
    edits: [
      {
        file: "server/routes/artifacts.ts",
        find: '      "Content-Type": "text/plain; charset=utf-8",',
        replace: '      "Content-Type": "text/html; charset=utf-8",',
      },
    ],
    vitest: [T("server/artifacts.test.ts")],
  },
  {
    id: "INV-42",
    title: "archives may hold any number of entries",
    edits: [
      {
        file: "server/portability/zip.ts",
        find: '    if (count > this.limits.maxEntries) throw new ZipError("too many entries");',
        replace: "",
      },
    ],
    vitest: [T("server/portability.test.ts")],
  },
  {
    id: "INV-43",
    title: "exports re-encode the chat Markdown",
    edits: [
      {
        file: "server/portability/export.ts",
        find: "      small.set(`chats/${id}.md`, bytes);",
        replace:
          '      small.set(`chats/${id}.md`, Buffer.from(bytes.toString("utf8").trimEnd()));',
      },
    ],
    vitest: [T("server/portability.test.ts")],
  },
  {
    id: "INV-44",
    title: "images reach a model without vision",
    edits: [
      {
        file: "server/chat/send-service.ts",
        find: `    // Images and audio only reach a server-verified model with that modality (INV-44).
    for (const kind of ["image", "audio"] as const) {
      if (
        attached.some`,
        replace: `    // Images and audio only reach a server-verified model with that modality (INV-44).
    for (const kind of ["image", "audio"] as const) {
      if (
        kind === ("never" as string) &&
        attached.some`,
      },
    ],
    vitest: [T("server/attachments.test.ts")],
  },
  {
    id: "INV-45",
    title: "code in an unknown language is inserted as HTML",
    edits: [
      {
        file: "app/chat/render/code.tsx",
        find: "  if (!language || !hljs.getLanguage(language)) return null;",
        replace: "  if (!language || !hljs.getLanguage(language)) return source;",
      },
    ],
    vitest: [T("client/rendering.test.tsx"), T("client/markdown.test.tsx")],
  },
  {
    id: "INV-46",
    title: "streamed growth always scrolls, even when the reader scrolled up",
    edits: [
      {
        file: "app/chat/scroll-intent.ts",
        find: "    if (state.pinned) return { state, follow: true };",
        replace: "    return { state, follow: true };",
      },
    ],
    vitest: [T("client/scroll-intent.test.ts"), T("client/render-isolation.test.tsx")],
  },
  {
    id: "INV-47",
    title: "a nested dialog forgets the element that opened it",
    edits: [
      {
        file: "app/ui/dialog.tsx",
        find: `      claimMenuOpener() ??
      (active instanceof HTMLElement && active !== document.body ? active : null);`,
        replace: "      claimMenuOpener();\n    void active;",
      },
    ],
    e2e: [T("e2e/primitives.spec.ts")],
  },
  {
    id: "INV-48",
    title: "a second Enter before re-render sends again",
    edits: [
      {
        file: "app/chat/composer.tsx",
        find: `    // Cleared synchronously: a second Enter before React re-renders finds nothing to send.
    el.value = "";`,
        replace: "",
      },
      {
        file: "app/chat/chat-context.tsx",
        find: "      if (sending.current || running) return false;",
        replace: "      if (running) return false;",
      },
    ],
    vitest: [T("client/composer.test.tsx")],
  },
  {
    id: "INV-49",
    title: "the image leaves out a module the CLI loads",
    edits: [
      {
        file: "Dockerfile",
        find: "COPY server/http-server.ts server/backup.ts ./server/\n",
        replace: "",
      },
    ],
    vitest: [T("scripts/dockerfile-imports.test.ts")],
  },
  {
    id: "INV-50",
    title: "restore skips checksum verification",
    edits: [
      {
        file: "server/backup.ts",
        find: "    if (data.length !== file.size || sha256(data) !== file.sha256)",
        replace: "    if (data.length < 0)",
      },
    ],
    vitest: [T("server/backup.test.ts")],
  },
  {
    id: "INV-52",
    title: "read aloud is offered without speech support",
    edits: [
      {
        file: "app/chat/read-aloud.ts",
        find: "  return useSyncExternalStore(subscribe, speechSupported, () => false);",
        replace: "  return useSyncExternalStore(subscribe, () => true, () => false);",
      },
    ],
    vitest: [T("client/rendering.test.tsx")],
  },
  {
    id: "INV-53",
    title: "the first send pushes a history entry instead of replacing the draft URL",
    edits: [
      {
        file: "app/chat/chat-context.tsx",
        find: "              await navigate(paths.chat(accepted.conversationId), { replace: true });",
        replace:
          "              await navigate(paths.chat(accepted.conversationId), { replace: false });",
      },
    ],
    e2e: [T("e2e/routing.spec.ts")],
  },
  {
    id: "INV-54",
    title: "the composer renders only after hydration",
    edits: [
      {
        file: "app/chat/composer.tsx",
        find: `  }, [interactive]);

  return (
    <>`,
        replace: `  }, [interactive]);

  if (!hydrated) return null;
  return (
    <>`,
      },
    ],
    // The server-rendered composer before hydration (verify checks it too, slowly).
    e2e: [T("e2e/resilience.spec.ts")],
  },
  {
    id: "INV-55",
    title: "server renders share one QueryClient",
    edits: [
      {
        file: "app/lib/query/client.ts",
        find: `export function makeQueryClient(server = typeof window === "undefined"): QueryClient {
  return new QueryClient({`,
        replace: `let sharedServer: QueryClient | undefined;
export function makeQueryClient(server = typeof window === "undefined"): QueryClient {
  if (server && sharedServer) return sharedServer;
  return (sharedServer = new QueryClient({`,
      },
      {
        file: "app/lib/query/client.ts",
        find: `      queries: { staleTime: STALE_TIME_MS, retry: server ? false : 1, refetchOnWindowFocus: false },
    },
  });`,
        replace: `      queries: { staleTime: STALE_TIME_MS, retry: server ? false : 1, refetchOnWindowFocus: false },
    },
  }));`,
      },
    ],
    vitest: [T("client/query-ssr.test.ts")],
  },
  {
    id: "INV-56",
    title: "hydration replaces text typed before it",
    edits: [
      {
        file: "app/chat/composer.tsx",
        find: `    } else if (el.value === "") {
      el.value = draftStore.get(key);
    }`,
        replace: `    } else {
      el.value = draftStore.get(key);
    }`,
      },
    ],
    e2e: [T("e2e/resilience.spec.ts")],
  },
  {
    id: "INV-57",
    title: "unknown API paths fall through to the document handler",
    edits: [{ file: "server/create-app.ts", find: "  api.use(apiNotFound);", replace: "" }],
    vitest: [T("server/boundary.test.ts"), T("server/errors.test.ts")],
  },
  {
    id: "INV-58",
    title: "a resent operation key starts a second generation",
    edits: [
      {
        file: "server/chat/send-service.ts",
        find: "    const known = await this.checkKey(userId, request, payloadHash);",
        replace: '    const known = null as Awaited<ReturnType<SendService["checkKey"]>>;',
      },
      {
        file: "server/chat/send-service.ts",
        find: "          const again = await this.checkKey(userId, request, payloadHash);",
        replace: '          const again = null as Awaited<ReturnType<SendService["checkKey"]>>;',
      },
    ],
    vitest: [T("server/conversations.test.ts")],
  },
  {
    id: "INV-59",
    title: "a mutation runs under a different user than the tab expected",
    edits: [
      {
        file: "server/auth/service.ts",
        find: '    if (req.get("x-expected-user") !== auth.userId) {',
        replace: '    if (req.get("x-expected-user") === "never") {',
      },
    ],
    vitest: [T("server/auth.test.ts"), T("server/registry.test.ts")],
  },
  {
    id: "INV-60",
    title: "recovery re-adds a reply the user deleted",
    edits: [
      {
        file: "server/storage/recovery.ts",
        find: `        record.status !== "committed" ||
        record.terminalWritten ||
        withCheckpoint.has(record.generationId)`,
        replace: `        record.status !== "committed" ||
        withCheckpoint.has(record.generationId)`,
      },
    ],
    vitest: [T("server/streaming.test.ts"), T("server/conversations.test.ts")],
  },
  {
    id: "INV-61",
    title: "a closing account's late reply is still written",
    edits: [
      {
        file: "server/chat/send-service.ts",
        find: "      if (await this.o.isClosing?.(userId)) {",
        replace: '      if (await this.o.isClosing?.("00000000-0000-4000-8000-000000000000")) {',
      },
    ],
    vitest: [T("server/admin.test.ts")],
  },
  {
    id: "INV-62",
    title: "generation admission is unbounded",
    edits: [
      {
        file: "server/generations/manager.ts",
        find: `  assertAdmission(userId?: string, providerId?: string): void {
    const perUser = this.options.maxActivePerUser ?? Number.POSITIVE_INFINITY;`,
        replace: `  assertAdmission(userId?: string, providerId?: string): void {
    return;
    const perUser = this.options.maxActivePerUser ?? Number.POSITIVE_INFINITY;`,
      },
    ],
    vitest: [T("server/generations.test.ts"), T("server/auth.test.ts")],
  },
];
