// src/main/watch/selfWriteRegistry.ts
// 自己書き込み予約テーブル（docs/00-core-principles.md §4 / DESIGN §3.3）。
//
// アプリ自身が行う FS 操作は監視イベントを誘発するため、対応する chokidar イベントを
// 「外部からの本当の変更」と誤認しないよう、実行前にここへ登録しておく。
// M1 時点では fs 層（atomicWrite/memoFileService 等）からの「登録」API のみを実装する
// （登録の一元化構造そのものが M1 のスコープ）。chokidar イベントとの突合・実消費ロジックは
// M4（ファイル監視）で実装する。
//
// 寿命はハイブリッド方式（TTL + 即時クリア, §4）: マッチしたら consumeSelfWrite で即時クリア、
// 未マッチのままなら TTL（既定 SELF_WRITE_TTL_MS）で自動失効し肥大化を防ぐ。
import { SELF_WRITE_TTL_MS } from '@shared/constants';

interface SelfWriteRecord {
  registeredAt: number;
  timer: NodeJS.Timeout;
}

const registry = new Map<string, SelfWriteRecord>();

/** 絶対パスを自己書き込みとして予約登録する。TTL 経過で自動失効する。 */
export function registerSelfWrite(absolutePath: string, ttlMs: number = SELF_WRITE_TTL_MS): void {
  const existing = registry.get(absolutePath);
  if (existing) {
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => registry.delete(absolutePath), ttlMs);
  // Electron メインプロセスの終了をタイマーが妨げないようにする。
  timer.unref?.();
  registry.set(absolutePath, { registeredAt: Date.now(), timer });
}

/** 登録の有無を確認する（M4 の自己発火判定が使用する想定）。 */
export function hasSelfWrite(absolutePath: string): boolean {
  return registry.has(absolutePath);
}

/** 対応する chokidar イベントを消費した時点で即時クリアする（M4 で使用）。 */
export function consumeSelfWrite(absolutePath: string): boolean {
  const existing = registry.get(absolutePath);
  if (!existing) return false;
  clearTimeout(existing.timer);
  registry.delete(absolutePath);
  return true;
}
