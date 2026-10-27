import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { parseEnv } from 'node:util';
import {
  parseUpdaterConfig,
  TAG,
  windowMinutesLeft,
  type UpdaterConfig,
} from './config';
import {
  bundleName,
  chooseRelease,
  compareTags,
  parseChecksums,
  parseManifest,
  parseReleases,
  tarballName,
  type Release,
} from './releases';

export interface Paths {
  readonly root: string;
  readonly state: string;
  readonly backups: string;
  readonly config: string;
  readonly env: string;
  readonly units: string;
}
export const stationPaths: Paths = Object.freeze({
  root: '/opt/order-pad',
  state: '/var/lib/order-pad/updater',
  backups: '/var/backups/order-pad',
  config: '/etc/order-pad/updater.conf',
  env: '/etc/order-pad/order-pad.env',
  units: '/etc/systemd/system',
});
export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  /** Write standard output to this new file instead of returning it. */
  readonly stdout?: string;
  /** Stream output to the journal instead of returning it. */
  readonly inherit?: boolean;
  readonly timeoutMs?: number;
}
export interface Host {
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  fetch: typeof fetch;
  run(program: string, args: string[], options?: RunOptions): Promise<string>;
  activity(databaseUrl: string): Promise<string>;
  appliedMigrations(databaseUrl: string): Promise<string[]>;
  probe(port: number): Promise<boolean>;
}
interface State {
  previous?: string;
  failed: string[];
  cache?: { repo: string; etag: string; releases: Release[] };
}
export type Outcome =
  'outside-window' | 'up-to-date' | 'staged' | 'manual' | 'busy' | 'applied';

const SERVICE = 'order-pad.service';
const MINUTE = 60000;
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';
const regexp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Installs verified releases inside the station's window, only after the station has been
 * idle, with a database backup first. A failed start returns to the previous release; the
 * backup is never restored automatically and a print is never resent.
 */
export class Updater {
  constructor(
    private host: Host,
    private paths: Paths = stationPaths,
  ) {}
  private get releases() {
    return join(this.paths.root, 'releases');
  }
  private get current() {
    return join(this.paths.root, 'current');
  }
  private get blockFile() {
    return join(this.paths.state, 'BLOCKED');
  }
  private release(tag: string, ...path: string[]) {
    return join(this.releases, tag, ...path);
  }

