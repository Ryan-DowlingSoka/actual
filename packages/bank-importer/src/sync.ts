import { log } from './format';

const SYNC_RETRY_DELAYS_MS = [1_000, 3_000, 10_000];

/**
 * Syncing is idempotent (the server ignores messages it already has), so a
 * failed attempt can simply be repeated. The usual failure is a stale
 * keep-alive connection after a long import ("fetch failed: write EPIPE").
 */
export async function syncWithRetry(
  sync: () => Promise<void>,
  delays: number[] = SYNC_RETRY_DELAYS_MS,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await sync();
      return;
    } catch (err) {
      if (attempt >= delays.length) {
        throw new Error(
          `Sync to the server failed after ${attempt + 1} attempts: ${errorText(err)}`,
          { cause: err },
        );
      }
      log(
        `Sync failed (${errorText(err)}); retrying in ${delays[attempt] / 1000}s`,
      );
      await new Promise(r => setTimeout(r, delays[attempt]));
    }
  }
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
  return (err.message || err.name) + cause;
}
