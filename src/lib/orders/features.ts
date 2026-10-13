export const trackingDisabledCode = 'ORDER_TRACKING_DISABLED';

export async function fetchTrackingEnabled(
  signal?: AbortSignal,
  send: typeof fetch = (input, init) => fetch(input, init),
): Promise<boolean> {
  const response = await send('/api/features', {
    cache: 'no-store',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(
      'Order tracking settings unavailable. Refresh to try again.',
    );
  const data = await response.json();
  if (!data || typeof data.trackingEnabled !== 'boolean')
    throw new Error('Invalid order tracking settings.');
  return data.trackingEnabled;
}
