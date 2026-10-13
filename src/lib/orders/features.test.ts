import { expect, it, vi } from 'vitest';
import { fetchTrackingEnabled } from './features';

it.each([true, false])(
  'reads the uncached tracking setting %s',
  async (enabled) => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ trackingEnabled: enabled }));
    const controller = new AbortController();
    expect(await fetchTrackingEnabled(controller.signal, send)).toBe(enabled);
    const [path, init] = send.mock.calls[0];
    expect(path).toBe('/api/features');
    expect(init?.cache).toBe('no-store');
    expect(init?.signal?.aborted).toBe(false);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
  },
);
it.each([null, {}, { trackingEnabled: 'false' }, { trackingEnabled: 0 }])(
  'rejects malformed feature settings %j',
  async (body) => {
    await expect(
      fetchTrackingEnabled(
        undefined,
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
      ),
    ).rejects.toThrow('Invalid order tracking settings.');
  },
);
it('does not enable tracking when the settings request fails', async () => {
  for (const send of [
    vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 503 })),
    vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')),
    vi.fn<typeof fetch>().mockResolvedValue(new Response('{')),
  ])
    await expect(fetchTrackingEnabled(undefined, send)).rejects.toThrow();
});
