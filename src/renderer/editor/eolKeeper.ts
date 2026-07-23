// src/renderer/editor/eolKeeper.ts
// メタ改行コード種別の保持（DESIGN §2.3）。
// エディタ（CodeMirror 6）は内部で \n に正規化するため、読み込み時に検出した改行コード種別
// `eol` と競合判定用の `hash` をメモ単位で保持し、保存直前に main 側で LF テキストへ復元する。
// M1/M2 では textarea ベースの簡易エディタと組み合わせて使っていたが、M3-① で本格的な
// CodeMirror 6 ラッパ（components/Editor/CodeMirrorEditor.tsx）へ置き換えた。保持ロジック自体は
// エディタ実装に依存しない（引き続きそのまま利用）。
import type { MemoReadResult } from '@shared/models';

/** 開いているメモ 1 件分の、保存時に必要なメタ情報（本文テキストは呼び出し側の state で保持）。 */
export interface OpenMemoState {
  tabId: string;
  memoName: string;
  eol: MemoReadResult['eol'];
  encoding: MemoReadResult['encoding'];
  /** 直近の読み込み/保存時点における実ファイル全体のハッシュ（次回保存時の競合判定用, Fix4）。 */
  lastKnownHash: string;
  encrypted: boolean;
}

/** `memo:read`/`memo:readWithEncoding` の結果から `OpenMemoState` を作る。 */
export function createOpenMemoState(tabId: string, memoName: string, readResult: MemoReadResult): OpenMemoState {
  return {
    tabId,
    memoName,
    eol: readResult.eol,
    encoding: readResult.encoding,
    lastKnownHash: readResult.hash,
    encrypted: readResult.encrypted
  };
}

/** 保存成功後、次回競合判定用に `lastKnownHash` を更新した新しい state を返す。 */
export function withUpdatedHash(state: OpenMemoState, savedHash: string): OpenMemoState {
  return { ...state, lastKnownHash: savedHash };
}
