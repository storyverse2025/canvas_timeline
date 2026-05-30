/**
 * Bounded concurrency runner. Pull items off a shared queue with up to
 * `limit` workers active at once. Errors don't kill the pool — they're
 * captured per-item so the caller can decide what to do.
 *
 * Used by `chat-quick-actions` to cap parallel generations at 5 (same
 * ceiling as `useBatchGenerate.MAX_CONCURRENT`) so we don't burn through
 * Seedance / Apimart / gpt-image-2 quotas when the user clicks "生成缺失".
 *
 * @returns one result per input item, preserving original order:
 *   - `{ok: true, value}` when worker resolved
 *   - `{ok: false, error}` when worker threw
 */
export interface ConcurrencyResult<T> {
  ok: boolean
  value?: T
  error?: Error
}

export async function runWithConcurrency<I, O>(
  items: I[],
  limit: number,
  worker: (item: I, index: number) => Promise<O>,
): Promise<Array<ConcurrencyResult<O>>> {
  const results: Array<ConcurrencyResult<O>> = new Array(items.length)
  if (items.length === 0) return results
  const safeLimit = Math.max(1, Math.min(limit, items.length))
  let cursor = 0

  const runOne = async (): Promise<void> => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      try {
        const value = await worker(items[i], i)
        results[i] = { ok: true, value }
      } catch (e) {
        results[i] = { ok: false, error: e as Error }
      }
    }
  }

  const workers = Array.from({ length: safeLimit }, () => runOne())
  await Promise.all(workers)
  return results
}
