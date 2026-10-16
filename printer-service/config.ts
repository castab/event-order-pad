/** Omission preserves existing deployments; typos must not silently change behavior. */
export function parseTrackingEnabled(value: string | undefined): boolean {
  if (value === undefined || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('ORDER_PAD_TRACKING_ENABLED must be true or false.');
}

export function parseDatabaseUrl(value: string | undefined): string {
  try {
    const url = new URL(value ?? '');
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      [...url.searchParams.keys()].some(
        (key) =>
          ![
            'schema',
            'sslmode',
            'connection_limit',
            'connect_timeout',
            'pool_timeout',
          ].includes(key),
      ) ||
      url.pathname.length < 2
    )
      throw new Error();
    return value!;
  } catch {
    throw new Error(
      'DATABASE_URL must be a loopback Postgres connection URL with a database name; the app service and database must run on the same machine.',
    );
  }
}

export function parseCaptureFrom(value: string | undefined): string {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(
      'ORDER_PAD_CAPTURE_FROM must be a fixed UTC timestamp with milliseconds.',
    );
  return value;
}
export function parsePrintMode(value: string | undefined): 'cups' | 'pdf' {
  if (value === undefined || value === 'cups') return 'cups';
  if (value === 'pdf') return 'pdf';
  throw new Error('ORDER_PAD_PRINT_MODE must be cups or pdf.');
}

export function parseServiceOrigin(
  value: string | undefined,
  mode: 'cups' | 'pdf',
): URL {
  try {
    const origin = new URL(value ?? '');
    if (
      !(
        origin.protocol === 'https:' ||
        (mode === 'pdf' &&
          origin.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
      ) ||
      origin.pathname !== '/' ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash
    )
      throw new Error();
    return origin;
  } catch {
    throw new Error(
      'ORDER_PAD_ORIGIN must be a root HTTPS origin, or a loopback HTTP origin in PDF mode.',
    );
  }
}

export function assertPrintPlatform(
  mode: 'cups' | 'pdf',
  platform = process.platform,
): void {
  if (mode === 'cups' && platform !== 'linux')
    throw new Error(
      'The CUPS service requires Linux. Set ORDER_PAD_PRINT_MODE=pdf for development on other systems.',
    );
}
