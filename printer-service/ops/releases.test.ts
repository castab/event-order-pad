import { describe, expect, it } from 'vitest';
import { parseUpdaterConfig, parseWindow, windowMinutesLeft } from './config';
import {
  chooseRelease,
  compareTags,
  parseChecksums,
  parseManifest,
  parseReleases,
  tarballName,
} from './releases';

const base =
  'WINDOW=02:00-05:00\nTIME_ZONE=America/Chicago\nBACKUP_COMMAND=pg_dump -Fc\n';

describe('updater settings', () => {
  it('parses defaults and rejects typos', () => {
    expect(parseUpdaterConfig(base)).toMatchObject({
      repo: 'castab/event-order-pad',
      channel: 'stable',
      autoApply: true,
      verify: 'sigstore',
      backupKeep: 10,
      quietMinutes: 10,
      minWindowLeft: 20,
    });
    for (const bad of [
      'WINDOWS=02:00-05:00',
      'CHANNEL=beta',
      'AUTO_APPLY=yes',
      'PIN=1.2.0',
      'QUIET_MINUTES=0',
      'TIME_ZONE=Mars/Base',
      'REPO=not a repo',
    ])
      expect(() => parseUpdaterConfig(`${base}${bad}\n`)).toThrow();
    expect(() =>
      parseUpdaterConfig('WINDOW=02:00-05:00\nTIME_ZONE=UTC\n'),
    ).toThrow('BACKUP_COMMAND');
    expect(() => parseWindow('2:00-5:00')).toThrow();
    expect(() => parseWindow('02:00-02:00')).toThrow();
  });
  it('measures the window in the station time zone, across midnight', () => {
    const window = parseWindow('02:00-05:00');
    // 02:30 in Chicago during daylight time is 07:30 UTC.
    expect(
      windowMinutesLeft(
        window,
        'America/Chicago',
        new Date('2026-07-01T07:30:00Z'),
      ),
    ).toBe(150);
    expect(
      windowMinutesLeft(
        window,
        'America/Chicago',
        new Date('2026-07-01T02:30:00Z'),
      ),
    ).toBe(0);
    const night = parseWindow('23:00-01:00');
    expect(
      windowMinutesLeft(night, 'UTC', new Date('2026-07-01T23:30:00Z')),
    ).toBe(90);
    expect(
      windowMinutesLeft(night, 'UTC', new Date('2026-07-01T00:45:00Z')),
    ).toBe(15);
    expect(
      windowMinutesLeft(night, 'UTC', new Date('2026-07-01T01:00:00Z')),
    ).toBe(0);
  });
});

describe('release selection', () => {
  const asset = (tag: string) => ({
    name: tarballName(tag),
    browser_download_url: `https://github.com/castab/event-order-pad/releases/download/${tag}/${tarballName(tag)}`,
    size: 1,
  });
  const list = parseReleases([
    {
      tag_name: 'v1.3.0',
      draft: false,
      prerelease: false,
      assets: [asset('v1.3.0')],
    },
    {
      tag_name: 'v1.4.0-rc.1',
      draft: false,
      prerelease: true,
      assets: [asset('v1.4.0-rc.1')],
    },
    {
      tag_name: 'v1.2.1',
      draft: false,
      prerelease: false,
      assets: [asset('v1.2.1')],
    },
    {
      tag_name: 'v1.5.0',
      draft: true,
      prerelease: false,
      assets: [asset('v1.5.0')],
    },
    { tag_name: 'v1.6.0', draft: false, prerelease: false, assets: [] },
    { tag_name: 'nightly', draft: false, prerelease: false, assets: [] },
    {
      tag_name: 'v1.7.0',
      draft: false,
      prerelease: false,
      assets: [
        { ...asset('v1.7.0'), browser_download_url: 'https://evil.example/x' },
      ],
    },
  ]);
  it('orders tags by semantic version', () => {
    const tags = [
      'v1.10.0',
      'v1.2.0',
      'v1.10.0-rc.2',
      'v1.10.0-rc.10',
      'v1.10.0-beta',
    ];
    expect(tags.sort(compareTags)).toEqual([
      'v1.2.0',
      'v1.10.0-beta',
      'v1.10.0-rc.2',
      'v1.10.0-rc.10',
      'v1.10.0',
    ]);
  });
  it('skips drafts, unknown tags, missing or foreign assets', () => {
    expect(list.map((r) => r.tag)).toEqual([
      'v1.3.0',
      'v1.4.0-rc.1',
      'v1.2.1',
      'v1.6.0',
      'v1.7.0',
    ]);
    expect(list.find((r) => r.tag === 'v1.7.0')?.assets).toEqual([]);
  });
  it('picks the newest newer release on the channel, or the pin', () => {
    const stable = { channel: 'stable' as const };
    expect(chooseRelease(list, 'v1.2.1', stable, [])?.tag).toBe('v1.3.0');
    expect(chooseRelease(list, 'v1.3.0', stable, [])).toBeUndefined();
    expect(
      chooseRelease(list, 'v1.3.0', { channel: 'prerelease' }, [])?.tag,
    ).toBe('v1.4.0-rc.1');
    expect(chooseRelease(list, 'v1.2.1', stable, ['v1.3.0'])).toBeUndefined();
    expect(
      chooseRelease(
        list,
        'v1.2.1',
        { channel: 'stable', pin: 'v1.4.0-rc.1' },
        [],
      )?.tag,
    ).toBe('v1.4.0-rc.1');
    expect(
      chooseRelease(list, 'v1.3.0', { channel: 'stable', pin: 'v1.2.1' }, []),
    ).toBeUndefined();
  });
  it('validates the manifest and checksum list', () => {
    const manifest = {
      schema: 1,
      tag: 'v1.3.0',
      commit: 'a'.repeat(40),
      node: 'v24.22.0',
      arch: 'linux-x64',
    };
    expect(parseManifest(manifest, 'v1.3.0').tag).toBe('v1.3.0');
    expect(() => parseManifest(manifest, 'v1.4.0')).toThrow();
    expect(() =>
      parseManifest({ ...manifest, arch: 'linux-arm64' }, 'v1.3.0'),
    ).toThrow();
    expect(
      parseChecksums(`${'b'.repeat(64)}  ${tarballName('v1.3.0')}\njunk\n`).get(
        tarballName('v1.3.0'),
      ),
    ).toBe('b'.repeat(64));
  });
});
