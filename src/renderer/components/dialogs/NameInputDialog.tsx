// src/renderer/components/dialogs/NameInputDialog.tsx
// タブ/メモの新規作成・リネーム名入力ダイアログ。DESIGN §3.1 UX（即時バリデーション + `/` 等の
// 置換候補ワンクリック提示）を満たす（00-core-principles.md §11）。
// メイン側の最終検証（`pathSafety.validateName`）は IPC 呼び出し側で必ず行われるため、本コンポーネントは
// あくまで UX 上の即時フィードバックとして `validateNameLive` を使う（フェイルセーフの二重検証）。
import { useState, type FormEvent } from 'react';
import { suggestSanitizedName, validateNameLive } from '@shared/nameSanitize';
import { Modal } from './Modal';

interface NameInputDialogProps {
  title: string;
  label: string;
  initialValue?: string;
  submitLabel?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

export function NameInputDialog({
  title,
  label,
  initialValue = '',
  submitLabel = 'OK',
  onSubmit,
  onCancel
}: NameInputDialogProps) {
  const [value, setValue] = useState(initialValue);
  const validation = validateNameLive(value);
  const suggestion = suggestSanitizedName(value);

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (!validation.ok) return;
    onSubmit(value);
  };

  return (
    <Modal title={title} onClose={onCancel}>
      <form className="name-dialog" onSubmit={handleSubmit}>
        <label className="name-dialog__label" htmlFor="name-dialog-input">
          {label}
        </label>
        <input
          id="name-dialog-input"
          className="name-dialog__input"
          type="text"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {validation.message && <p className="name-dialog__message">※ {validation.message}</p>}
        {suggestion && (
          <button type="button" className="name-dialog__suggestion" onClick={() => setValue(suggestion)}>
            「{suggestion}」に修正する
          </button>
        )}
        <div className="name-dialog__actions">
          <button type="button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" disabled={!validation.ok}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