  async config(): Promise<UpdaterConfig> {
    return parseUpdaterConfig(await readFile(this.paths.config, 'utf8'));
  }
  private async appEnv(): Promise<Record<string, string>> {
    const env = parseEnv(await readFile(this.paths.env, 'utf8')) as Record<
      string,
      string
    >;
    if (!env.DATABASE_URL)
      throw new Error(`${this.paths.env} does not set DATABASE_URL.`);
    return env;
  }
  async installed(): Promise<string | undefined> {
    try {
      return basename(await readlink(this.current));
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  private async state(): Promise<State> {
    try {
      const value = JSON.parse(
        await readFile(join(this.paths.state, 'state.json'), 'utf8'),
      );
      return {
        previous: TAG.test(value?.previous) ? value.previous : undefined,
        failed: Array.isArray(value?.failed)
          ? value.failed.filter((tag: unknown) => TAG.test(String(tag)))
          : [],
        cache: value?.cache?.etag
          ? {
              repo: String(value.cache.repo),
              etag: String(value.cache.etag),
              releases: parseReleases(
                (value.cache.releases ?? []).map((r: Release) => ({
                  tag_name: r.tag,
                  draft: false,
                  prerelease: r.prerelease,
                  assets: r.assets.map((a) => ({
                    name: a.name,
                    browser_download_url: a.url,
                    size: a.size,
                  })),
                })),
              ),
            }
          : undefined,
      };
    } catch (error) {
      if (missing(error)) return { failed: [] };
      throw error;
    }
  }
  private async save(state: State) {
    await mkdir(this.paths.state, { recursive: true, mode: 0o755 });
    const file = join(this.paths.state, 'state.json');
    await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n');
    await rename(`${file}.tmp`, file);
  }
  async blocked(): Promise<string | undefined> {
    try {
      return (await readFile(this.blockFile, 'utf8')).trim();
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  private async block(reason: string) {
    await mkdir(this.paths.state, { recursive: true, mode: 0o755 });
    await writeFile(this.blockFile, reason + '\n');
    this.host.log(`BLOCKED: ${reason}`);
  }
  async unblock() {
    await rm(this.blockFile, { force: true });
    this.host.log('Automatic updates may run again.');
  }
  private async assertUnblocked() {
    const reason = await this.blocked();
    if (reason)
      throw new Error(
        `Updates are blocked: ${reason} Fix the station, then run order-pad-ops unblock.`,
      );
  }
  private windowLeft(config: UpdaterConfig) {
    return windowMinutesLeft(config.window, config.timeZone, this.host.now());
  }

  /** Timer entry point: discover, verify and stage, then hand off to the new release. */
  async update({ now = false, dryRun = false } = {}): Promise<Outcome> {
    await this.assertUnblocked();
    const config = await this.config();
    if (
      !now &&
      this.windowLeft(config) < config.quietMinutes + config.minWindowLeft
    )
      return 'outside-window';
    const current = await this.installed();
    if (!current)
      throw new Error('No release is installed. Run install-station.sh first.');
    const state = await this.state();
    const release = chooseRelease(
      await this.discover(config, state),
      current,
      config,
      state.failed,
    );
    if (!release) {
      this.host.log(`Up to date at ${current}.`);
      return 'up-to-date';
    }
    if (dryRun) {
      this.host.log(`Would install ${release.tag} over ${current}.`);
      return 'up-to-date';
    }
    await this.stage(release, config);
    if (!config.autoApply) {
      this.host.log(
        `${release.tag} is staged. Install it with: order-pad-ops apply ${release.tag}`,
      );
      return 'staged';
    }
    // The new release applies itself, so a fix to this step ships with the release that needs it.
    await this.host.run(
      this.release(release.tag, 'node', 'bin', 'node'),
      [
        this.release(release.tag, 'build-printer', 'ops.mjs'),
        'apply',
        release.tag,
        ...(now ? ['--now'] : []),
      ],
      { inherit: true, timeoutMs: 180 * MINUTE },
    );
    return 'applied';
  }

  private async discover(
    config: UpdaterConfig,
    state: State,
  ): Promise<Release[]> {
    const cached = state.cache?.repo === config.repo ? state.cache : undefined;
    const response = await this.host.fetch(
      `https://api.github.com/repos/${config.repo}/releases?per_page=30`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'order-pad-updater',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(cached ? { 'If-None-Match': cached.etag } : {}),
        },
        signal: AbortSignal.timeout(30000),
      },
    );
    if (response.status === 304 && cached) return cached.releases;
    if (!response.ok)
      throw new Error(`GitHub answered ${response.status} for the releases.`);
    const releases = parseReleases(await response.json());
    const etag = response.headers.get('etag');
    state.cache = etag ? { repo: config.repo, etag, releases } : undefined;
    await this.save(state);
    return releases;
  }

  private async download(release: Release, name: string, file: string) {
    const asset = release.assets.find((a) => a.name === name);
    if (!asset) throw new Error(`${release.tag} has no ${name}.`);
    const response = await this.host.fetch(asset.url, {
      headers: { 'User-Agent': 'order-pad-updater' },
      signal: AbortSignal.timeout(30 * MINUTE),
    });
    if (!response.ok || !response.body)
      throw new Error(`Downloading ${name} failed with ${response.status}.`);
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream),
      createWriteStream(file, { mode: 0o644 }),
    );
    return file;
  }

