// src/renderer/editor/codeMirrorSetup.ts
// CodeMirror 6 拡張構成（M3-①「CodeMirror 6 統合」, DESIGN §2.3/§2.4/§6）。
//
// 方針: `codemirror` メタパッケージ（basicSetup、コード補完・foldGutter 等コード編集向けの
// 機能を多く含む）は使わず、プレーンテキストメモに必要な機能だけを個別パッケージから組み立てる。
// 折り返し種別・タブ幅/ソフトタブ・行番号表示・空白可視化・フォントサイズは Compartment 化し、
// 実行時に再設定できるようにする（M7 の設定 UI から呼べる形にしておく。今回 M3-① の時点では
// UI は無く、AppSettings.editorDefaults の既定値を適用するのみ）。
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightTrailingWhitespace,
  highlightWhitespace,
  keymap,
  lineNumbers,
  rectangularSelection
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentLess, insertNewlineKeepIndent, insertTab } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import type { AppSettings } from '@shared/models';

/** 'chars'（文字数指定）折り返し時の既定幅。M7 で設定可能な数値項目を追加するまでの固定値
 * （AppSettings/MemoEditorSettings に文字数フィールドが無いため、data-model.md 未変更の
 * 範囲で developer 判断の既定値として扱う）。 */
export const DEFAULT_WRAP_CHARS = 80;

export const FONT_FAMILY = "'Consolas', 'Yu Gothic UI', monospace";

/** CodeMirror 側で扱うエディタ設定（AppSettings.editorDefaults ＋メモ毎上書きをマージ済みの値）。 */
export interface EditorSettings {
  wrap: AppSettings['editorDefaults']['wrap'];
  tabWidth: number;
  softTab: boolean;
  showLineNumbers: boolean;
  fontSize: number;
  /** 空白/改行の可視化トグル（M7 で設定画面から配線。既定 off, data-model.md に永続フィールド
   * 無しのためセッション内のみの設定として扱う, developer 判断）。 */
  showWhitespace: boolean;
  /** カーソル行ハイライトトグル（M7 で設定画面から配線。既定 on, data-model.md に永続フィールド
   * 無しのためセッション内のみの設定として扱う, developer 判断。DESIGN §2.3）。 */
  highlightActiveLine: boolean;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  wrap: 'window',
  tabWidth: 4,
  softTab: true,
  showLineNumbers: true,
  fontSize: 14,
  showWhitespace: false,
  highlightActiveLine: true
};

/** 再設定可能な項目ごとの Compartment。CodeMirrorEditor がインスタンスごとに新規生成する。 */
export interface EditorCompartments {
  wrap: Compartment;
  indent: Compartment;
  lineNumbers: Compartment;
  whitespace: Compartment;
  font: Compartment;
  activeLine: Compartment;
  /** 外部変更競合ダイアログ表示中のエディタ入力ロック用（M4, DESIGN §3.3「解決中ロック」）。 */
  readOnly: Compartment;
}

export function createCompartments(): EditorCompartments {
  return {
    wrap: new Compartment(),
    indent: new Compartment(),
    lineNumbers: new Compartment(),
    whitespace: new Compartment(),
    font: new Compartment(),
    activeLine: new Compartment(),
    readOnly: new Compartment()
  };
}

function buildWrapExtension(wrap: EditorSettings['wrap']): Extension {
  if (wrap === 'none') return [];
  if (wrap === 'window') return [EditorView.lineWrapping];
  // 'chars': 文字数指定折り返し。列数ベースの折り返しを厳密に実装する専用 API は無いため、
  // 等幅フォント前提で `.cm-content` の最大幅を ch 単位で制限する近似実装（既定値で動作すればよい, PLAN範囲）。
  return [EditorView.lineWrapping, EditorView.theme({ '.cm-content': { maxWidth: `${DEFAULT_WRAP_CHARS}ch` } })];
}

function buildIndentExtension(tabWidth: number, softTab: boolean): Extension {
  return [indentUnit.of(softTab ? ' '.repeat(tabWidth) : '\t'), EditorState.tabSize.of(tabWidth)];
}

function buildLineNumbersExtension(show: boolean): Extension {
  return show ? [lineNumbers(), highlightActiveLineGutter()] : [];
}

function buildWhitespaceExtension(show: boolean): Extension {
  return show ? [highlightWhitespace(), highlightTrailingWhitespace()] : [];
}

/** カーソル行ハイライト（本文側のみ。ガター側は showLineNumbers と連動したままにする）。 */
function buildActiveLineExtension(enabled: boolean): Extension {
  return enabled ? [highlightActiveLine()] : [];
}

