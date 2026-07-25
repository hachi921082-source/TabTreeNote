// src/renderer/components/dialogs/Modal.tsx
// 汎用モーダルシェル（NameInputDialog/ConfirmDialog が共用する外枠）。
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PropsWithChildren } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
}

export function Modal({ title, onClose, children }: PropsWithChildren<ModalProps>) {
  const stopPropagation = (e: ReactMouseEvent): void => e.stopPropagation();
  // Esc でキャンセル（呼び出し元は onClose=onCancel を渡す想定, ユーザー要望）。明示的な選択を
  // 求めるダイアログ（ConflictDialog 等）は onClose に no-op を渡すことで Esc を無効化できる。
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="modal" onClick={stopPropagation} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__header">
          <span className="modal__title">{title}</span>
          <button type="button" className="modal__close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}
