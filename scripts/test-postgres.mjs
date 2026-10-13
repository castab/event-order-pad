import { spawnSync } from 'node:child_process';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) {
  throw new Error(
    'Set TEST_DATABASE_URL to a separate disposable test database.',
  );
}
const env = { ...process.env, DATABASE_URL: url };
for (const args of [
  ['prisma', 'generate'],
  ['prisma', 'migrate', 'deploy'],
  ['vitest', 'run', '--config', 'vitest.postgres.config.ts'],
]) {
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args,
    { env, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