  /** Verifies the download against its checksum and build provenance before unpacking it. */
  private async stage(release: Release, config: UpdaterConfig) {
    const { tag } = release;
    try {
      parseManifest(
        JSON.parse(await readFile(this.release(tag, 'release.json'), 'utf8')),
        tag,
      );
      return;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const downloads = join(this.paths.state, 'downloads', tag);
    await rm(downloads, { recursive: true, force: true });
    await mkdir(downloads, { recursive: true, mode: 0o755 });
    const tarball = await this.download(
      release,
      tarballName(tag),
      join(downloads, tarballName(tag)),
    );
    const sums = parseChecksums(
      await readFile(
        await this.download(
          release,
          'SHA256SUMS',
          join(downloads, 'SHA256SUMS'),
        ),
        'utf8',
      ),
    );
    const digest = createHash('sha256');
    await pipeline(createReadStream(tarball), digest);
    if (sums.get(tarballName(tag)) !== digest.digest('hex'))
      throw new Error(`${tarballName(tag)} does not match SHA256SUMS.`);
    if (config.verify === 'sigstore')
      await this.host.run('cosign', [
        'verify-blob-attestation',
        '--bundle',
        await this.download(
          release,
          bundleName(tag),
          join(downloads, bundleName(tag)),
        ),
        '--type',
        'slsaprovenance1',
        '--certificate-oidc-issuer',
        'https://token.actions.githubusercontent.com',
        '--certificate-identity-regexp',
        `^${regexp(`https://github.com/${config.repo}/.github/workflows/release.yml@refs/tags/${tag}`)}$`,
        tarball,
      ]);
    const partial = `${this.release(tag)}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true, mode: 0o755 });
    await this.host.run('tar', [
      '--extract',
      '--gzip',
      '--no-same-owner',
      '--strip-components=1',
      '--file',
      tarball,
      '--directory',
      partial,
    ]);
    parseManifest(
      JSON.parse(await readFile(join(partial, 'release.json'), 'utf8')),
      tag,
    );
    await rename(partial, this.release(tag));
    await rm(downloads, { recursive: true, force: true });
    this.host.log(
      `Verified ${tag} (${config.verify === 'sigstore' ? 'checksum and build provenance' : 'checksum only'}) and staged it.`,
    );
  }

  /** Runs from the release being installed. */
  async apply(
    tag: string,
    { now = false, initial = false, allowManual = false } = {},
  ): Promise<Outcome> {
    if (!TAG.test(tag)) throw new Error(`Not a release tag: ${tag}`);
    await this.assertUnblocked();
    const config = await this.config();
    const env = await this.appEnv();
    if (
      !now &&
      !initial &&
      this.windowLeft(config) < config.quietMinutes + config.minWindowLeft
    ) {
      this.host.log(`Outside the update window; ${tag} stays staged.`);
      return 'outside-window';
    }
    parseManifest(
      JSON.parse(await readFile(this.release(tag, 'release.json'), 'utf8')),
      tag,
    );
    const current = await this.installed();
    if (initial && current)
      throw new Error(`${current} is already installed; omit --initial.`);
    if (!initial && !current)
      throw new Error('No release is installed; use --initial the first time.');
    if (current === tag) {
      this.host.log(`${tag} is already installed.`);
      return 'up-to-date';
    }
    const applied = new Set(
      await this.host.appliedMigrations(env.DATABASE_URL),
    );
    const pending = (
      await readdir(this.release(tag, 'prisma', 'migrations'), {
        withFileTypes: true,
      })
    )
      .filter((entry) => entry.isDirectory() && !applied.has(entry.name))
      .map((entry) => entry.name);
    if (!initial && !allowManual) {
      const manual = await this.manualMigrations(tag);
      const held = pending.filter((name) => manual.includes(name));
      if (held.length) {
        this.host.log(
          `${tag} has migrations that need a person: ${held.join(', ')}. Read its release notes, then run: order-pad-ops apply ${tag} --allow-manual-migrations`,
        );
        return 'manual';
      }
    }
    if (!initial) {
      const quiet = await this.idle(config, env);
      if (quiet === undefined) return 'busy';
      this.host.log(`Stopping the service to install ${tag}.`);
      await this.host.run('systemctl', ['stop', SERVICE]);
      if ((await this.host.activity(env.DATABASE_URL)) !== quiet)
        this.host.log(
          'Warning: the station changed while it stopped. An interrupted print is recorded as outcome unknown and is never resent.',
        );
    }
    try {
      await this.backup(config, env, current, tag);
    } catch (error) {
      if (!initial) await this.host.run('systemctl', ['start', SERVICE]);
      throw error;
    }
    if (pending.length)
      try {
        this.host.log(`Applying migrations: ${pending.join(', ')}.`);
        await this.host.run(
          this.release(tag, 'node', 'bin', 'node'),
          [
            this.release(tag, 'node_modules', 'prisma', 'build', 'index.js'),
            'migrate',
            'deploy',
          ],
          {
            cwd: this.release(tag),
            env: { ...env, CHECKPOINT_DISABLE: '1' },
            inherit: true,
            timeoutMs: 30 * MINUTE,
          },
        );
      } catch (error) {
        await this.block(
          `Migrating to ${tag} failed (${(error as Error).message}). Check _prisma_migrations and the latest backup in ${this.paths.backups} before retrying.`,
        );
        if (!initial)
          await this.host.run('systemctl', ['start', SERVICE]).catch(() => '');
        throw new Error(`Migrating to ${tag} failed; updates are blocked.`);
      }
    await this.point(tag);
    const port = Number(env.ORDER_PAD_PORT ?? '4174');
    await this.host.run('systemctl', ['restart', SERVICE]);
    const state = await this.state();
    if (await this.healthy(port)) {
      state.previous = current;
      state.failed = state.failed.filter((failed) => failed !== tag);
      await this.save(state);
      await this.prune(tag, current);
      this.host.log(`Installed ${tag}.`);
      await this.compareUnits(tag);
      return 'applied';
    }
    if (!current) {
      await this.block(`${tag} did not pass its health check.`);
      throw new Error(`${tag} did not start; updates are blocked.`);
    }
    this.host.log(
      `${tag} did not pass its health check; returning to ${current}.`,
    );
    await this.point(current);
    await this.host.run('systemctl', ['restart', SERVICE]).catch(() => '');
    state.failed = [...new Set([...state.failed, tag])];
    await this.save(state);
    if (await this.healthy(port))
      throw new Error(
        `${tag} did not start, so ${current} is running again on ${tag}’s database schema. ${tag} will not be retried automatically.`,
      );
    await this.block(`Neither ${tag} nor ${current} passed the health check.`);
    throw new Error(
      `Neither ${tag} nor ${current} started; updates are blocked.`,
    );
  }

  /** Operator command: run the previous release again. The database keeps its migrations. */
  async rollback(): Promise<void> {
    const current = await this.installed();
    const state = await this.state();
    const previous = state.previous;
    if (!current || !previous)
      throw new Error('There is no previous release to return to.');
    parseManifest(
      JSON.parse(
        await readFile(this.release(previous, 'release.json'), 'utf8'),
      ),
      previous,
    );
    const env = await this.appEnv();
    this.host.log(
      `Returning to ${previous}; the database keeps ${current}’s migrations.`,
    );
    await this.host.run('systemctl', ['stop', SERVICE]);
    await this.point(previous);
    await this.host.run('systemctl', ['restart', SERVICE]);
    state.previous = undefined;
    state.failed = [...new Set([...state.failed, current])];
    await this.save(state);
    if (!(await this.healthy(Number(env.ORDER_PAD_PORT ?? '4174')))) {
      await this.block(
        `${previous} did not pass its health check after a rollback.`,
      );
      throw new Error(`${previous} did not start; updates are blocked.`);
    }
    this.host.log(
      `${previous} is running. ${current} will not be reinstalled automatically.`,
    );
  }

  /** Read-only: whether the station is idle right now (takes QUIET_MINUTES). */
  async idleNow(): Promise<boolean> {
    return (
      (await this.idle(await this.config(), await this.appEnv())) !== undefined
    );
  }

  async status(): Promise<string> {
    const config = await this.config();
    const state = await this.state();
    const current = await this.installed();
    const staged = (await readdir(this.releases).catch(() => [] as string[]))
      .filter(
        (name) => TAG.test(name) && current && compareTags(name, current) > 0,
      )
      .sort(compareTags);
    const left = this.windowLeft(config);
    const clock = (minutes: number) =>
      `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    return [
      `Installed: ${current ?? 'nothing'}${state.previous ? ` (previous ${state.previous})` : ''}`,
      `Staged: ${staged.join(', ') || 'nothing'}`,
      `Not retried automatically: ${state.failed.join(', ') || 'none'}`,
      `Blocked: ${(await this.blocked()) ?? 'no'}`,
      `Window: ${clock(config.window.start)}–${clock(config.window.end)} ${config.timeZone} (${left ? `open, ${left} minutes left` : 'closed'})`,
      `Channel: ${config.pin ? `pinned to ${config.pin}` : config.channel}; ${config.autoApply ? 'installs automatically' : 'stages only'}; verifies ${config.verify === 'sigstore' ? 'checksum and build provenance' : 'checksum only'}`,
    ].join('\n');
  }

  /** Installed units are only replaced by the installer, so say when a release ships new ones. */
  private async compareUnits(tag: string) {
    for (const name of [
      'order-pad.service',
      'order-pad-update.service',
      'order-pad-update.timer',
    ]) {
      const [shipped, installed] = await Promise.all(
        [
          this.release(tag, 'deploy', 'systemd', name),
          join(this.paths.units, name),
        ].map((file) => readFile(file, 'utf8').catch(() => '')),
      );
      if (shipped !== installed) {
        this.host.log(
          `${tag} ships a different ${name}. Refresh the units with: sudo bash /opt/order-pad/current/deploy/install-station.sh --release ${tag}`,
        );
        return;
      }
    }
  }

  private async manualMigrations(tag: string): Promise<string[]> {
    const text = await readFile(
      this.release(tag, 'deploy', 'manual-migrations'),
      'utf8',
    );
    return text
      .split('\n')
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean);
  }

