import { syncWithRetry } from './sync';

describe('syncWithRetry', () => {
  it('retries until the sync succeeds', async () => {
    const sync = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue(undefined);
    await syncWithRetry(sync, [0, 0, 0]);
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last retry', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('fetch failed'));
    await expect(syncWithRetry(sync, [0, 0])).rejects.toThrow(
      /failed after 3 attempts: fetch failed/,
    );
    expect(sync).toHaveBeenCalledTimes(3);
  });
});
