// src/renderer/editor/eolKeeper.ts
// メタ改行コード種別の保持（DESIGN §2.3）。
// エディタ（CodeMirror 6）は内部で \n に正規化するため、読み込み時に検出した改行コード種別
// `eol` と競合判定用の `hash` をメモ単位で保持し、保存直前に main 側で LF テキストへ復元する。
// M1/M2 では textarea ベースの簡易エディタと組み合わせて使っていたが、M3-① で本格的な
// CodeMirror 6 ラッパ（components/Editor/CodeMirrorEditor.tsx）へ置き換えた。保持ロジック自体は
// エディタ実装に依存しない（引き続きそのまま利用）。
import type { AppSettings, MemoReadResult } from '@shared/models';

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

/**
 * 保存時に実際に使う改行コードを、アプリ設定の改行コードポリシー（`AppSettings.eol.policy`,
 * M7 設定画面で編集可能）に従って決定する（DESIGN §2.3「既定は読込時に検出した改行コードを
 * そのまま維持して保存する。ユーザー設定で明示的に特定の改行コードへ統一する選択肢も残す」）。
 * `'preserve'`（既定）なら読み込み時に記録した改行コードをそのまま使う。それ以外
 * （`'crlf'`/`'lf'`/`'cr'`）が明示指定されていれば、保存のたびにその改行コードへ統一する。
 */
export function resolveEffectiveEol(recordedEol: MemoReadResult['eol'], policy: AppSettings['eol']['policy']): MemoReadResult['eol'] {
  return policy === 'preserve' ? recordedEol : policy;
}
