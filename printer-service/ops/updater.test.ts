import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bundleName, tarballName } from './releases';
import { Updater, type Host, type Paths, type RunOptions } from './updater';

let dir: string;
let paths: Paths;
const inWindow = new Date('2026-10-20T02:10:00Z');

async function release(tag: string, migrations: string[], manual = '') {
  const root = join(paths.root, 'releases', tag);
  for (const name of migrations)
    await mkdir(join(root, 'prisma', 'migrations', name), { recursive: true });
  await mkdir(join(root, 'deploy'), { recursive: true });
  await writeFile(join(root, 'deploy', 'manual-migrations'), manual);
  await writeFile(
    join(root, 'release.json'),
    JSON.stringify({
      schema: 1,
      tag,
      commit: 'c'.repeat(40),
      node: 'v24.22.0',
      arch: 'linux-x64',
    }),
  );
}

function host(overrides: Partial<Host> = {}) {
  const logs: string[] = [];
  const calls: [string, string[], RunOptions | undefined][] = [];
  const fake: Host = {
    now: () => inWindow,
    sleep: async () => {},
    log: (message) => logs.push(message),
    fetch: vi.fn<typeof fetch>(async () => new Response('[]')),
    run: vi.fn(
      async (program: string, args: string[], options?: RunOptions) => {
        calls.push([program, args, options]);
        if (program === 'sh')
          await writeFile(options!.stdout!, 'PGDMP-archive');
        if (program === 'systemctl' && args[0] === 'show') return '0\n';
        if (program === 'systemctl' && args[0] === 'is-active')
          return 'active\n';
        return '';
      },
    ),
    activity: async () => 'quiet',
    appliedMigrations: async () => ['20260101000000_first'],
    probe: async () => true,
    ...overrides,
  };
  return { fake, logs, calls };
}
const ran = (calls: [string, string[], RunOptions | undefined][]) =>
  calls.map(([program, args]) => [program, ...args.slice(0, 1)].join(' '));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'order-pad-updater-'));
  paths = {
    root: join(dir, 'opt'),
    state: join(dir, 'state'),
    backups: join(dir, 'backups'),
    config: join(dir, 'updater.conf'),
    env: join(dir, 'order-pad.env'),
    units: join(dir, 'units'),
  };
  await writeFile(
    paths.config,
    'WINDOW=02:00-05:00\nTIME_ZONE=UTC\nBACKUP_COMMAND=docker exec pg pg_dump -Fc\nBACKUP_KEEP=2\n',
  );
  await writeFile(
    paths.env,
    'DATABASE_URL=postgresql://u:p@127.0.0.1:5432/order_pad\nORDER_PAD_QUEUE=Star_TSP143\n',
  );
  await release('v0.1.0', ['20260101000000_first']);
  await release('v0.2.0', ['20260101000000_first']);
  await release('v0.3.0', ['20260101000000_first', '20260201000000_second']);
  await symlink(join('releases', 'v0.2.0'), join(paths.root, 'current'));
  await mkdir(paths.state, { recursive: true });
  await writeFile(
    join(paths.state, 'state.json'),
    JSON.stringify({ previous: 'v0.1.0', failed: [] }),
  );
});
afterEach(() => rm(dir, { recursive: true, force: true }));

it('waits for quiet, backs up, migrates, switches and keeps the previous release', async () => {
  const { fake, calls, logs } = host();
  expect(await new Updater(fake, paths).apply('v0.3.0')).toBe('applied');
  expect(ran(calls)).toEqual([
    'lpstat -h',
    'lpstat -h',
    'systemctl stop',
    'sh -c',
    `${join(paths.root, 'releases', 'v0.3.0', 'node', 'bin', 'node')} ${join(paths.root, 'releases', 'v0.3.0', 'node_modules', 'prisma', 'build', 'index.js')}`,
    'systemctl restart',
    'systemctl show',
    'systemctl show',
    'systemctl is-active',
  ]);
  const migrate = calls[4][2]!;
  expect(migrate.env).toMatchObject({
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/order_pad',
    CHECKPOINT_DISABLE: '1',
  });
  expect(migrate.cwd).toBe(join(paths.root, 'releases', 'v0.3.0'));
  expect(await readlink(join(paths.root, 'current'))).toBe(
    join('releases', 'v0.3.0'),
  );
  expect(await readdir(join(paths.root, 'releases'))).toEqual([
    'v0.2.0',
    'v0.3.0',
  ]);
  expect(
    JSON.parse(await readFile(join(paths.state, 'state.json'), 'utf8'))
      .previous,
  ).toBe('v0.2.0');
  const [dump] = await readdir(paths.backups);
  expect(dump).toBe('20261020T021000Z_v0.2.0_v0.3.0.dump');
  expect(logs.at(-1)).toBe('Installed v0.3.0.');
});

