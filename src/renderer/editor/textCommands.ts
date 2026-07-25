// src/renderer/editor/textCommands.ts
// エディタ右クリックメニューの「変換」「元に戻す」「チェック」コマンド実装（ユーザー要望）。
// CodeMirror の Undo 履歴・選択範囲は CodeMirror 自身の内部状態であり、Electron のネイティブ
// メニューロール（role: 'undo' 等）はブラウザ既定の編集コマンドを発火するだけで CodeMirror の
// 状態とは同期しない（壊れる）ため、必ず CodeMirror の State/Command API 経由で実装すること。
import { redo as cmRedo, undo as cmUndo } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { EditorTextCommand } from '@shared/ipc-contract';

type CmCommand = (view: EditorView) => boolean;

/** 選択範囲ごとに文字列変換を適用する（複数選択対応）。選択が空の範囲は変更しない。 */
function transformSelections(fn: (text: string) => string): CmCommand {
  return (view) => {
    const { state } = view;
    let changed = false;
    const spec = state.changeByRange((range) => {
      if (range.empty) return { range };
      const text = state.sliceDoc(range.from, range.to);
      const next = fn(text);
      if (next === text) return { range };
      changed = true;
      return {
        changes: { from: range.from, to: range.to, insert: next },
        range: EditorSelection.range(range.from, range.from + next.length)
      };
    });
    if (!changed) return false;
    view.dispatch(state.update(spec));
    return true;
  };
}

/** Delete/Backspace 相当だがロールは使わず自前実装（選択が全て空なら何もしない）。 */
const deleteSelection: CmCommand = (view) => {
  const { state } = view;
  let changed = false;
  const spec = state.changeByRange((range) => {
    if (range.empty) return { range };
    changed = true;
    return { changes: { from: range.from, to: range.to }, range: EditorSelection.cursor(range.from) };
  });
  if (!changed) return false;
  view.dispatch(state.update(spec));
  return true;
};

function invertCase(text: string): string {
  return text.replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
}

/** カタカナ→ひらがな（U+30A1-U+30F6 を -0x60）。長音記号(ー)等の対象外文字はそのまま。 */
function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** ひらがな→カタカナ（U+3041-U+3096 を +0x60）。 */
function toKatakana(text: string): string {
  return text.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

/** 全角英数・記号→半角（範囲は英数字・記号のみ。カタカナは対象外, ユーザー判断）。 */
function toHalfWidth(text: string): string {
  return text
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

/** 半角英数・記号→全角（範囲は英数字・記号のみ）。 */
function toFullWidth(text: string): string {
  return text.replace(/[\x21-\x7e]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/ /g, '　');
}

function tabsToSpaces(view: EditorView): boolean {
  const tabWidth = view.state.facet(EditorState.tabSize);
  return transformSelections((s) => s.replace(/\t/g, ' '.repeat(tabWidth)))(view);
}

function spacesToTabs(view: EditorView): boolean {
  const tabWidth = view.state.facet(EditorState.tabSize);
  return transformSelections((s) => s.replace(new RegExp(' '.repeat(tabWidth), 'g'), '\t'))(view);
}

/** editor/checkboxClick.ts（本文クリックでの直接トグル）とも共有する記号定義。 */
export const CHECKBOX_UNCHECKED = '☐ ';
export const CHECKBOX_CHECKED = '☑ ';

/**
 * 選択範囲が触れている各行の先頭チェックボックスをトグルする（ユーザー要望「チェック」）。
 * なし→未チェック→チェック済み→なし、と巡回する。
 */
const toggleCheckbox: CmCommand = (view) => {
  const { state } = view;
  const lineNumbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number;
    const endLine = state.doc.lineAt(range.to).number;
    for (let n = startLine; n <= endLine; n++) lineNumbers.add(n);
  }
  const changes = [...lineNumbers].map((n) => {
    const line = state.doc.line(n);
    if (line.text.startsWith(CHECKBOX_UNCHECKED)) {
      return { from: line.from, to: line.from + CHECKBOX_UNCHECKED.length, insert: CHECKBOX_CHECKED };
    }
    if (line.text.startsWith(CHECKBOX_CHECKED)) {
      return { from: line.from, to: line.from + CHECKBOX_CHECKED.length, insert: '' };
    }
    return { from: line.from, to: line.from, insert: CHECKBOX_UNCHECKED };
  });
  if (changes.length === 0) return false;
  view.dispatch({ changes });
  return true;
};

const TEXT_COMMANDS: Record<EditorTextCommand, CmCommand> = {
  undo: cmUndo,
  redo: cmRedo,
  deleteSelection,
  invertCase: transformSelections(invertCase),
  toUpperCase: transformSelections((s) => s.toUpperCase()),
  toLowerCase: transformSelections((s) => s.toLowerCase()),
  toHiragana: transformSelections(toHiragana),
  toKatakana: transformSelections(toKatakana),
  toHalfWidth: transformSelections(toHalfWidth),
  toFullWidth: transformSelections(toFullWidth),
  tabsToSpaces,
  spacesToTabs,
  toggleCheckbox
};

/** `command` に対応する CodeMirror コマンドを実行し、実行後にエディタへフォーカスを戻す。 */
export function runTextCommand(view: EditorView, command: EditorTextCommand): void {
  TEXT_COMMANDS[command](view);
  view.focus();
}
