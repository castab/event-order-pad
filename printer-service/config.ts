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
      !url.hostname ||
      url.pathname.length < 2
    )
      throw new Error();
    return value!;
  } catch {
    throw new Error(
      'DATABASE_URL must be a Postgres connection URL with a database name.',
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
