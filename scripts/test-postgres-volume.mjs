import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const name = `order-pad-volume-test-${randomUUID()}`;
const volume = `${name}-data`;
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr || `docker ${args[0]} failed`);
  return result.stdout.trim();
}
async function start() {
  docker([
    'run',
    '--detach',
    '--name',
    name,
    '--env',
    'POSTGRES_PASSWORD=volume_test_only',
    '--volume',
    `${volume}:/var/lib/postgresql`,
    'postgres:18',
  ]);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = spawnSync(
      'docker',
      ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
      { stdio: 'ignore' },
    );
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Postgres did not become ready.');
}
function sql(query) {
  return docker([
    'exec',
    name,
    'psql',
    '-U',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-Atc',
    query,
  ]);
}
try {
  docker(['volume', 'create', volume]);
  await start();
  assert.match(sql('SHOW data_directory'), /\/18\/docker$/);
  sql(
    "CREATE TABLE volume_probe (value text); INSERT INTO volume_probe VALUES ('persisted');",
  );
  docker(['stop', name]);
  docker(['rm', name]);
  await start();
  assert.equal(sql('SELECT value FROM volume_probe'), 'persisted');
  console.log(
    'PostgreSQL 18 named-volume persistence passed after container recreation.',
  );
} finally {
  spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
}