it('says when a release ships systemd units that differ from the installed ones', async () => {
  const shipped = join(paths.root, 'releases', 'v0.3.0', 'deploy', 'systemd');
  await mkdir(shipped, { recursive: true });
  await writeFile(
    join(shipped, 'order-pad.service'),
    '[Service]\nTimeoutStopSec=90\n',
  );
  const { fake, logs } = host();
  await new Updater(fake, paths).apply('v0.3.0');
  expect(logs.at(-1)).toContain('ships a different order-pad.service');
});

it('changes nothing while staff are working or a CUPS job is pending', async () => {
  let n = 0;
  const busy = host({ activity: async () => `revision ${n++}` });
  expect(await new Updater(busy.fake, paths).apply('v0.3.0')).toBe('busy');
  const queued = host();
  vi.mocked(queued.fake.run).mockImplementation(async (program) =>
    program === 'lpstat' ? 'Star_TSP143-9 root 1024 now\n' : '',
  );
  expect(await new Updater(queued.fake, paths).apply('v0.3.0')).toBe('busy');
  for (const { calls } of [busy, queued])
    expect(ran(calls).filter((c) => !c.startsWith('lpstat'))).toEqual([]);
  expect(await readlink(join(paths.root, 'current'))).toBe(
    join('releases', 'v0.2.0'),
  );
});

it('waits outside the window and holds migrations that need a person', async () => {
  const late = host({ now: () => new Date('2026-10-20T04:45:00Z') });
  expect(await new Updater(late.fake, paths).apply('v0.3.0')).toBe(
    'outside-window',
  );
  await writeFile(
    join(paths.root, 'releases', 'v0.3.0', 'deploy', 'manual-migrations'),
    '# Voids every session\n20260201000000_second\n',
  );
  const held = host();
  expect(await new Updater(held.fake, paths).apply('v0.3.0')).toBe('manual');
  expect(held.calls).toEqual([]);
  expect(held.logs[0]).toContain('--allow-manual-migrations');
  const allowed = host();
  expect(
    await new Updater(allowed.fake, paths).apply('v0.3.0', {
      allowManual: true,
    }),
  ).toBe('applied');
});

it('restarts the running release when the backup fails', async () => {
  const { fake, calls } = host();
  vi.mocked(fake.run).mockImplementation(async (program, args, options) => {
    calls.push([program, args, options]);
    if (program === 'sh') await writeFile(options!.stdout!, 'not a dump');
    return '';
  });
  await expect(new Updater(fake, paths).apply('v0.3.0')).rejects.toThrow(
    'backup failed, so nothing was installed',
  );
  expect(ran(calls).slice(-2)).toEqual(['sh -c', 'systemctl start']);
  expect(await readdir(paths.backups)).toEqual([]);
  expect(await readlink(join(paths.root, 'current'))).toBe(
    join('releases', 'v0.2.0'),
  );
});

it('blocks further updates when a migration fails', async () => {
  const { fake, calls } = host();
  vi.mocked(fake.run).mockImplementation(async (program, args, options) => {
    calls.push([program, args, options]);
    if (program === 'sh') await writeFile(options!.stdout!, 'PGDMP');
    if (args[1] === 'migrate') throw new Error('P3018');
    return '';
  });
  const updater = new Updater(fake, paths);
  await expect(updater.apply('v0.3.0')).rejects.toThrow('updates are blocked');
  expect(ran(calls).at(-1)).toBe('systemctl start');
  expect(await updater.blocked()).toContain('P3018');
  await expect(updater.apply('v0.3.0')).rejects.toThrow(
    'order-pad-ops unblock',
  );
  expect(await readlink(join(paths.root, 'current'))).toBe(
    join('releases', 'v0.2.0'),
  );
});

