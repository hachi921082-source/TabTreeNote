// src/main/fs/trash.ts
// shell.trashItem によるごみ箱送り + 失敗時フォールバックの土台（DESIGN §2.6 / 00-core-principles.md §8）。
// ごみ箱送りの失敗（ネットワークドライブ/権限等）は典型的に恒久的な失敗であり EBUSY/EPERM の
// 一時ロックとは性質が異なるため、ここではリトライせず `TRASH_FAILED` を返す。呼び出し側の
// IPC handler が `evt:trashFallback` を発火し、UI で「直接削除しますか？」の確認を経て
// `forceDirect:true` の再 invoke で `deletePathDirect` を呼ぶ（無確認直接削除はしない）。
import { shell } from 'electron';
import { promises as fs } from 'node:fs';
import type { Result } from '@shared/models';
import { err, ok } from '../util/result';
import { consumeSelfWrite, registerSelfWrite } from '../watch/selfWriteRegistry';
import { withRetry } from './retry';

/** ファイル/フォルダを OS のごみ箱へ送る。失敗時は `TRASH_FAILED`（リトライはしない）。 */
export async function trashPath(absolutePath: string): Promise<Result<void>> {
  registerSelfWrite(absolutePath, { kind: 'delete' });
  try {
    await shell.trashItem(absolutePath);
    return ok(undefined);
  } catch (e) {
    // 内部診断ログ（00-core-principles.md §10 Fix8）。UI へは code/message/path のみ返す。
    // eslint-disable-next-line no-console -- 内部診断ログ
    console.error('[main] trashItem failed', absolutePath, e);
    // reviewer 指摘 M4-R1-01: trashItem 失敗時も事前登録した予約を解放する
    // （atomicWrite.ts の既存パターンに合わせる。解放しないと TTL 満了まで登録が残り、
    // その間の真の外部変更を自己発火と誤判定して握りつぶし得る）。
    consumeSelfWrite(absolutePath);
    return err('TRASH_FAILED', 'ごみ箱へ送れませんでした。', absolutePath);
  }
}

/**
 * ごみ箱送り失敗フォールバック（ユーザー承諾後の直接削除）専用。無確認では呼び出さないこと
 * （呼び出し元 IPC handler が `forceDirect:true` の再 invoke 経路でのみ使う, PLAN §2.2/§2.6）。
 * Windows ロック対策の短いリトライ（00-core-principles.md §7）を適用する。
 */
export async function deletePathDirect(absolutePath: string): Promise<void> {
  registerSelfWrite(absolutePath, { kind: 'delete' });
  try {
    await withRetry(() => fs.unlink(absolutePath));
  } catch (e) {
    // reviewer 指摘 M4-R1-01: unlink 失敗時も予約を解放する（atomicWrite.ts と同一パターン）。
    consumeSelfWrite(absolutePath);
    throw e;
  }
}
