/**
 * `npm run verify:compose`: builds the production image and verifies the
 * supported Compose runtime (INV-49) on Docker or rootless Podman:
 *   - loopback-only host publication; container listens on its own interface
 *   - health, SSR HTML, CSP, 404 separation and hydration inside the container
 *   - non-root user, read-only root filesystem, healthcheck, CLI entrypoint
 *   - /data writable by the app user; a test sentinel survives recreate
 *   - clean SIGTERM shutdown
 *   - Podman SELinux labeling of a bind-mounted /data (where SELinux enforces)
 * Uses an isolated project, image tag and volume; never touches real data.
 * Exits 2 with "NOT RUN" when no container engine is available.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { browserChecks, check, httpChecks, results } from "./lib/checks.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string,
  args: string[],
  options: { env?: Record<string, string>; quiet?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!options.quiet) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!options.quiet) process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      resolve({ code: 127, stdout, stderr: stderr + error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function detectEngine(): Promise<"docker" | "podman" | undefined> {
  const wanted = process.env.COMPOSE_ENGINE;
  const candidates: readonly ("docker" | "podman")[] =
    wanted === "docker" || wanted === "podman" ? [wanted] : ["docker", "podman"];
  for (const engine of candidates) {
    const probe = await run(engine, ["compose", "version"], { quiet: true });
    if (probe.code === 0) return engine;
  }
  return undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitForHealth(base: string, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(1_000);
  }
  return false;
}

function connectRefused(host: string, port: number): Promise<boolean> {
  return fetch(`http://${host}:${String(port)}/api/health`, {
    signal: AbortSignal.timeout(3_000),
  }).then(
    () => false,
    () => true,
  );
}

async function main(): Promise<void> {
  const engine = await detectEngine();
  if (!engine) {
    process.stdout.write(
      "NOT RUN  verify:compose — no Docker or Podman Compose available on this host\n",
    );
    process.exitCode = 2;
    return;
  }
  const id = Math.random().toString(36).slice(2, 8);
  const project = `chatui-verify-${id}`;
  const hostPort = await freePort();
  const env = {
    HOST_PORT: String(hostPort),
    CHATUI_VOLUME: `${project}-data`,
    CHATUI_IMAGE: `localhost/chatui:verify-${id}`,
  };
  const compose = (args: string[], quiet = false, files: string[] = ["compose.yaml"]) =>
    run(engine, ["compose", "-p", project, ...files.flatMap((f) => ["-f", f]), ...args], {
      env,
      quiet,
    });
  const base = `http://127.0.0.1:${String(hostPort)}`;
  // Engine-level lookup by the standard Compose labels (set by Docker Compose and
  // podman-compose alike); compose subcommand output formats differ between them.
  const containerId = async (): Promise<string> =>
    (
      await run(
        engine,
        [
          "ps",
          "-aq",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--filter",
          "label=com.docker.compose.service=chatui",
        ],
        { quiet: true },
      )
    ).stdout
      .trim()
      .split("\n")[0] ?? "";
  const version = (
    JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }
  ).version;
  process.stdout.write(
    `verify:compose using ${engine} (project ${project}, port ${String(hostPort)})\n`,
  );

  try {
    const build = await compose(["build"]);
    check(`${engine}: image builds`, build.code === 0);
    if (build.code !== 0) return;

    const up = await compose(["up", "-d"]);
    check(`${engine}: compose up`, up.code === 0);
    check("container becomes reachable", await waitForHealth(base));

    const firstId = await containerId();
    check("container found by Compose labels", firstId !== "", project);
    let health = "";
    if (engine === "podman") {
      // Podman schedules healthchecks with systemd timers, which CI runners may lack;
      // run the image's HEALTHCHECK directly (this also updates the recorded status).
      const probe = await run(engine, ["healthcheck", "run", firstId], { quiet: true });
      if (probe.code === 0) health = "healthy";
    }
    for (let i = 0; i < 45 && health !== "healthy"; i++) {
      const inspect = await run(
        engine,
        ["inspect", "--format", "{{.State.Health.Status}}", firstId],
        {
          quiet: true,
        },
      );
      health = inspect.stdout.trim();
      if (health !== "healthy") await sleep(2_000);
    }
    check("container healthcheck reports healthy", health === "healthy", health);

    const published = (await run(engine, ["port", firstId, "3000/tcp"], { quiet: true })).stdout
      .trim()
      .split("\n")
      .join(", ");
    check(
      "INV-49: host port published on 127.0.0.1 only",
      published === `127.0.0.1:${String(hostPort)}`,
      published,
    );
    const external = Object.values(networkInterfaces())
      .flat()
      .find((iface) => iface?.family === "IPv4" && !iface.internal)?.address;
    if (external) {
      check(
        "not reachable through a non-loopback host address",
        await connectRefused(external, hostPort),
        external,
      );
    } else {
      process.stdout.write("NOT RUN  non-loopback reachability (host has no external IPv4)\n");
    }

    const logs = (await compose(["logs", "--no-color", "chatui"], true)).stdout;
    check(
      "app listens on the container interface in production mode",
      logs.includes('"msg":"listening"') &&
        logs.includes('"host":"0.0.0.0"') &&
        logs.includes('"mode":"production"'),
    );

    const uid = (await compose(["exec", "-T", "chatui", "id", "-u"], true)).stdout.trim();
    check("runs as a non-root user", uid !== "" && uid !== "0", uid);
    const writeApp = await compose(["exec", "-T", "chatui", "sh", "-c", "touch /app/x"], true);
    check("root filesystem is read-only", writeApp.code !== 0);
    const cliHealth = await compose(
      ["exec", "-T", "chatui", "node", "server/cli.ts", "healthcheck"],
      true,
    );
    check("CLI healthcheck exits 0", cliHealth.code === 0);
    const planned = await compose(
      ["exec", "-T", "chatui", "node", "server/cli.ts", "user:create"],
      true,
    );
    check(
      "planned CLI commands fail clearly instead of succeeding",
      planned.code === 2 && planned.stderr.includes("Phase 4"),
    );

    // Application behaviour inside the container.
    await httpChecks(base);
    await browserChecks(base);
    const healthJson = (await (await fetch(`${base}/api/health`)).json()) as { version?: string };
    check("container serves this build's version", healthJson.version === version);

    // Persistence: a test sentinel (the app itself writes nothing yet).
    const sentinel = `verify-${id}`;
    const write = await compose(
      ["exec", "-T", "chatui", "sh", "-c", `echo ${sentinel} > /data/.verify-sentinel`],
      true,
    );
    check("/data is writable by the app user", write.code === 0, write.stderr.trim());
    const down = await compose(["down"]);
    check("compose down keeps the volume", down.code === 0);
    const recreate = await compose(["up", "-d", "--force-recreate"]);
    check("compose up after recreate", recreate.code === 0 && (await waitForHealth(base)));
    const read = await compose(["exec", "-T", "chatui", "cat", "/data/.verify-sentinel"], true);
    check(
      "INV-49: /data sentinel survives container recreate",
      read.stdout.trim() === sentinel,
      read.stdout.trim(),
    );

    // Clean shutdown on SIGTERM (compose stop).
    const newId = await containerId();
    await compose(["stop"]);
    const exitCode = (
      await run(engine, ["inspect", "--format", "{{.State.ExitCode}}", newId], { quiet: true })
    ).stdout.trim();
    const stopLogs = (await compose(["logs", "--no-color", "chatui"], true)).stdout;
    check("clean shutdown on SIGTERM (exit 0)", exitCode === "0", exitCode);
    check("shutdown logged", stopLogs.includes('"shutdown complete"'));

    // Podman: SELinux private label on a bind-mounted /data.
    if (engine === "podman") {
      const enforcing =
        (await run("getenforce", [], { quiet: true })).stdout.trim() === "Enforcing";
      if (enforcing) {
        await compose(["down"]);
        const bindDir = mkdtempSync(path.join(tmpdir(), "chatui-selinux-"));
        const files = ["compose.yaml", "compose.podman.yaml"];
        const upBind = await run(
          engine,
          ["compose", "-p", project, ...files.flatMap((f) => ["-f", f]), "up", "-d"],
          { env: { ...env, CHATUI_DATA_DIR: bindDir } },
        );
        const ok = upBind.code === 0 && (await waitForHealth(base));
        const w = await compose(
          ["exec", "-T", "chatui", "sh", "-c", "echo ok > /data/.selinux"],
          true,
          files,
        );
        check(
          "Podman SELinux: bind-mounted /data (:Z) writable under enforcement",
          ok && w.code === 0,
        );
        await compose(["down"], true, files);
        rmSync(bindDir, { recursive: true, force: true });
      } else {
        process.stdout.write(
          "NOT RUN  Podman SELinux labeling (SELinux not enforcing on this host)\n",
        );
      }
    } else {
      process.stdout.write("NOT RUN  Podman SELinux labeling (engine is docker)\n");
    }
  } finally {
    await compose(["down", "-v", "--remove-orphans"], true);
    await run(engine, ["image", "rm", "-f", env.CHATUI_IMAGE], { quiet: true });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `verify:compose failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
if (results.length > 0) {
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    `\nverify:compose: ${String(results.length - failed.length)}/${String(results.length)} checks passed\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}
