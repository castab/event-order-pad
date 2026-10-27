import { TAG, type UpdaterConfig } from './config';

export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
  readonly size: number;
}
export interface Release {
  readonly tag: string;
  readonly prerelease: boolean;
  readonly assets: readonly ReleaseAsset[];
}
export interface ReleaseManifest {
  readonly schema: 1;
  readonly tag: string;
  readonly commit: string;
  readonly node: string;
  readonly arch: 'linux-x64';
}

export const tarballName = (tag: string) => `order-pad-${tag}-linux-x64.tar.gz`;
export const bundleName = (tag: string) => `${tarballName(tag)}.sigstore.json`;

export function parseTag(tag: string) {
  const match = TAG.exec(tag);
  if (!match) throw new Error(`Not a release tag: ${tag}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4]?.split('.') ?? [],
  };
}

/** Semantic-version order; a prerelease sorts before its release. */
export function compareTags(a: string, b: string): number {
  const x = parseTag(a);
  const y = parseTag(b);
  for (let i = 0; i < 3; i++)
    if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const [m, n] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (m && n) return Number(p) - Number(q);
    if (m !== n) return m ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** GitHub's release list, keeping only published tags this updater understands. */
export function parseReleases(value: unknown): Release[] {
  if (!Array.isArray(value)) throw new Error('Unexpected GitHub release list.');
  return value.flatMap((item): Release[] => {
    if (
      !item ||
      typeof item !== 'object' ||
      item.draft !== false ||
      typeof item.tag_name !== 'string' ||
      !TAG.test(item.tag_name) ||
      !Array.isArray(item.assets)
    )
      return [];
    return [
      Object.freeze({
        tag: item.tag_name,
        prerelease: item.prerelease === true,
        assets: Object.freeze(
          item.assets.flatMap((asset: Record<string, unknown>) =>
            typeof asset?.name === 'string' &&
            typeof asset.browser_download_url === 'string' &&
            asset.browser_download_url.startsWith('https://github.com/') &&
            typeof asset.size === 'number'
              ? [
                  Object.freeze({
                    name: asset.name,
                    url: asset.browser_download_url,
                    size: asset.size,
                  }),
                ]
              : [],
          ),
        ),
      }),
    ];
  });
}

/** The release to install next: the pin, else the newest newer one on the channel. */
export function chooseRelease(
  releases: readonly Release[],
  current: string,
  config: Pick<UpdaterConfig, 'channel' | 'pin'>,
  failed: readonly string[],
): Release | undefined {
  const candidates = releases.filter(
    (release) =>
      compareTags(release.tag, current) > 0 &&
      !failed.includes(release.tag) &&
      (config.pin
        ? release.tag === config.pin
        : config.channel === 'prerelease' || !release.prerelease) &&
      release.assets.some((asset) => asset.name === tarballName(release.tag)),
  );
  return candidates.sort((a, b) => compareTags(b.tag, a.tag))[0];
}

export function parseManifest(value: unknown, tag: string): ReleaseManifest {
  const input = value as Partial<ReleaseManifest> | null;
  if (
    !input ||
    input.schema !== 1 ||
    input.tag !== tag ||
    input.arch !== 'linux-x64' ||
    typeof input.commit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(input.commit) ||
    typeof input.node !== 'string'
  )
    throw new Error(`release.json does not describe ${tag} for linux-x64.`);
  return Object.freeze({
    schema: 1,
    tag,
    commit: input.commit,
    node: input.node,
    arch: 'linux-x64',
  });
}

export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}
