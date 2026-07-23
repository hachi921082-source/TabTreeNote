// src/shared/nameSanitize.ts
// メモ名/タブ名のリアルタイムバリデーション（レンダラ入力欄用の純粋関数）。
// DESIGN §3.1 / 00-core-principles.md §11「名前サニタイズ / バリデーション」の UX 要件
// （即時バリデーションメッセージ + `/` 等の置換候補ワンクリック提示）をレンダラ側で満たすために使う。
//
// メイン側の権威ある検証（実際にファイル操作をブロックする最終判定）は
// `src/main/fs/pathSafety.ts`（同じ禁止文字集合・予約名を用いる、Node 依存あり）。
// 本モジュールは Node API に依存しないため、sandbox なレンダラからそのまま import できる
// （src/shared 配下は import-safe を維持する規約, models.ts 冒頭コメント参照）。
// 本モジュールでの判定はあくまで UX 上の即時フィードバックであり、実際の許可/拒否は
// 最終的に IPC 経由のメイン側検証（`pathSafety.validateName`）が行う（二重検証、フェイルセーフ）。

/** Windows 禁止文字（バックスラッシュ・スラッシュ・コロン・アスタリスク・疑問符・二重引用符・不等号・パイプ）と制御文字。 */
// eslint-disable-next-line no-control-regex -- 制御文字（U+0000-U+001F）の明示的な検出が目的
const FORBIDDEN_CHARS_RE = /[\x00-\x1f"*/:<>?\\|]/;
const FORBIDDEN_CHARS_DISPLAY = '\\ / : * ? " < > |';

/** Windows 予約名（拡張子を除いた部分がこれらと一致すると使用不可）。pathSafety.ts と同一集合。 */
const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
]);

export interface NameValidation {
  ok: boolean;
  /** 未入力（空文字）の場合は message を出さない（初期表示でエラーを出さないため）。 */
  message?: string;
}

/** 入力中の名前をその場で検証し、UI に即時表示するメッセージを返す。 */
export function validateNameLive(name: string): NameValidation {
  if (name.length === 0) {
    return { ok: false };
  }
  if (name !== name.trim()) {
    return { ok: false, message: '前後に空白を含めることはできません。' };
  }
  if (name.endsWith('.')) {
    return { ok: false, message: '末尾にピリオドを含めることはできません。' };
  }
  if (FORBIDDEN_CHARS_RE.test(name)) {
    return { ok: false, message: `使用できない文字が含まれています（${FORBIDDEN_CHARS_DISPLAY}）。` };
  }
  const upper = name.toUpperCase();
  const baseBeforeDot = upper.split('.')[0] ?? upper;
  if (RESERVED_NAMES.has(upper) || RESERVED_NAMES.has(baseBeforeDot)) {
    return { ok: false, message: `予約名は使用できません: ${name}` };
  }
  return { ok: true };
}

/**
 * `/` `\` を `-`/`_` へ、その他の禁止文字を `_` へ置換し、前後空白・末尾ピリオドを除去した
 * 修正候補を返す（DESIGN §3.1 UX「ワンクリックで自動修正」）。修正の必要が無い場合や、
 * 修正しても空文字になってしまう場合は `null`。
 */
export function suggestSanitizedName(name: string): string | null {
  let out = name.replace(/\//g, '-').replace(/\\/g, '_');
  // eslint-disable-next-line no-control-regex -- 制御文字を含む禁止文字全般を機械的に置換する
  out = out.replace(/[\x00-\x1f":*?<>|]/g, '_');
  out = out.trim();
  while (out.endsWith('.')) {
    out = out.slice(0, -1);
  }
  if (out.length === 0) return null;
  return out === name ? null : out;
}
