// src/shared/shortcuts.ts
// キーボードショートカット（`AppSettings.shortcuts`, DESIGN §2.7「既定は原作を参考に妥当なものを
// 整備。ユーザー設定可能な構造」, docs/milestones/M7-polish.md）。
//
// スコープに関する developer 判断（M7）: CodeMirror 6 内部のキーマップ（保存 Mod-s、検索
// Ctrl-F/Ctrl-H 等、@codemirror/search・buildStaticExtensions）はエディタにフォーカスがある間
// エディタ自身が処理する既存の標準的キーバインドであり、実装の複雑化（Compartment 経由の動的
// キーマップ再構築＋競合検出）に見合う要望が無いため、本 M7 では「エディタ外でも効く
// グローバルショートカット」のみを `AppSettings.shortcuts` で設定可能にする（この点は reviewer
// 確認事項として残す）。`Record<string, string>` の値はここで定めるキー文字列表記
// （`Ctrl`/`Shift`/`Alt` の組合せ + 英数字1文字、`+` 区切り）を使う。

/** グローバルショートカットとして設定可能なアクション（`AppSettings.shortcuts` のキー）。 */
export type ShortcutAction = 'globalSearch' | 'toggleTheme' | 'lockCurrentMemo' | 'openSettings';

/** 設定画面に表示するアクション名（日本語ラベル）。 */
export const SHORTCUT_ACTION_LABELS: Record<ShortcutAction, string> = {
  globalSearch: '全文検索を開く',
  toggleTheme: 'テーマ切替（ライト/ダーク）',
  lockCurrentMemo: '開いている暗号化メモをロック',
  openSettings: '設定画面を開く'
};

/** 既定のショートカット（原作 CatMemoNote を参考にした妥当値, PLAN §7 M7）。 */
export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  globalSearch: 'Ctrl+Shift+F',
  toggleTheme: 'Ctrl+Shift+T',
  lockCurrentMemo: 'Ctrl+Shift+L',
  openSettings: 'Ctrl+,'
};

/** `matchesShortcut`/`formatShortcutFromEvent` が扱う修飾キーの正規化順序。 */
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift'] as const;

/**
 * 本モジュールが扱うキーボードイベントの最小形（DOM の `KeyboardEvent` が構造的に満たす形）。
 * `src/shared` はメインプロセス（DOM lib 無し, tsconfig.node.json）からも import されるため、
 * DOM 専用型である `KeyboardEvent` を直接参照せずここで最小限のプロパティのみを定義する
 * （models.ts 冒頭コメント「src/shared 配下は import-safe を維持する規約」に倣う）。
 */
export interface ShortcutKeyEvent {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
}

/** キーボードイベントから本モジュールの表記（例 `Ctrl+Shift+F`）を組み立てる（設定画面の「押して記録」入力用）。 */
export function formatShortcutFromEvent(e: ShortcutKeyEvent): string | null {
  const key = e.key;
  // 修飾キー単体の押下は未確定（Ctrl/Alt/Shift/Meta 単独では組合せとして成立しない）。
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;
  // グローバルショートカットは window 全体の keydown を監視するため（App.tsx）、修飾キー無しの
  // 組合せ（例: 単なる `F`）を許すと、エディタで通常のテキスト入力中に誤発火してしまう。
  // 最低 1 つの修飾キー（Ctrl/Alt/Shift）を必須にする（developer 判断、安全側）。
  if (!e.ctrlKey && !e.altKey && !e.shiftKey) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const mainKey = key.length === 1 ? key.toUpperCase() : key;
  parts.push(mainKey);
  return parts.join('+');
}

interface ParsedShortcut {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

function parseShortcut(shortcut: string): ParsedShortcut | null {
  const segments = shortcut.split('+').map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  const mainKey = segments[segments.length - 1];
  if (mainKey === undefined) return null;
  const modifiers = new Set(segments.slice(0, -1));
  return {
    ctrl: modifiers.has('Ctrl'),
    alt: modifiers.has('Alt'),
    shift: modifiers.has('Shift'),
    key: mainKey.length === 1 ? mainKey.toUpperCase() : mainKey
  };
}

/** キーボードイベントが本モジュール表記のショートカット文字列に一致するか判定する。 */
export function matchesShortcut(e: ShortcutKeyEvent, shortcut: string): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;
  const eventKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return e.ctrlKey === parsed.ctrl && e.altKey === parsed.alt && e.shiftKey === parsed.shift && eventKey === parsed.key;
}

/** 設定画面での表示用に、正規化された表記へ整える（不正な組合せは `null`）。 */
export function normalizeShortcutDisplay(shortcut: string): string | null {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return null;
  const parts: string[] = MODIFIER_ORDER.filter((m) => (m === 'Ctrl' ? parsed.ctrl : m === 'Alt' ? parsed.alt : parsed.shift));
  parts.push(parsed.key);
  return parts.join('+');
}
