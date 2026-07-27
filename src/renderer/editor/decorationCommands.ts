// src/renderer/editor/decorationCommands.ts
// v3 M10b: 文字色/太字/文字サイズの装飾コマンド（右クリックメニュー, DESIGNv3 §2.2、
// docs/v3/milestones/M10b-markdown-live-preview.md「Markdown装飾コマンド実行フロー」）。
//
// 既存 `src/renderer/editor/textCommands.ts` と同じパターン（CodeMirror の `changeByRange` で
// 選択範囲を変換、1操作=1トランザクション=Undo1回, DESIGNv3 §2.2）で実装する。選択範囲を
// `<span style="...">...</span>` でラップ/アンラップする。既に選択範囲全体がぴったり
// `<span style="...">` 〜 `</span>` で囲まれている場合は「タグの中身を編集する」= 既存styleへ
// プロパティを足す/同値なら外す（トグル）、全プロパティが無くなればタグごと除去（アンラップ）。
import { EditorSelection, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { MarkdownDecorationCommand } from '@shared/ipc-contract';

type StyleProp = 'color' | 'font-weight' | 'font-size';

function parseStyle(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const decl of raw.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (prop && value) map.set(prop, value);
  }
  return map;
}

function serializeStyle(map: ReadonlyMap<string, string>): string {
  return [...map.entries()].map(([k, v]) => `${k}: ${v}`).join('; ');
}

interface SurroundingSpan {
  openFrom: number;
  openTo: number;
  closeFrom: number;
  closeTo: number;
  style: string;
}

const OPEN_TAIL_PATTERN = /<span style="([^"<>]*)">$/;
const CLOSE_TAG = '</span>';
/** 開始タグ検出のために選択範囲の直前を遡って調べる最大文字数（1行分あれば通常十分）。 */
const LOOKBEHIND_WINDOW = 2000;

/**
 * 選択範囲（`from`〜`to`）の直前直後が正確に `<span style="...">` / `</span>` で囲まれているか
 * 検出する（既存の丸ごとラップの検出。ネストしたspanの厳密な構文解析は行わない簡易実装で足りる,
 * developer判断）。
 */
function detectSurroundingSpan(state: EditorState, from: number, to: number): SurroundingSpan | null {
  const before = state.sliceDoc(Math.max(0, from - LOOKBEHIND_WINDOW), from);
  const openMatch = OPEN_TAIL_PATTERN.exec(before);
  if (!openMatch) return null;
  const openTagText = openMatch[0];
  const style = openMatch[1] ?? '';

  const after = state.sliceDoc(to, Math.min(state.doc.length, to + CLOSE_TAG.length));
  if (after !== CLOSE_TAG) return null;

  return {
    openFrom: from - openTagText.length,
    openTo: from,
    closeFrom: to,
    closeTo: to + CLOSE_TAG.length,
    style
  };
}

/**
 * 選択範囲に `prop: value` を適用/トグルする。`explicitClear` が true の場合は既存値と一致するか
 * 問わず常にそのプロパティを除去する（メニューの「解除」項目用）。
 */
function applyOrToggleSpanStyle(view: EditorView, prop: StyleProp, value: string, explicitClear: boolean): boolean {
  const { state } = view;
  let changed = false;
  const spec = state.changeByRange((range) => {
    if (range.empty) return { range };
    const selectedText = state.sliceDoc(range.from, range.to);
    const wrap = detectSurroundingSpan(state, range.from, range.to);

    const styleMap = wrap ? parseStyle(wrap.style) : new Map<string, string>();
    const shouldRemove = explicitClear || styleMap.get(prop) === value;
    if (shouldRemove) {
      styleMap.delete(prop);
    } else {
      styleMap.set(prop, value);
    }
    const nextStyle = serializeStyle(styleMap);

    if (wrap) {
      changed = true;
      if (!nextStyle) {
        // 全プロパティが無くなった＝タグごと除去（アンラップ）。
        return {
          changes: [
            { from: wrap.openFrom, to: wrap.openTo, insert: '' },
            { from: wrap.closeFrom, to: wrap.closeTo, insert: '' }
          ],
          range: EditorSelection.range(wrap.openFrom, wrap.openFrom + selectedText.length)
        };
      }
      const newOpenTag = `<span style="${nextStyle}">`;
      return {
        changes: { from: wrap.openFrom, to: wrap.openTo, insert: newOpenTag },
        range: EditorSelection.range(wrap.openFrom + newOpenTag.length, wrap.openFrom + newOpenTag.length + selectedText.length)
      };
    }

    if (!nextStyle) {
      // ラップされておらず、かつ「解除」操作 → 何もしない。
      return { range };
    }
    changed = true;
    const openTag = `<span style="${nextStyle}">`;
    const insertText = `${openTag}${selectedText}${CLOSE_TAG}`;
    return {
      changes: { from: range.from, to: range.to, insert: insertText },
      range: EditorSelection.range(range.from + openTag.length, range.from + openTag.length + selectedText.length)
    };
  });

  if (!changed) return false;
  view.dispatch(state.update(spec));
  return true;
}

/** `evt:editorMenuCommand`（`kind:'decoration'`）を受けて実行する（App.tsx から呼ばれる）。 */
export function runDecorationCommand(view: EditorView, cmd: MarkdownDecorationCommand): void {
  switch (cmd.command) {
    case 'color':
      applyOrToggleSpanStyle(view, 'color', cmd.value, cmd.value === '');
      break;
    case 'bold':
      applyOrToggleSpanStyle(view, 'font-weight', 'bold', false);
      break;
    case 'fontSize':
      applyOrToggleSpanStyle(view, 'font-size', cmd.value, cmd.value === '');
      break;
  }
  view.focus();
}