it('returns to the previous release when the new one fails its health check', async () => {
  let checks = 0;
  const { fake, logs } = host({ probe: async () => checks++ >= 30 });
  await expect(new Updater(fake, paths).apply('v0.3.0')).rejects.toThrow(
    'v0.2.0 is running again',
  );
  expect(logs).toContain(
    'v0.3.0 did not pass its health check; returning to v0.2.0.',
  );
  expect(await readlink(join(paths.root, 'current'))).toBe(
    join('releases', 'v0.2.0'),
  );
  expect(
    JSON.parse(await readFile(join(paths.state, 'state.json'), 'utf8')).failed,
  ).toEqual(['v0.3.0']);
  const down = host({ probe: async () => false });
  await expect(new Updater(down.fake, paths).apply('v0.3.0')).rejects.toThrow(
    'Neither v0.3.0 nor v0.2.0 started',
  );
  expect(await new Updater(down.fake, paths).blocked()).toContain('Neither');
});

it('verifies, stages and hands off to the new release inside the window', async () => {
  await rm(join(paths.root, 'releases', 'v0.3.0'), { recursive: true });
  const tarball = 'release tarball';
  const sum = createHash('sha256').update(tarball).digest('hex');
  const url = (name: string) =>
    `https://github.com/castab/event-order-pad/releases/download/v0.3.0/${name}`;
  const assets: Record<string, string> = {
    [tarballName('v0.3.0')]: tarball,
    SHA256SUMS: `${sum}  ${tarballName('v0.3.0')}\n`,
    [bundleName('v0.3.0')]: '{}',
  };
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = String(input);
    if (target.startsWith('https://api.github.com/'))
      return new Response(
        JSON.stringify([
          {
            tag_name: 'v0.3.0',
            draft: false,
            prerelease: false,
            assets: Object.keys(assets).map((name) => ({
              name,
              browser_download_url: url(name),
              size: 1,
            })),
          },
        ]),
        { headers: { ETag: '"abc"' } },
      );
    const name = target.split('/').at(-1)!;
    return new Response(assets[name]);
  });
  const { fake, calls } = host({ fetch: fetcher });
  vi.mocked(fake.run).mockImplementation(async (program, args, options) => {
    calls.push([program, args, options]);
    if (program === 'tar')
      await writeFile(
        join(args[args.indexOf('--directory') + 1], 'release.json'),
        JSON.stringify({
          schema: 1,
          tag: 'v0.3.0',
          commit: 'c'.repeat(40),
          node: 'v24.22.0',
          arch: 'linux-x64',
        }),
      );
    return '';
  });
  const updater = new Updater(fake, paths);
  expect(await updater.update()).toBe('applied');
  const cosign = calls.find(([program]) => program === 'cosign')![1];
  expect(cosign).toContain(
    '^https://github\\.com/castab/event-order-pad/\\.github/workflows/release\\.yml@refs/tags/v0\\.3\\.0$',
  );
  // cosign cannot read a blob over 128 MiB, so the attestation is checked by digest.
  expect(cosign.slice(-4)).toEqual(['--digest', sum, '--digestAlg', 'sha256']);
  const handoff = calls.at(-1)!;
  expect(handoff[0]).toBe(
    join(paths.root, 'releases', 'v0.3.0', 'node', 'bin', 'node'),
  );
  expect(handoff[1].slice(1)).toEqual(['apply', 'v0.3.0']);
  expect(await readdir(join(paths.root, 'releases'))).toContain('v0.3.0');
  expect(await readdir(join(paths.state, 'downloads'))).toEqual([]);

  // A second tick reuses the cached list and the staged release.
  vi.mocked(fetcher).mockClear();
  vi.mocked(fetcher).mockResolvedValueOnce(new Response(null, { status: 304 }));
  await updater.update();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    new Headers(fetcher.mock.calls[0][1]?.headers).get('If-None-Match'),
  ).toBe('"abc"');

  // A tampered tarball is never unpacked.
  await rm(join(paths.root, 'releases', 'v0.3.0'), { recursive: true });
  assets[tarballName('v0.3.0')] = 'tampered';
  calls.length = 0;
  vi.mocked(fetcher).mockImplementation(async (input) =>
    String(input).startsWith('https://api.github.com/')
      ? new Response(null, { status: 304 })
      : new Response(assets[String(input).split('/').at(-1)!]),
  );
  await expect(updater.update()).rejects.toThrow('does not match SHA256SUMS');
  expect(calls).toEqual([]);
});

it('does not touch the network outside the window', async () => {
  const { fake } = host({ now: () => new Date('2026-10-20T12:00:00Z') });
  expect(await new Updater(fake, paths).update()).toBe('outside-window');
  expect(fake.fetch).not.toHaveBeenCalled();
});
