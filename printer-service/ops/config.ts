import { parseEnv } from 'node:util';

export interface UpdateWindow {
  readonly start: number;
  readonly end: number;
}
export interface UpdaterConfig {
  readonly repo: string;
  readonly window: UpdateWindow;
  readonly timeZone: string;
  readonly channel: 'stable' | 'prerelease';
  readonly pin?: string;
  readonly autoApply: boolean;
  readonly verify: 'sigstore' | 'sha256';
  readonly backupCommand: string;
  readonly backupKeep: number;
  readonly quietMinutes: number;
  readonly minWindowLeft: number;
}

const keys = new Set([
  'REPO',
  'WINDOW',
  'TIME_ZONE',
  'CHANNEL',
  'PIN',
  'AUTO_APPLY',
  'VERIFY',
  'BACKUP_COMMAND',
  'BACKUP_KEEP',
  'QUIET_MINUTES',
  'MIN_WINDOW_LEFT_MINUTES',
]);
export const TAG =
  /^v(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.]{1,40}))?$/;

function whole(value: string | undefined, name: string, fallback: number) {
  if (value === undefined) return fallback;
  if (!/^\d{1,4}$/.test(value) || Number(value) < 1)
    throw new Error(`${name} must be a whole number of at least 1.`);
  return Number(value);
}
function choice<T extends string>(
  value: string | undefined,
  name: string,
  options: readonly T[],
): T {
  const picked = value ?? options[0];
  if (!options.includes(picked as T))
    throw new Error(`${name} must be ${options.join(' or ')}.`);
  return picked as T;
}

export function parseWindow(value: string | undefined): UpdateWindow {
  const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(
    value ?? '',
  );
  if (!match)
    throw new Error('WINDOW must look like 02:00-05:00 (24-hour local time).');
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start === end) throw new Error('WINDOW must not start and end together.');
  return Object.freeze({ start, end });
}

/** Strict, so a typo stops the updater instead of updating at the wrong time. */
export function parseUpdaterConfig(text: string): UpdaterConfig {
  const env = parseEnv(text);
  for (const key of Object.keys(env))
    if (!keys.has(key)) throw new Error(`Unknown updater setting ${key}.`);
  const repo = env.REPO ?? 'castab/event-order-pad';
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo))
    throw new Error('REPO must look like owner/name.');
  const timeZone = env.TIME_ZONE ?? '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    if (!timeZone) throw new Error();
  } catch {
    throw new Error('TIME_ZONE must be an IANA zone such as America/Chicago.');
  }
  if (env.PIN !== undefined && !TAG.test(env.PIN))
    throw new Error('PIN must be a release tag such as v1.4.0.');
  if (!env.BACKUP_COMMAND?.trim())
    throw new Error(
      'BACKUP_COMMAND must write a pg_dump custom-format archive to stdout.',
    );
  return Object.freeze({
    repo,
    window: parseWindow(env.WINDOW),
    timeZone,
    channel: choice(env.CHANNEL, 'CHANNEL', ['stable', 'prerelease'] as const),
    ...(env.PIN ? { pin: env.PIN } : {}),
    autoApply:
      choice(env.AUTO_APPLY, 'AUTO_APPLY', ['true', 'false'] as const) ===
      'true',
    verify: choice(env.VERIFY, 'VERIFY', ['sigstore', 'sha256'] as const),
    backupCommand: env.BACKUP_COMMAND,
    backupKeep: whole(env.BACKUP_KEEP, 'BACKUP_KEEP', 10),
    quietMinutes: whole(env.QUIET_MINUTES, 'QUIET_MINUTES', 10),
    minWindowLeft: whole(
      env.MIN_WINDOW_LEFT_MINUTES,
      'MIN_WINDOW_LEFT_MINUTES',
      20,
    ),
  });
}

/** Minutes left in the window at `now` in `timeZone`, or 0 outside it. */
export function windowMinutesLeft(
  window: UpdateWindow,
  timeZone: string,
  now: Date,
): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const minute = part('hour') * 60 + part('minute');
  const inside =
    window.start < window.end
      ? minute >= window.start && minute < window.end
      : minute >= window.start || minute < window.end;
  return inside ? (window.end - minute + 1440) % 1440 : 0;
}
