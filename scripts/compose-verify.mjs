#!/usr/bin/env node
/**
 * Acceptance for the deployment, not for the code.
 *
 * `npm run verify` proves the built server behaves; this proves the thing an
 * operator actually installs. It drives the real image through the real compose
 * file, on a throwaway project name and volume, and asserts the sequence a
 * first deployment goes through:
 *
 *   1. it builds and comes up healthy from nothing
 *   2. the first admin can be created without a session, password on stdin
 *   3. that admin can sign in
 *   4. the provider is reachable from inside the container
 *   5. a generation runs end to end and is stored
 *   6. recreating the container keeps everything
 *   7. upgrading the image keeps everything
 *   8. backup and restore round-trip through a fresh volume
 *   9. SIGTERM is answered promptly and with a clean exit
 *
 * It needs a container engine and nothing else — no Node on the host beyond the
 * one running this file, which is the property being demonstrated.
 *
 *   node scripts/compose-verify.mjs                  # docker compose
 *   COMPOSE="podman-compose" node scripts/compose-verify.mjs
 *   ENGINE=podman COMPOSE="podman compose" node scripts/compose-verify.mjs
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COMPOSE = (process.env['COMPOSE'] ?? 'docker compose').split(' ');
const ENGINE = process.env['ENGINE'] ?? COMPOSE[0];
/** Its own project, so a run cannot touch a deployment on the same machine. */
const PROJECT = process.env['COMPOSE_VERIFY_PROJECT'] ?? 'rgfschat-verify';
const ADMIN = 'verifyadmin';
const PASSWORD = 'compose-verify-passphrase';

let failures = 0;
let step = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function heading(text) {
  step += 1;
  console.log(`\n[${step}] ${text}`);
}

function compose(args, options = {}) {
  const full = [...COMPOSE.slice(1), '-p', PROJECT, ...args];
  const result = spawnSync(COMPOSE[0], full, {
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.stdio === undefined ? {} : { stdio: options.stdio }),
  });
  if (options.allowFailure !== true && result.status !== 0) {
    throw new Error(
      `${COMPOSE[0]} ${full.join(' ')} failed (${result.status}):\n${result.stderr ?? ''}${result.stdout ?? ''}`
    );
  }
  return result;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createSocket();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A deterministic stand-in for llama.cpp, on the host.
 *
 * On the host deliberately: reaching a provider that is not in the compose
 * project is the configuration most deployments actually have, and the one that
 * `localhost` inside a container gets wrong. If `host.docker.internal` is not
 * mapped, this is the step that says so.
 */
function startProvider(port) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'Mock Model',
                object: 'model',
                architecture: { input_modalities: ['text'], output_modalities: ['text'] },
              },
            ],
          })
        );
        return;
      }
      if (!req.url.startsWith('/v1/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const frame = (choices, extra = {}) =>
        `data: ${JSON.stringify({ choices, created: 1, id: 'verify', model: 'Mock Model', object: 'chat.completion.chunk', ...extra })}\n\n`;
      res.write(
        frame([{ index: 0, finish_reason: null, delta: { role: 'assistant', content: null } }])
      );
      for (const text of ['Hello', ' from', ' the', ' container']) {
        res.write(frame([{ index: 0, finish_reason: null, delta: { content: text } }]));
      }
      res.write(frame([{ index: 0, finish_reason: 'stop', delta: {} }]));
      res.write(frame([], { usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 } }));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

async function waitForHealth(baseUrl, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** The engine's own opinion of the container's health, not ours. */
function healthStatus() {
  const id = compose(['ps', '-q', 'app']).stdout.trim().split('\n')[0];
  if (!id) return 'no container';
  const out = spawnSync(ENGINE, ['inspect', '-f', '{{.State.Health.Status}}', id], {
    encoding: 'utf8',
  });
  return (out.stdout ?? '').trim() || 'unknown';
}

/** Signed-in HTTP against the deployment, carrying the session and CSRF token. */
function client(baseUrl) {
  let cookie = '';
  let csrf = '';
  return {
    get csrf() {
      return csrf;
    },
    async call(path, init = {}) {
      const res = await fetch(baseUrl + path, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie === '' ? {} : { Cookie: cookie }),
          ...(csrf === '' ? {} : { 'X-CSRF-Token': csrf }),
          ...(init.headers ?? {}),
        },
      });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length > 0) cookie = set.map((entry) => entry.split(';')[0]).join('; ');
      return res;
    },
    async signIn() {
      const res = await this.call('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: ADMIN, password: PASSWORD }),
      });
      if (!res.ok) return false;
      csrf = (await res.json()).csrfToken;
      return true;
    },
    forget() {
      cookie = '';
      csrf = '';
    },
  };
}

