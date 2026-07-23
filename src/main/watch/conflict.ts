// src/main/watch/conflict.ts
// mtime+サイズ+ハッシュ競合判定（監視側, docs/00-core-principles.md §5 / DESIGN §3.3）。
//
// 保存 API（memo:save/crypto:saveEncrypted）の競合チェックはハッシュ比較のみの一発判定だが、
// ファイル監視側（自己発火判定・外部変更検知）は継続監視の中で自己書き込み由来イベントの
// 除外精度を上げるため、サイズ・ハッシュも併用する複合判定を用いる（意図的な非対称性）。
//
// mtime については本実装では判定の主材料としては使わない（NTFS のタイムスタンプ精度・
// stat タイミングのブレにより誤って自己発火を外部変更と取り違えるリスクの方が実害が大きいと
// 判断したため、サイズ+ハッシュの完全一致を主判定とする developer 判断。reviewer 確認事項）。
import { promises as fs } from 'node:fs';
import { hashBytes } from '../util/hash';
import {
  consumeSelfWrite,
  getSelfWriteExpectation,
  hasSelfWrite,
  type SelfWriteExpectation
} from './selfWriteRegistry';

export interface FileState {
  exists: boolean;
  size?: number;
  hash?: string;
}

/** 指定パスの現在の状態（存在有無+サイズ+ハッシュ）を読み取る。読み取り失敗は不在扱い。 */
export async function readFileState(absolutePath: string): Promise<FileState> {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return { exists: false };
    const buf = await fs.readFile(absolutePath);
    return { exists: true, size: stat.size, hash: hashBytes(buf) };
  } catch {
    return { exists: false };
  }
}

/**
 * 予約テーブルの期待値と実際の状態を突合する。`expectation` が `null`（登録済みだが未確定）の
 * 場合は、対応する自己書き込み操作が完了する前の極めて短い競合窓のみで発生し得るため、
 * 安全側（＝自己発火扱い）に倒す。
 */
export function matchesExpectation(expectation: SelfWriteExpectation | null, actual: FileState): boolean {
  if (expectation === null) return true;
  if (expectation.kind === 'delete') return !actual.exists;
  return actual.exists && actual.size === expectation.size && actual.hash === expectation.hash;
}

/**
 * chokidar イベント（デバウンス確定後）が自己発火（アプリ自身の操作）に一致するかを判定し、
 * 一致すれば selfWriteRegistry から即時消費する（対応イベントを 1 回消費した時点で即時クリア,
 * §4 ハイブリッド方式）。呼び出し側（watch/watcher.ts）は true が返ればこのイベントを
 * 外部変更として扱わず破棄する。
 */
export async function isSelfWriteEvent(absolutePath: string): Promise<boolean> {
  if (!hasSelfWrite(absolutePath)) return false;
  const expectation = getSelfWriteExpectation(absolutePath) ?? null;
  const actual = await readFileState(absolutePath);
  const matched = matchesExpectation(expectation, actual);
  if (matched) consumeSelfWrite(absolutePath);
  return matched;
}
