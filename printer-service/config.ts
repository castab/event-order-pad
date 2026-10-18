import { isAbsolute } from 'node:path';

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

/** CUPS has a Linux default; PDF mode must name a font explicitly. */
export function parseFont(value: string | undefined, mode: 'cups' | 'pdf') {
  return (
    value ??
    (mode === 'cups'
      ? '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
      : '')
  );
}

export type AdminConfig = Readonly<{
  origin: URL;
  socket: string;
  capability: string;
}>;
/** The tailnet admin listener is all-or-nothing, so a partial setup stops startup. */
export function parseAdminConfig(
  env: NodeJS.ProcessEnv,
  publicOrigin: URL,
): AdminConfig | undefined {
  const {
    ORDER_PAD_ADMIN_ORIGIN: originValue,
    ORDER_PAD_ADMIN_SOCKET: socket,
    ORDER_PAD_ADMIN_CAPABILITY: capability,
  } = env;
  if (env.ORDER_PAD_ADMIN_LOGINS !== undefined)
    throw new Error(
      'ORDER_PAD_ADMIN_LOGINS is no longer used. Grant ORDER_PAD_ADMIN_CAPABILITY to tagged devices in the tailnet policy instead.',
    );
  if (
    originValue === undefined &&
    socket === undefined &&
    capability === undefined
  )
    return undefined;
  let origin: URL;
  try {
    origin = new URL(originValue ?? '');
    if (
      origin.protocol !== 'https:' ||
      !origin.hostname.endsWith('.ts.net') ||
      origin.pathname !== '/' ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.origin === publicOrigin.origin
    )
      throw new Error();
  } catch {
    throw new Error(
      'ORDER_PAD_ADMIN_ORIGIN must be a root HTTPS Tailscale Serve origin (*.ts.net) that differs from ORDER_PAD_ORIGIN.',
    );
  }
  // Linux socket addresses hold at most 107 bytes plus a terminator.
  if (
    !socket ||
    !isAbsolute(socket) ||
    /[\p{Cc}]/u.test(socket) ||
    Buffer.byteLength(socket) > 107
  )
    throw new Error(
      'ORDER_PAD_ADMIN_SOCKET must be an absolute socket path of at most 107 bytes.',
    );
  // Tailscale app capabilities are domain/path names; tailscale.com is reserved.
  if (
    !capability ||
    capability.length > 200 ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[A-Za-z0-9._~/-]+$/.test(capability) ||
    /^(?:[a-z0-9-]+\.)*tailscale\.com\//.test(capability)
  )
    throw new Error(
      'ORDER_PAD_ADMIN_CAPABILITY must be a Tailscale app capability name such as example.com/cap/order-pad-admin.',
    );
  return Object.freeze({ origin, socket, capability });
}
