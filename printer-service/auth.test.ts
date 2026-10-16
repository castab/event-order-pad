import { describe, expect, it } from 'vitest';
import { clientIp, parseAuthConfig, passwordHash } from './auth';
import { verify } from '@node-rs/argon2';
import {
  parsePassword,
  parseUsername,
  parseAuthSession,
} from '../src/lib/auth/model';

describe('authentication input and trust boundaries', () => {
  it('canonicalizes usernames and preserves passwords exactly, including spaces and Unicode', () => {
    expect(parseUsername('FiOnA._-')).toBe('fiona._-');
    for (const bad of [
      'ab',
      ' staff',
      'staff@site',
      'staff\n',
      'a'.repeat(33),
      null,
    ])
      expect(() => parseUsername(bad)).toThrow();
    const passphrase = '  a long passphrase  ';
    expect(parsePassword(passphrase)).toBe(passphrase);
    expect(parsePassword('🍦'.repeat(15))).toHaveLength(30);
    for (const bad of ['a'.repeat(14), 'a'.repeat(129), null])
      expect(() => parsePassword(bad)).toThrow();
    const session = parseAuthSession({
      user: { id: '1', username: 'staff' },
      expiresAt: '2026-10-17T00:00:00.000Z',
      authenticatedAt: '2026-10-16T00:00:00.000Z',
    });
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.user)).toBe(true);
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
  it('uses salted Argon2id with the configured memory and work factor', async () => {
    const value = '  this is a passphrase  ';
    const first = await passwordHash(value);
    const second = await passwordHash(value);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(first).not.toBe(second);
    expect(await verify(first, value)).toBe(true);
    expect(await verify(first, value.trim())).toBe(false);
  });
});
