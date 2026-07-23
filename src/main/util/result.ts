// src/main/util/result.ts
// Result<T> ヘルパーと IPC 境界の UNKNOWN 丸め土台（docs/00-core-principles.md §1 / §8 / §10）。
import type { ErrorCode, Result } from '@shared/models';

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(code: ErrorCode, message: string, path?: string): Result<T> {
  return path === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, path } };
}

/**
 * 予期せぬ例外を `Result{ok:false, code:'UNKNOWN'}` へ丸める（00-core-principles.md §8 の
 * 「予期せぬ例外」行）。レンダラへは `code`/`message`/`path?` のみを返し、元の OS エラー
 * コード・例外名・スタックトレースはメインプロセス内部ログにのみ記録する（Fix8, §10）。
 * 鍵・パスワード・復号平文はここでも絶対にログへ出力しないこと。
 */
export function toUnknownResult<T = never>(e: unknown): Result<T> {
  const error = e instanceof Error ? e : new Error(String(e));
  const osCode = (error as NodeJS.ErrnoException).code;
  // eslint-disable-next-line no-console -- 内部診断ログ（レンダラへは渡さない, Fix8）
  console.error('[main] unexpected error', {
    name: error.name,
    message: error.message,
    code: osCode,
    stack: error.stack
  });
  return err<T>('UNKNOWN', 'Unexpected error occurred.');
}

/**
 * `ipcMain.handle` に渡すハンドラを try/catch で包み、投げられた例外を `toUnknownResult` で
 * Result 化する。実ハンドラ（tab/memo/crypto/... の各 handlers）は M1 以降で本関数を通して
 * 登録する。
 */
export function wrapHandler<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<Result<T>> | Result<T>
): (...args: Args) => Promise<Result<T>> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return toUnknownResult<T>(e);
    }
  };
}
