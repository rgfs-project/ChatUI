/**
 * `npm run demo`: a self-contained demo instance on http://localhost:3000.
 *
 * - a deterministic mock model server (no real LLM needed)
 * - DATA_DIR=./demo-data with two accounts and sample chats, created once
 *   (delete the folder to start over); never touches ./data
 * - the production build (built first when missing)
 *
 * Accounts: demo / demo password 1234 (admin) and demo2 / demo password 1234.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MOCK_MODELS, startMockLlama } from "../tests/support/mock-llama.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = path.join(ROOT, "demo-data");
const PORT = process.env.PORT ?? "3000";
const ORIGIN = `http://localhost:${PORT}`;
export const DEMO_PASSWORD = "demo password 1234";

function run(cmd: string, args: string[], input?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR },
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    });
    if (input !== undefined) child.stdin?.end(input);
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

async function createUser(username: string, admin: boolean): Promise<string> {
  const before = new Set(existsSync(DATA_DIR) ? readdirSync(DATA_DIR) : []);
  const code = await run(
    process.execPath,
    ["server/cli.ts", "user:create", "--username", username, ...(admin ? ["--admin"] : [])],
    `${DEMO_PASSWORD}\n`,
  );
  const id = readdirSync(DATA_DIR).find((name) => !before.has(name) && name !== "_system");
  if (code !== 0 || !id) throw new Error(`could not create the demo account ${username}`);
  return id;
}

interface Turn {
  user: string;
  assistant: string;
}

/** Writes one canonical formatVersion 1 conversation (contracts §3). */
function writeChat(userId: string, title: string, turns: Turn[], minutesAgo: number): void {
  const start = Date.now() - minutesAgo * 60_000;
  const iso = (offset: number) => new Date(start + offset * 60_000).toISOString();
  const blocks = turns.flatMap((turn, i) => [
    `<!-- cc:user id=${randomUUID()} time="${iso(i * 2)}" -->\n${turn.user}`,
    `<!-- cc:assistant id=${randomUUID()} status=complete provider="local" model="${MOCK_MODELS.chat}" time="${iso(i * 2 + 1)}" -->\n${turn.assistant}`,
  ]);
  const file = [
    "---",
    "formatVersion: 1",
    `title: ${JSON.stringify(title)}`,
    `createdAt: "${iso(0)}"`,
    `updatedAt: "${iso(turns.length * 2)}"`,
    "---",
    "",
    blocks.join("\n\n"),
    "",
  ].join("\n");
  const dir = path.join(DATA_DIR, userId, "chats");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, `${randomUUID()}.md`), file, { mode: 0o600 });
}

const SAMPLES: [string, Turn[]][] = [
  [
    "Plan a Sunday roast for friends",
    [
      {
        user: "Plan a Sunday roast for six friends, with a shopping list.",
        assistant:
          "## Menu\n\n- Roast chicken with lemon and thyme\n- Crispy potatoes\n- Honey-glazed carrots\n- Gravy\n\n## Shopping list\n\n| Item | Amount |\n|---|---|\n| Whole chicken | 2 × 1.6 kg |\n| Potatoes | 2 kg |\n| Carrots | 1 kg |\n| Lemons | 2 |\n\nStart the potatoes 75 minutes before you want to eat.",
      },
    ],
  ],
  [
    "Compare three ways to structure a monorepo",
    [
      {
        user: "Compare three ways to structure a monorepo.",
        assistant:
          "1. **Package-based** (workspaces): each package has its own `package.json`.\n2. **App + libs**: apps at the top level, shared code under `libs/`.\n3. **Domain folders**: one folder per business domain.\n\nWorkspaces are the simplest place to start.",
      },
    ],
  ],
  [
    "Help me pack for a weekend hiking trip",
    [
      {
        user: "Help me pack for a weekend hiking trip.",
        assistant:
          "- Layers: base layer, fleece, waterproof shell\n- Map, compass and a charged phone\n- 2 litres of water per person per day\n- First-aid kit\n  - plasters\n  - blister patches",
      },
    ],
  ],
  [
    "Here is a Python greeting script",
    [
      {
        user: "Write a tiny Python greeting script.",
        assistant:
          'Here it is:\n\n```python\nname = input("Your name: ")\nprint(f"Hello, {name}!")\n```\n\nRun it with `python greet.py`.',
      },
    ],
  ],
  [
    "What can you do?",
    [
      {
        user: "What can you do?",
        assistant:
          "I can answer questions, draft and edit text, explain code and help you plan. This demo uses a mock model, so replies echo what you write.",
      },
    ],
  ],
];

async function seed(): Promise<void> {
  if (existsSync(path.join(DATA_DIR, "_system", "users.index.json"))) return;
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const demo = await createUser("demo", true);
  const demo2 = await createUser("demo2", false);
  SAMPLES.forEach(([title, turns], i) => {
    writeChat(demo, title, turns, 60 * (i + 1));
  });
  writeChat(
    demo2,
    "Second account's chat",
    [{ user: "Hello", assistant: "Each account only sees its own chats." }],
    30,
  );
  process.stdout.write("demo: seeded demo-data/ with two accounts and sample chats\n");
}

async function main(): Promise<void> {
  if (!existsSync(path.join(ROOT, "build/server/index.js"))) {
    process.stdout.write("demo: building first…\n");
    if ((await run("npm", ["run", "build"])) !== 0) throw new Error("build failed");
  }
  await seed();
  // The mock model gets a new port each run: let the server bootstrap the
  // demo's provider list from LLAMA_BASE_URL again.
  rmSync(path.join(DATA_DIR, "_system", "providers.json"), { force: true });
  const llama = await startMockLlama({
    chatChunkDelayMs: 25,
    chunkDelayMs: 80,
    listed: [MOCK_MODELS.chat, MOCK_MODELS.slow, MOCK_MODELS.long],
  });
  const server = spawn(process.execPath, ["server/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT,
      PUBLIC_ORIGIN: ORIGIN,
      DATA_DIR,
      LLAMA_BASE_URL: llama.url,
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    },
    stdio: "inherit",
  });
  const version = (
    JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  process.stdout.write(
    `\nChatUI ${version} demo: ${ORIGIN}\n  demo / ${DEMO_PASSWORD} (admin)\n  demo2 / ${DEMO_PASSWORD}\nCtrl+C to stop.\n\n`,
  );
  const stop = () => {
    server.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.once("exit", (code) => {
    void llama.close().then(() => {
      process.exit(code ?? 0);
    });
  });
}

await main();