  /** Returns the activity fingerprint after a quiet period, or undefined while staff are working. */
  private async idle(
    config: UpdaterConfig,
    env: Record<string, string>,
  ): Promise<string | undefined> {
    const queue =
      env.ORDER_PAD_PRINT_MODE === 'pdf'
        ? undefined
        : (env.ORDER_PAD_QUEUE ?? 'OrderPad');
    const pendingJob = async () =>
      queue
        ? (
            await this.host.run('lpstat', ['-h', 'localhost:631', '-o', queue])
          ).trim() !== ''
        : false;
    if (await pendingJob()) {
      this.host.log('A CUPS job is still pending; trying again later.');
      return undefined;
    }
    const before = await this.host.activity(env.DATABASE_URL);
    await this.host.sleep(config.quietMinutes * MINUTE);
    const after = await this.host.activity(env.DATABASE_URL);
    if (before !== after) {
      this.host.log(
        `The station was used in the last ${config.quietMinutes} minutes; trying again later.`,
      );
      return undefined;
    }
    if (await pendingJob()) {
      this.host.log('A CUPS job is still pending; trying again later.');
      return undefined;
    }
    return after;
  }

  private async backup(
    config: UpdaterConfig,
    env: Record<string, string>,
    from: string | undefined,
    to: string,
  ) {
    await mkdir(this.paths.backups, { recursive: true, mode: 0o700 });
    const stamp = this.host
      .now()
      .toISOString()
      .replace(/[-:]|\.\d+/g, '');
    const file = join(
      this.paths.backups,
      `${stamp}_${from ?? 'none'}_${to}.dump`,
    );
    try {
      await this.host.run('sh', ['-c', config.backupCommand], {
        env,
        stdout: file,
        timeoutMs: 30 * MINUTE,
      });
      const handle = await open(file, 'r');
      const head = Buffer.alloc(5);
      await handle.read(head, 0, 5, 0).finally(() => handle.close());
      if (head.toString('latin1') !== 'PGDMP')
        throw new Error(
          'BACKUP_COMMAND did not write a pg_dump custom-format archive.',
        );
    } catch (error) {
      await rm(file, { force: true });
      throw new Error(
        `The database backup failed, so nothing was installed: ${(error as Error).message}`,
      );
    }
    this.host.log(`Backed up the database to ${file}.`);
    const dumps = (await readdir(this.paths.backups))
      .filter((name) => name.endsWith('.dump'))
      .sort();
    for (const name of dumps.slice(
      0,
      Math.max(0, dumps.length - config.backupKeep),
    ))
      await rm(join(this.paths.backups, name), { force: true });
  }

