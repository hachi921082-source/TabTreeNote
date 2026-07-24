// src/renderer/editor/autoRename.ts
// AutoReName（本文の最初の非空行を自動的にメモ名にする, DESIGN §2.2 / PLAN §5.9 Fix12 /
// docs/milestones/M7-polish.md）の純粋ロジック（IPC 呼び出し・タイマー管理は呼び出し側=App.tsx）。
//
// 発火制御（PLAN §5.9/Fix12）:
// (a) 最初の非空行の内容が実際に変化した場合のみ発火
// (b) 編集停止から 500-1000ms 程度のデバウンスを挟んでから実行
// 暗号化メモ（.txtenc）は対象外（呼び出し側=App.tsx で openMemo.encrypted を見て除外する）。
import { suggestSanitizedName, validateNameLive } from '@shared/nameSanitize';

/** 編集停止からの発火デバウンス（PLAN §5.9「500〜1000ms程度」の範囲内）。 */
export const AUTO_RENAME_DEBOUNCE_MS = 800;

/** 先頭行が極端に長い場合に備えた妥当な上限（LONG_PATH等を誘発しないための developer 判断）。 */
const MAX_CANDIDATE_LENGTH = 100;

/** 重複回避のためのサフィックス付与を試行する上限回数（developer 判断。既定 memo:create の
 * pickAvailableName 相当のロジックをレンダラ側で簡易に再現する）。 */
const MAX_DUPLICATE_SUFFIX_ATTEMPTS = 50;

/** 本文（LF正規化済み）から最初の非空行（前後空白を除いた内容）を取り出す。無ければ空文字。 */
export function computeFirstNonEmptyLine(contentLF: string): string {
  for (const line of contentLF.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/** 禁止文字・予約名等を機械的に補正し、有効な名前に整える。補正不能なら null。 */
function sanitizeCandidate(raw: string): string | null {
  const truncated = raw.slice(0, MAX_CANDIDATE_LENGTH).trim();
  if (truncated.length === 0) return null;
  if (validateNameLive(truncated).ok) return truncated;
  const suggested = suggestSanitizedName(truncated);
  if (suggested && validateNameLive(suggested).ok) return suggested;
  return null;
}

function isNameTaken(name: string, existingNames: readonly string[], excludeName: string): boolean {
  const normalized = name.toUpperCase();
  return existingNames.some((n) => n !== excludeName && n.toUpperCase() === normalized);
}

/**
 * 最初の非空行からサニタイズ+重複回避を経たリネーム候補名を算出する（PLAN §5.9/Fix12
 * 「名前サニタイズ/重複回避を経て memo:rename 相当を実行する」）。
 * `existingNames` は現在のタブ内の全メモ名（レンダラが保持するツリー state 由来。メインの最終
 * 検証=`memo:rename` の `NAME_DUPLICATE` チェックがフェイルセーフとして残るため、ここでの重複判定は
 * ベストエフォートでよい）。
 * 候補が算出できない場合（サニタイズ不能・重複回避の試行上限超過）は null（リネームしない）。
 * 現在名と同じ場合も null（リネーム不要）。
 */
export function buildAutoRenameCandidate(
  rawFirstLine: string,
  existingNames: readonly string[],
  currentName: string
): string | null {
  const base = sanitizeCandidate(rawFirstLine);
  if (!base) return null;
  if (base === currentName) return null;
  if (!isNameTaken(base, existingNames, currentName)) return base;
  for (let i = 2; i <= MAX_DUPLICATE_SUFFIX_ATTEMPTS; i++) {
    const candidate = `${base} (${i})`;
    if (candidate.length <= MAX_CANDIDATE_LENGTH + 8 && !isNameTaken(candidate, existingNames, currentName)) {
      return candidate;
    }
  }
  return null;
}
