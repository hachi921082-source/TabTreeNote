// src/renderer/editor/checkboxClick.ts
// 行頭チェックボックス（☐/☑）を直接クリックしてチェック状態を切り替える拡張（ユーザー要望）。
// 右クリックメニュー「チェック」（textCommands.ts の toggleCheckbox）はチェックボックスの
// 追加/削除（なし→☐→☑→なし）を担当し、こちらは既に付いているチェックボックスの ☐⇄☑ の
// 2状態切替のみを担当する（実際のチェックボックスUIのような挙動にする, developer 判断）。
import { EditorView } from '@codemirror/view';
import { CHECKBOX_CHECKED, CHECKBOX_UNCHECKED } from './textCommands';

export function buildCheckboxClickExtension() {
  return EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (event.button !== 0) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const line = view.state.doc.lineAt(pos);
      const prefix = line.text.startsWith(CHECKBOX_CHECKED)
        ? CHECKBOX_CHECKED
        : line.text.startsWith(CHECKBOX_UNCHECKED)
          ? CHECKBOX_UNCHECKED
          : null;
      if (!prefix || pos > line.from + prefix.length) return false;

      event.preventDefault();
      const insert = prefix === CHECKBOX_UNCHECKED ? CHECKBOX_CHECKED : CHECKBOX_UNCHECKED;
      view.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert } });
      return true;
    }
  });
}