async function main() {
  const engineCheck = spawnSync(COMPOSE[0], [...COMPOSE.slice(1), 'version'], { encoding: 'utf8' });
  if (engineCheck.status !== 0) {
    console.error(`No usable compose command: "${COMPOSE.join(' ')}".`);
    console.error('Set COMPOSE, e.g. COMPOSE="podman-compose" node scripts/compose-verify.mjs');
    process.exit(2);
  }
  console.log(`engine:  ${ENGINE}\ncompose: ${COMPOSE.join(' ')}\nproject: ${PROJECT}`);

  const port = await freePort();
  const providerPort = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    // The port the deployment publishes, and where its provider is. Both are
    // ordinary compose variables; nothing here is test-only plumbing.
    RGFSCHAT_PORT: String(port),
    LLAMA_BASE_URL: `http://host.docker.internal:${providerPort}`,
    LLAMA_API_KEY: '',
  };

  const provider = await startProvider(providerPort);
  const backupDir = await mkdtemp(join(tmpdir(), 'rgfschat-verify-'));
  const backupFile = join(backupDir, 'data.tar');

  try {
    heading('Starting from nothing');
    compose(['down', '-v', '--remove-orphans'], { allowFailure: true, env });
    compose(['up', '-d', '--build'], { env, stdio: 'inherit' });
    check('the deployment comes up', await waitForHealth(baseUrl), `no health on ${baseUrl}`);

    const version = await (await fetch(`${baseUrl}/api/health`)).json();
    check(
      'health reports a version',
      typeof version.version === 'string' && version.version !== ''
    );

    const whoami = compose(['exec', '-T', 'app', 'id'], { env }).stdout;
    check('the server runs as a non-root user', /uid=(?!0\()/.test(whoami), whoami.trim());

    heading('Claiming the instance');
    const anonymous = await fetch(`${baseUrl}/api/conversations`);
    check(
      'nothing is readable before signing in',
      anonymous.status === 401,
      `got ${anonymous.status}`
    );

    const created = compose(
      ['run', '--rm', '-T', 'app', 'create-admin', '--username', ADMIN, '--admin'],
      { input: `${PASSWORD}\n`, env, allowFailure: true }
    );
    check(
      'create-admin makes the first account, password on stdin',
      created.status === 0,
      created.stderr
    );

    const api = client(baseUrl);
    check('the new admin can sign in', await api.signIn());

    heading('Reaching the provider');
    // Discovery is warmed in the background, so give it a moment to answer.
    let models = null;
    for (let attempt = 0; attempt < 40 && models === null; attempt += 1) {
      const res = await api.call('/api/models');
      if (res.ok) {
        const body = await res.json();
        const ready = body.providers?.find((group) => group.status === 'ready');
        if (ready !== undefined) models = ready;
      }
      if (models === null) await new Promise((r) => setTimeout(r, 500));
    }
    check(
      'the container reaches a provider on the host',
      models !== null && models.models.length > 0,
      'the provider stayed unavailable; is host.docker.internal mapped?'
    );

    heading('Running a generation');
    const conversation = await (
      await api.call('/api/conversations', { method: 'POST', body: JSON.stringify({}) })
    ).json();

    const started = await api.call('/api/generations', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: conversation.id,
        providerId: models?.providerId ?? 'local',
        model: models?.models[0]?.id ?? 'Mock Model',
        content: 'hello from the acceptance run',
      }),
    });
    check('a generation is accepted', started.status === 202, `got ${started.status}`);
    const { generationId } = await started.json();

    let stored = null;
    for (let attempt = 0; attempt < 60 && stored === null; attempt += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const detail = await (await api.call(`/api/conversations/${conversation.id}`)).json();
      const reply = detail.messages?.find((m) => m.type === 'assistant' && m.status === 'complete');
      if (reply !== undefined) stored = reply;
    }
    check(
      'the reply is generated and stored',
      stored !== null && stored.body.includes('Hello from the container'),
      stored === null ? `generation ${generationId} never completed` : stored.body
    );

    heading('Recreating the container');
    compose(['down'], { env });
    compose(['up', '-d'], { env });
    check('it comes back healthy', await waitForHealth(baseUrl));

    api.forget();
    check('the account survived', await api.signIn());
    const afterRecreate = await (await api.call(`/api/conversations/${conversation.id}`)).json();
    check(
      'the conversation survived',
      afterRecreate.messages?.some((m) => m.body?.includes('Hello from the container')),
      JSON.stringify(afterRecreate).slice(0, 200)
    );

    heading('Upgrading the image');
    // What an upgrade is: a new image under the same volume.
    compose(['up', '-d', '--build', '--force-recreate'], { env });
    check('it comes back healthy after a rebuild', await waitForHealth(baseUrl));
    api.forget();
    check('the account survived the upgrade', await api.signIn());
    const afterUpgrade = await (await api.call(`/api/conversations/${conversation.id}`)).json();
    check(
      'the conversation survived the upgrade',
      afterUpgrade.messages?.some((m) => m.body?.includes('Hello from the container'))
    );

    heading('Health and shutdown');
    let health = healthStatus();
    for (let attempt = 0; attempt < 60 && health !== 'healthy'; attempt += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      health = healthStatus();
    }
    check('the engine reports the container healthy', health === 'healthy', health);

    const before = Date.now();
    compose(['stop', '-t', '30'], { env });
    const took = Date.now() - before;
    const id = compose(['ps', '-a', '-q', 'app']).stdout.trim().split('\n')[0];
    const exit = spawnSync(ENGINE, ['inspect', '-f', '{{.State.ExitCode}}', id], {
      encoding: 'utf8',
    }).stdout.trim();
    check('it stops promptly rather than being killed', took < 15_000, `took ${took}ms`);
    check('it exits cleanly on SIGTERM', exit === '0', `exit code ${exit}`);

    heading('Backup and restore');
    compose(['up', '-d'], { env });
    await waitForHealth(baseUrl);

    const archive = compose(['run', '--rm', '-T', 'app', 'backup'], {
      env,
      // The archive is bytes on stdout; keep it out of the string encoding.
      encoding: 'buffer',
    });
    const { writeFileSync, statSync } = await import('node:fs');
    writeFileSync(backupFile, archive.stdout);
    check(
      'backup writes an archive',
      statSync(backupFile).size > 1024,
      `${statSync(backupFile).size} bytes`
    );

    // The disaster: the volume is gone.
    compose(['down', '-v'], { env });
    const restored = compose(['run', '--rm', '-T', 'app', 'restore'], {
      env,
      input: archive.stdout,
      allowFailure: true,
    });
    check('restore unpacks into an empty volume', restored.status === 0, restored.stderr);

    compose(['up', '-d'], { env });
    check('it comes up on the restored volume', await waitForHealth(baseUrl));
    api.forget();
    check('the account came back', await api.signIn());
    const afterRestore = await (await api.call(`/api/conversations/${conversation.id}`)).json();
    check(
      'the conversation came back',
      afterRestore.messages?.some((m) => m.body?.includes('Hello from the container'))
    );

    // And it refuses to merge into a deployment that already has data.
    const refused = compose(['run', '--rm', '-T', 'app', 'restore'], {
      env,
      input: archive.stdout,
      allowFailure: true,
    });
    check(
      'restore refuses a volume that is not empty',
      refused.status !== 0 && /not empty/.test(refused.stderr ?? ''),
      refused.stderr
    );
  } finally {
    compose(['down', '-v', '--remove-orphans'], { allowFailure: true, env });
    provider.close();
    await rm(backupDir, { recursive: true, force: true });
  }

  console.log(
    failures === 0
      ? '\ncompose-verify: all checks passed.'
      : `\ncompose-verify: ${failures} check(s) failed.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
