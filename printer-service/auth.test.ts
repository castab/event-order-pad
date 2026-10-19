import { describe, expect, it } from 'vitest';
import { clientIp, codeHash, deviceLabel, parseAuthConfig } from './auth';
import { resolve } from 'node:path';
import { verify } from '@node-rs/argon2';
import { newAccessCode, printAccessSlip } from './access-admin';
import { Cups, type Command } from './cups';
import {
  ACCESS_CODE_ALPHABET,
  formatAccessCode,
  parseAccessCode,
  parseAuthSession,
  parseMintCount,
} from '../src/lib/auth/model';

describe('authentication input and trust boundaries', () => {
  it('canonicalizes typed access codes and rejects anything else', () => {
    expect(parseAccessCode('k7qm4-xtd9a')).toBe('K7QM4XTD9A');
    expect(parseAccessCode(' K7QM4 XTD9A ')).toBe('K7QM4XTD9A');
    expect(formatAccessCode('K7QM4XTD9A')).toBe('K7QM4-XTD9A');
    for (const bad of [
      'K7QM4XTD9',
      'K7QM4XTD9AB',
      'K7QM4XTD0A',
      'K7QM4XTDIA',
      'K7QM4XTDLA',
      'K7QM4_XTD9A',
      'K'.repeat(41),
      null,
      42,
    ])
      expect(() => parseAccessCode(bad)).toThrow();
    const session = parseAuthSession({
      expiresAt: '2026-10-17T00:00:00.000Z',
      authenticatedAt: '2026-10-16T00:00:00.000Z',
      codeId: 'never-sent',
    });
    expect(session).toEqual({
      expiresAt: '2026-10-17T00:00:00.000Z',
      authenticatedAt: '2026-10-16T00:00:00.000Z',
    });
    expect(Object.isFrozen(session)).toBe(true);
  });
  it('names a signed-in device plainly and never fails on odd agents', () => {
    for (const [agent, label] of [
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        'Safari on iPhone',
      ],
      [
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
        'Chrome on Android',
      ],
      [
        'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
        'Samsung Internet on Android',
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
        'Edge on Windows',
      ],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0',
        'Firefox on Mac',
      ],
      [
        'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1',
        'Chrome on iPad',
      ],
      ['curl/8.5.0', 'Unknown browser'],
      ['', 'Unknown browser'],
      [undefined, 'Unknown browser'],
    ] as const)
      expect(deviceLabel(agent)).toBe(label);
  });
  it('mints only a whole number of codes from 1 to 5', () => {
    for (const count of [1, 3, 5]) expect(parseMintCount(count)).toBe(count);
    for (const bad of [0, 6, -1, 2.5, NaN, Infinity, '3', null, undefined])
      expect(() => parseMintCount(bad)).toThrow(
        'Mint from 1 to 5 codes at a time. Nothing was minted.',
      );
  });
  it('mints codes uniformly from the unambiguous alphabet', () => {
    let next = 0;
    expect(newAccessCode(() => next++ % ACCESS_CODE_ALPHABET.length)).toBe(
      '23456789AB',
    );
    for (let i = 0; i < 50; i++)
      expect(parseAccessCode(newAccessCode())).toHaveLength(10);
  });
  it('trusts Cloudflare client IPs only on the configured loopback hop', () => {
    expect(clientIp('127.0.0.1', '192.0.2.1', 'direct')).toBe('127.0.0.1');
    expect(clientIp('127.0.0.1', '192.0.2.1', 'cloudflare')).toBe('192.0.2.1');
    expect(clientIp('::ffff:127.0.0.1', '2001:0db8::1', 'cloudflare')).toBe(
      '2001:db8::1',
    );
    for (const header of [
      undefined,
      ['192.0.2.1'],
      '192.0.2.1, 192.0.2.2',
      'bad',
    ])
      expect(() => clientIp('127.0.0.1', header, 'cloudflare')).toThrow();
    expect(() => clientIp('192.0.2.1', '192.0.2.2', 'cloudflare')).toThrow();
  });
  it('requires strict production settings', () => {
    expect(() => parseAuthConfig({})).toThrow();
    expect(() => parseAuthConfig({ ORDER_PAD_PROXY: 'true' })).toThrow();
    expect(
      parseAuthConfig({
        ORDER_PAD_TURNSTILE_SITE_KEY: 'site',
        ORDER_PAD_TURNSTILE_SECRET_KEY: 'secret',
      }).proxy,
    ).toBe('direct');
  });
  it('stores codes with salted Argon2id at the configured cost', async () => {
    const first = await codeHash('K7QM4XTD9A');
    const second = await codeHash('K7QM4XTD9A');
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(first).not.toBe(second);
    expect(await verify(first, 'K7QM4XTD9A')).toBe(true);
    expect(await verify(first, 'K7QM4XTD9B')).toBe(false);
  });
  it('prints the access slip as one CUPS job without touching a printer', async () => {
    const calls: { program: string; args: readonly string[] }[] = [];
    const run: Command = async (program, args) => {
      calls.push({ program, args });
      if (program === 'lpstat' && args.includes('-o')) return '';
      if (program === 'lpstat')
        return 'printer OrderPad is idle.\ndevice for OrderPad: usb://Star/TSP143';
      if (program === 'lpoptions')
        return [
          'PageType/Page Type: *0Variable',
          'DocCutType/Doc Cut: *1PartialCutDoc',
          'PageCutType/Page Cut: *0NoCutPage',
          'PageSize/Media Size: *Custom',
        ].join('\n');
      return 'request id is OrderPad-7 (1 file(s))';
    };
    const font = resolve('static/fonts/poppins-400.ttf');
    const job = await printAccessSlip(
      new Cups('OrderPad', run),
      'K7QM4XTD9A',
      new Date('2026-10-16T20:00:00.000Z'),
      font,
    );
    expect(job).toBe('OrderPad-7');
    const lp = calls.filter((call) => call.program === 'lp');
    expect(lp).toHaveLength(1);
    expect(lp[0].args).toContain('media=Custom.72x60mm');
    expect(
      lp[0].args.find((arg) => arg.startsWith('OrderPad-access-')),
    ).toBeTruthy();
  });
});
