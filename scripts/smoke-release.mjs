// Unpacks a release tarball, migrates DATABASE_URL with its own Prisma and starts its server in
// PDF mode, proving the package runs without the checkout's node_modules.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [tarball, font] = process.argv.slice(2);
if (!tarball || !font || !process.env.DATABASE_URL)
  throw new Error(
    'Usage: DATABASE_URL=… node scripts/smoke-release.mjs <tarball> <ttf font>',
  );
const dir = await mkdtemp(join(tmpdir(), 'order-pad-smoke-'));
const root = join(dir, 'release');
const port = '4199';
const env = {
  PATH: '/usr/bin:/bin',
  DATABASE_URL: process.env.DATABASE_URL,
  ORDER_PAD_PRINT_MODE: 'pdf',
  ORDER_PAD_PDF_DIR: join(dir, 'pdfs'),
  ORDER_PAD_FONT: resolve(font),
  ORDER_PAD_ORIGIN: `http://127.0.0.1:${port}`,
  ORDER_PAD_PORT: port,
  ORDER_PAD_CAPTURE_FROM: '2026-01-01T00:00:00.000Z',
  ORDER_PAD_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  ORDER_PAD_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  CHECKPOINT_DISABLE: '1',
};
let server;
try {
  execFileSync('mkdir', ['-p', root, env.ORDER_PAD_PDF_DIR]);
  execFileSync('tar', [
    '--extract',
    '--gzip',
    '--strip-components=1',
    '--file',
    resolve(tarball),
    '--directory',
    root,
  ]);
  const node = join(root, 'node', 'bin', 'node');
  execFileSync(
    node,
    [join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { cwd: root, env, stdio: 'inherit' },
  );
  server = spawn(node, ['build-printer/server.mjs'], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  const exited = new Promise((done) => server.once('exit', done));
  for (let tries = 0; ; tries++) {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/auth/config`,
    ).catch(() => undefined);
    if (response?.ok) break;
    if (tries >= 60 || server.exitCode !== null)
      throw new Error('The packaged server did not answer within 60 seconds.');
    await new Promise((done) => setTimeout(done, 1000));
  }
  // The updater bundle must load from the package; without a command it prints usage.
  const ops = spawnSync(node, [join(root, 'build-printer/ops.mjs')], { env });
  if (!ops.stderr.toString().startsWith('Usage: order-pad-ops'))
    throw new Error(`ops.mjs did not load: ${ops.stderr}`);
  server.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((_, fail) =>
      setTimeout(() => fail(new Error('The server did not stop.')), 10000),
    ),
  ]);
  console.log('The packaged release migrated, started, answered and stopped.');
} finally {
  server?.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
}
