// src/main/watch/selfWriteRegistry.ts
// 自己書き込み予約テーブル（docs/00-core-principles.md §4 / DESIGN §3.3）。
//
// アプリ自身が行う FS 操作は監視イベントを誘発するため、対応する chokidar イベントを
// 「外部からの本当の変更」と誤認しないよう、実行前にここへ登録しておく。
// M1 時点では fs 層（atomicWrite/memoFileService 等）からの「登録」API のみを実装していた
// （登録の一元化構造そのものが M1 のスコープ）。M4 で「期待する mtime/サイズ/コンテンツハッシュ
// （削除の場合は不在）」を保持する機構と、chokidar イベントとの突合・実消費ロジック（実際の
// 突合判定自体は watch/conflict.ts に置く。本モジュールは純粋なレコード管理のみを担う）を追加した。
//
// 寿命はハイブリッド方式（TTL + 即時クリア, §4）: マッチしたら consumeSelfWrite で即時クリア、
// 未マッチのままなら TTL（既定 SELF_WRITE_TTL_MS）で自動失効し肥大化を防ぐ。
import { SELF_WRITE_TTL_MS } from '@shared/constants';

/**
 * 自己書き込みの「期待される結果」（PLAN §5 冒頭 / 00-core-principles.md §4）。
 * - `upsert`: 対象パスが最終的にこのサイズ・ハッシュのファイルとして存在するはず（保存・リネーム後
 *   の新パス・複製先・コピー先・移動先など）。
 * - `delete`: 対象パスは最終的に存在しないはず（リネーム前の旧パス・移動元・ごみ箱送り/直接削除）。
 */
export type SelfWriteExpectation = { kind: 'upsert'; size: number; hash: string } | { kind: 'delete' };

interface SelfWriteRecord {
  registeredAt: number;
  timer: NodeJS.Timeout;
  /**
   * 登録時点でまだ最終結果（実際に書き込まれるサイズ/ハッシュ）が確定していない場合は `null`。
   * `atomicWrite` のように「rename 前に予約を先に登録し、rename 完了後に確定値を補完する」
   * 二段階の呼び出しで使う（対応する chokidar イベントとの競合窓を閉じるため予約自体は先に行う）。
   */
  expectation: SelfWriteExpectation | null;
}

const registry = new Map<string, SelfWriteRecord>();

function scheduleExpiry(absolutePath: string, ttlMs: number): NodeJS.Timeout {
  const timer = setTimeout(() => registry.delete(absolutePath), ttlMs);
  // Electron メインプロセスの終了をタイマーが妨げないようにする。
  timer.unref?.();
  return timer;
}

/**
 * 絶対パスを自己書き込みとして予約登録する。TTL 経過で自動失効する。
 * `expectation` を渡さない（または `null`）場合は「登録済みだが期待結果は未確定」を表す
 * プレースホルダとして扱う（`refineSelfWriteExpectation` で後から補完すること）。
 */
export function registerSelfWrite(
  absolutePath: string,
  expectation: SelfWriteExpectation | null = null,
  ttlMs: number = SELF_WRITE_TTL_MS
): void {
  const existing = registry.get(absolutePath);
  if (existing) clearTimeout(existing.timer);
  registry.set(absolutePath, { registeredAt: existing?.registeredAt ?? Date.now(), timer: scheduleExpiry(absolutePath, ttlMs), expectation });
}

/**
 * 既存の予約（プレースホルダ登録済み）に期待結果を補完する（M4）。実ファイル操作完了直後、
 * 最終的なサイズ/ハッシュが判明した時点で呼ぶ（例: `atomicWrite` の rename 成功直後）。
 * レコードが無ければ新規登録として扱う。
 */
export function refineSelfWriteExpectation(
  absolutePath: string,
  expectation: SelfWriteExpectation,
  ttlMs: number = SELF_WRITE_TTL_MS
): void {
  registerSelfWrite(absolutePath, expectation, ttlMs);
}

/** 登録の有無を確認する。 */
export function hasSelfWrite(absolutePath: string): boolean {
  return registry.has(absolutePath);
}

/** 登録済みレコードの期待結果を取得する（未登録は `undefined`、登録済み未確定は `null`）。 */
export function getSelfWriteExpectation(absolutePath: string): SelfWriteExpectation | null | undefined {
  return registry.get(absolutePath)?.expectation;
}

/** 対応する chokidar イベントを消費した時点で即時クリアする（watch/conflict.ts が使用）。 */
export function consumeSelfWrite(absolutePath: string): boolean {
  const existing = registry.get(absolutePath);
  if (!existing) return false;
  clearTimeout(existing.timer);
  registry.delete(absolutePath);
  return true;
}
