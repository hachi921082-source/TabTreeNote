// src/main/fs/eol.ts
// 改行コード検出・復元（docs/00-core-principles.md §2 該当 / DESIGN §2.3）。
// CodeMirror 6 等のエディタは内部で \n に正規化するため、読み込み時に検出した EOL 種別を
// メモのメタ情報として保持し、保存直前に LF テキストへ EOL 復元処理を挟むことが必須。
import type { Eol } from '@shared/models';

/**
 * 生テキスト（デコード直後、まだ LF 正規化前）から改行コード種別を検出する。
 * 混在時は最初に出現した種類を採用。改行が 1 つも無ければ既定 'lf' とする。
 */
export function detectEol(rawText: string): Eol {
  const match = /\r\n|\r|\n/.exec(rawText);
  if (!match) return 'lf';
  return match[0] === '\r\n' ? 'crlf' : match[0] === '\r' ? 'cr' : 'lf';
}

/** 生テキストを LF 正規化する（読み込み直後、エディタへ渡す前に適用）。 */
export function normalizeToLf(rawText: string): string {
  return rawText.replace(/\r\n|\r/g, '\n');
}

/** LF 正規化済みテキストへ指定の改行コードを復元する（保存直前の必須処理）。 */
export function restoreEol(lfText: string, eol: Eol): string {
  if (eol === 'lf') return lfText;
  const newline = eol === 'crlf' ? '\r\n' : '\r';
  return lfText.replace(/\n/g, newline);
}
