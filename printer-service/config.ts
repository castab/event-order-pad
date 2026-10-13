/** Omission preserves existing deployments; typos must not silently change behavior. */
export function parseTrackingEnabled(value: string | undefined): boolean {
  if (value === undefined || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('ORDER_PAD_TRACKING_ENABLED must be true or false.');
}
