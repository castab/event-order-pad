import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { systemHost } from './system';

it('runs commands, writes standard output to a new file and reports failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'order-pad-system-'));
  try {
    expect(
      await systemHost.run('sh', ['-c', 'printf "$GREETING"'], {
        env: { GREETING: 'hi' },
      }),
    ).toBe('hi');
    const file = join(dir, 'backup.dump');
    await systemHost.run('sh', ['-c', 'printf PGDMP'], { stdout: file });
    expect(await readFile(file, 'utf8')).toBe('PGDMP');
    // Never overwrites an existing backup.
    await expect(
      systemHost.run('true', [], { stdout: file }),
    ).rejects.toThrow();
    await expect(
      systemHost.run('sh', ['-c', 'echo disk full >&2; exit 3']),
    ).rejects.toThrow('sh exited with 3: disk full');
    await expect(
      systemHost.run('sleep', ['5'], { timeoutMs: 50 }),
    ).rejects.toThrow('timed out');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('probes the public auth config on loopback with the Host and tunnel headers', async () => {
  const seen: Record<string, string | string[] | undefined>[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, ...req.headers });
    res.writeHead(req.headers['cf-connecting-ip'] ? 200 : 403).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    expect(await systemHost.probe(port)).toBe(true);
    expect(seen[0]).toMatchObject({
      url: '/api/auth/config',
      host: `127.0.0.1:${port}`,
      'cf-connecting-ip': '127.0.0.1',
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  expect(await systemHost.probe(port)).toBe(false);
});