function buildFontExtension(fontSize: number): Extension {
  return EditorView.theme({
    '&': { fontSize: `${fontSize}px` },
    '.cm-content': { fontFamily: FONT_FAMILY },
    '.cm-gutters': { fontFamily: FONT_FAMILY }
  });
}

/** 現在の設定値から各 Compartment の初期内容を構築する（EditorState.create 用）。 */
export function initialCompartmentExtensions(compartments: EditorCompartments, settings: EditorSettings): Extension[] {
  return [
    compartments.wrap.of(buildWrapExtension(settings.wrap)),
    compartments.indent.of(buildIndentExtension(settings.tabWidth, settings.softTab)),
    compartments.lineNumbers.of(buildLineNumbersExtension(settings.showLineNumbers)),
    compartments.whitespace.of(buildWhitespaceExtension(settings.showWhitespace)),
    compartments.font.of(buildFontExtension(settings.fontSize)),
    compartments.activeLine.of(buildActiveLineExtension(settings.highlightActiveLine))
  ];
}

/** 設定変更を既存 EditorView へ反映する（reconfigure）。M7 の設定 UI からも呼べる想定。 */
export function reconfigureEditorSettings(view: EditorView, compartments: EditorCompartments, settings: EditorSettings): void {
  view.dispatch({
    effects: [
      compartments.wrap.reconfigure(buildWrapExtension(settings.wrap)),
      compartments.indent.reconfigure(buildIndentExtension(settings.tabWidth, settings.softTab)),
      compartments.lineNumbers.reconfigure(buildLineNumbersExtension(settings.showLineNumbers)),
      compartments.whitespace.reconfigure(buildWhitespaceExtension(settings.showWhitespace)),
      compartments.font.reconfigure(buildFontExtension(settings.fontSize)),
      compartments.activeLine.reconfigure(buildActiveLineExtension(settings.highlightActiveLine))
    ]
  });
}

/** 読み取り専用切替の拡張（M4: 外部変更競合ダイアログ表示中のエディタ入力ロック, DESIGN §3.3）。 */
export function buildReadOnlyExtension(readOnly: boolean): Extension {
  return [EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)];
}

/**
 * `readOnly` のみを既存 EditorView へ反映する（M4）。`reconfigureEditorSettings` とは独立した
 * Compartment のため、他設定の reconfigure と競合しない。
 */
export function reconfigureReadOnly(view: EditorView, compartments: EditorCompartments, readOnly: boolean): void {
  view.dispatch({ effects: compartments.readOnly.reconfigure(buildReadOnlyExtension(readOnly)) });
}

/** カーソル位置/選択範囲から文字数・行数・カーソル行列を計算する（ステータスバー表示用, DESIGN §2.3）。 */
export interface EditorStats {
  charCount: number;
  lineCount: number;
  cursorLine: number;
  cursorColumn: number;
  selectedCharCount: number;
}

export function computeEditorStats(state: EditorState): EditorStats {
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);
  return {
    charCount: state.doc.length,
    lineCount: state.doc.lines,
    cursorLine: line.number,
    cursorColumn: range.head - line.from + 1,
    selectedCharCount: range.to - range.from
  };
}

/** 静的（メモ切り替えでも変わらない）拡張一式。呼び出し側が Compartment 由来の可変拡張と結合する。
 * `onChange`/`onStats` は `view.dispatch` のたびに最新の doc/stats を呼び出し元へ通知する
 * （EditorView は本コンポーネント内でメモ毎に作り直す＝Undo履歴もリセットされる, DESIGN §2.3）。 */
export function buildStaticExtensions(onChange: (contentLF: string) => void, onStats: (stats: EditorStats) => void, onSave: () => void): Extension[] {
  const saveKeymap = keymap.of([
    {
      key: 'Mod-s',
      run: (): boolean => {
        onSave();
        return true;
      }
    }
  ]);

  // Enter で直前行のインデントを引き継ぐ（オートインデント, DESIGN §2.3）。defaultKeymap の
  // Enter（挿入のみ）より優先させるため Prec.highest。
  const autoIndentKeymap = Prec.highest(keymap.of([{ key: 'Enter', run: insertNewlineKeepIndent }]));

  const tabKeymap = keymap.of([
    { key: 'Tab', run: insertTab },
    { key: 'Shift-Tab', run: indentLess }
  ]);

  return [
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    EditorState.allowMultipleSelections.of(true),
    search({ top: true }),
    saveKeymap,
    autoIndentKeymap,
    tabKeymap,
    keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
      if (update.docChanged || update.selectionSet) onStats(computeEditorStats(update.state));
    })
  ];
}

/** メモを開いた直後の初期選択（カーソルを先頭へ）。 */
export const INITIAL_SELECTION = EditorSelection.cursor(0);
