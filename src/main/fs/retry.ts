// src/main/fs/retry.ts
// Windows ロックエラー（EBUSY/EPERM 等）用リトライ（docs/00-core-principles.md §7）。
// ウイルス対策ソフト/インデックスサービスによる一時ロックを想定し、短いバックオフで再試行する。
// 全滅時は最後の例外をそのまま呼び出し元へ投げる（呼び出し側で IO_LOCKED 等へマッピングする）。
import { IO_RETRY_BASE_DELAY_MS, IO_RETRY_COUNT, IO_RETRY_MAX_DELAY_MS } from '@shared/constants';

/** Windows でファイルロック競合時に発生し得るリトライ対象の OS エラーコード。 */
const RETRYABLE_ERROR_CODES = new Set(['EBUSY', 'EPERM']);

function isRetryableError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `fn` を実行し、リトライ対象エラーであれば指数バックオフ（上限 IO_RETRY_MAX_DELAY_MS）で
 * 最大 `attempts` 回まで再試行する。リトライ対象外のエラーは即座に再スローする。
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts: number = IO_RETRY_COUNT): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const isLastAttempt = attempt === attempts - 1;
      if (!isRetryableError(e) || isLastAttempt) {
        throw e;
      }
      const backoffMs = Math.min(IO_RETRY_MAX_DELAY_MS, IO_RETRY_BASE_DELAY_MS * 2 ** attempt);
      await delay(backoffMs);
    }
  }
  // 到達しない（ループ内で必ず return または throw する）が、型チェックのため明示。
  throw lastError;
}