  /** Swaps the `current` symlink in one rename, so the service never sees a half-switched tree. */
  private async point(tag: string) {
    const next = `${this.current}.next`;
    await rm(next, { force: true });
    await symlink(join('releases', tag), next);
    await rename(next, this.current);
  }

  private async healthy(port: number): Promise<boolean> {
    const restarts = () =>
      this.host.run('systemctl', [
        'show',
        '--property=NRestarts',
        '--value',
        SERVICE,
      ]);
    try {
      let up = false;
      for (let tries = 0; tries < 30 && !up; tries++) {
        up = await this.host.probe(port);
        if (!up) await this.host.sleep(2000);
      }
      if (!up) return false;
      const before = await restarts();
      await this.host.sleep(30000);
      return (
        (await this.host.probe(port)) &&
        (await restarts()) === before &&
        (await this.host.run('systemctl', ['is-active', SERVICE])).trim() ===
          'active'
      );
    } catch {
      return false;
    }
  }

  /** Keeps the running release, the one before it and anything newer that is staged. */
  private async prune(current: string, previous: string | undefined) {
    for (const name of await readdir(this.releases)) {
      const keep =
        TAG.test(name) &&
        (name === current ||
          name === previous ||
          compareTags(name, current) > 0);
      if (!keep)
        await rm(join(this.releases, name), { recursive: true, force: true });
    }
  }
}
