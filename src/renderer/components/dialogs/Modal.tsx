// src/renderer/components/dialogs/Modal.tsx
// 汎用モーダルシェル（NameInputDialog/ConfirmDialog が共用する外枠）。
import type { MouseEvent as ReactMouseEvent, PropsWithChildren } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
}

export function Modal({ title, onClose, children }: PropsWithChildren<ModalProps>) {
  const stopPropagation = (e: ReactMouseEvent): void => e.stopPropagation();

  return (
    <div className="modal-overlay" onClick={onClose}>
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
