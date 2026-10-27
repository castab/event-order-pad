// Packages build/ and build-printer/ with production dependencies and a pinned Node runtime,
// so a station needs neither npm nor a Node install. Run after `npm run build` and `build:printer`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The tag is the release's version (release.json); package.json's version is not used.
const tag = process.argv[2];
if (!/^v\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.]{1,40})?$/.test(tag ?? ''))
  throw new Error(
    `Usage: npm run package:release -- vX.Y.Z (got ${tag ?? 'nothing'}).`,
  );
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('Package on linux-x64 so native modules match stations.');
const node = (await readFile('.node-version', 'utf8')).trim();
if (!/^v24\.\d+\.\d+$/.test(node))
  throw new Error('.node-version must name a Node 24 release, like v24.21.0.');

const name = `order-pad-${tag}-linux-x64`;
const dist = 'dist';
const stage = join(dist, name);
const run = (program, args, options = {}) =>
  execFileSync(program, args, { stdio: 'inherit', ...options });
await rm(dist, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const path of [
  'build',
  'build-printer',
  'deploy',
  '.env.example',
  'prisma/schema.prisma',
  'prisma/migrations',
  'prisma.config.ts',
  'package.json',
  'package-lock.json',
])
  await cp(path, join(stage, path), { recursive: true });
// Install scripts stay on: Prisma's engines package fetches the migration engine for this platform.
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage });
// Stations need OpenSSL 3 (Ubuntu 22.04, Mint 21, Debian 12 or later) for this engine.
await readFile(
  join(
    stage,
    'node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x',
  ),
).catch(() => {
  throw new Error('npm did not install the Prisma migration engine.');
});

const archive = `node-${node}-linux-x64`;
const base = `https://nodejs.org/dist/${node}`;
const download = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
};
const tarball = await download(`${base}/${archive}.tar.xz`);
const sums = (await download(`${base}/SHASUMS256.txt`)).toString();
const expected = sums
  .split('\n')
  .find((line) => line.endsWith(`  ${archive}.tar.xz`))
  ?.split(' ')[0];
if (createHash('sha256').update(tarball).digest('hex') !== expected)
  throw new Error(`${archive}.tar.xz does not match SHASUMS256.txt.`);
await mkdir(join(stage, 'node'));
execFileSync(
  'tar',
  [
    '--extract',
    '--xz',
    '--strip-components=1',
    '--directory',
    join(stage, 'node'),
    `${archive}/bin/node`,
    `${archive}/LICENSE`,
  ],
  { input: tarball },
);

const commit = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
await writeFile(
  join(stage, 'release.json'),
  JSON.stringify({ schema: 1, tag, commit, node, arch: 'linux-x64' }, null, 2) +
    '\n',
);
const epoch = execFileSync('git', ['log', '-1', '--format=%ct'])
  .toString()
  .trim();
run('tar', [
  '--create',
  '--sort=name',
  '--owner=0',
  '--group=0',
  '--numeric-owner',
  `--mtime=@${epoch}`,
  '--use-compress-program=gzip -n',
  '--file',
  join(dist, `${name}.tar.gz`),
  '--directory',
  dist,
  name,
]);
const digest = createHash('sha256')
  .update(await readFile(join(dist, `${name}.tar.gz`)))
  .digest('hex');
await writeFile(join(dist, 'SHA256SUMS'), `${digest}  ${name}.tar.gz\n`);
console.log(`Packaged ${name}.tar.gz (${digest}).`);
