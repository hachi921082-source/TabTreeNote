// src/renderer/components/dialogs/PasswordDialog.tsx
// パスワード入力ダイアログ（設定/解除/開封/変更の4モードを1コンポーネントで扱う, M6,
// docs/milestones/M6-crypto.md「確認再入力・ヒント表示・警告」/ DESIGN §2.9）。
import { useState, type FormEvent } from 'react';
import { Modal } from './Modal';

export type PasswordDialogMode =
  | 'setup'
  | 'unlockToOpen'
  | 'unlockToDecrypt'
  | 'changePassword'
  // v3 M8: ノードロック（既存M6暗号化ダイアログの見た目・確認再入力ルールを流用, DESIGNv3 §1.11）。
  | 'lockNode'
  | 'unlockNode'
  /**
   * v3 §1.14: ロックの恒久的解除（不可逆。既存 `unlockNode`「ロックを解除」とは別操作、
   * `docs/v3/DESIGNv3.md` §1.14）。呼び出し元（App.tsx）が事前に不可逆性の確認ダイアログ
   * （`ConfirmDialog`）を経由済みの前提で、本モードは既存 `unlockNode` と同じパスワード入力
   * フォーム形状（既にセッションが張られていても再入力を要求し、セッション鍵は使い回さない）。
   */
  | 'removeNodeLock';

export interface PasswordDialogSubmitValues {
  password?: string;
  oldPassword?: string;
  newPassword?: string;
  hint?: string;
}

interface PasswordDialogProps {
  mode: PasswordDialogMode;
  memoName: string;
  /** 直近の失敗結果（DECRYPT_FAILED 等）のメッセージ。main 側でヒントが付与されていれば含む。 */
  errorMessage?: string | null;
  onCancel: () => void;
  onSubmit: (values: PasswordDialogSubmitValues) => void;
}

const TITLES: Record<PasswordDialogMode, string> = {
  setup: 'パスワードを設定して暗号化',
  unlockToOpen: 'パスワードを入力',
  unlockToDecrypt: '暗号化を解除',
  changePassword: 'パスワードを変更',
  lockNode: 'パスワードを設定してサブツリーをロック',
  unlockNode: 'ロックを解除',
  removeNodeLock: 'ロックを完全に解除する'
};

const SUBMIT_LABELS: Record<PasswordDialogMode, string> = {
  setup: '暗号化する',
  unlockToOpen: '開く',
  unlockToDecrypt: '解除する',
  changePassword: '変更する',
  lockNode: 'ロックする',
  unlockNode: '解除する',
  removeNodeLock: '完全に解除する'
};

/** 忘失時は復旧不能（バックドア/マスターキーは無い）ことの警告文（DESIGN §2.9）。 */
const FORGOTTEN_PASSWORD_WARNING =
  'パスワードを忘れると復旧できません（バックドアやマスターキーはありません）。';

export function PasswordDialog({ mode, memoName, errorMessage, onCancel, onSubmit }: PasswordDialogProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [hint, setHint] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');

  // v3 M8: lockNode は setup（新規パスワード+確認再入力+ヒント）と、unlockNode は
  // unlockToOpen/unlockToDecrypt（パスワードのみ）と同じ入力フォーム形状を流用する
  // （既存M6暗号化ダイアログの見た目・確認再入力ルールを流用, DESIGNv3 §1.11）。
  const isSetup = mode === 'setup' || mode === 'lockNode';
  const isChangePassword = mode === 'changePassword';
  const isUnlock = mode === 'unlockToOpen' || mode === 'unlockToDecrypt' || mode === 'unlockNode' || mode === 'removeNodeLock';

  const setupMismatch = isSetup && confirmPassword.length > 0 && password !== confirmPassword;
  const changeMismatch = isChangePassword && confirmNewPassword.length > 0 && newPassword !== confirmNewPassword;

  const canSubmit = isSetup
    ? password.length > 0 && password === confirmPassword
    : isChangePassword
      ? oldPassword.length > 0 && newPassword.length > 0 && newPassword === confirmNewPassword
      : password.length > 0;

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (!canSubmit) return;
    if (isSetup) {
      onSubmit({ password, hint: hint.trim().length > 0 ? hint.trim() : undefined });
    } else if (isChangePassword) {
      onSubmit({ oldPassword, newPassword });
    } else {
      onSubmit({ password });
    }
  };

  return (
    <Modal title={TITLES[mode]} onClose={onCancel}>
      <form className="password-dialog" onSubmit={handleSubmit}>
        {/* v3 M8/§1.14: unlockNode/removeNodeLock の memoName は内部の難読化トークン
            （意味の無いランダム文字列）のため、ユーザーには表示しない
            （DESIGNv3 §1.2「🔒以外の情報を一切見せない」）。 */}
        <p className="password-dialog__memo-name">
          {mode === 'unlockNode' || mode === 'removeNodeLock' ? '対象: 🔒 (ロック中)' : `対象メモ: ${memoName}`}
        </p>
        {mode === 'removeNodeLock' && (
          <p className="password-dialog__warning">
            ※ この操作は取り消せません。配下のすべてのメモが二度と保護されない通常の状態に戻ります。
          </p>
        )}

        {isUnlock && (
          <>
            <label className="password-dialog__label" htmlFor="password-dialog-password">
              パスワード
            </label>
            <input
              id="password-dialog-password"
              className="password-dialog__input"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        )}

        {isSetup && (
          <>
            <label className="password-dialog__label" htmlFor="password-dialog-password">
              新しいパスワード
            </label>
            <input
              id="password-dialog-password"
              className="password-dialog__input"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <label className="password-dialog__label" htmlFor="password-dialog-confirm">
              パスワード（確認再入力）
            </label>
            <input
              id="password-dialog-confirm"
              className="password-dialog__input"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
            {setupMismatch && <p className="password-dialog__message">※ パスワードが一致しません。</p>}
            <label className="password-dialog__label" htmlFor="password-dialog-hint">
              パスワードヒント（任意）
            </label>
            <input
              id="password-dialog-hint"
              className="password-dialog__input"
              type="text"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
            />
            <p className="password-dialog__warning">
              ※ ヒントはファイル内に平文のまま保存されます（暗号化されません）。
            </p>
          </>
        )}

        {isChangePassword && (
          <>
            <label className="password-dialog__label" htmlFor="password-dialog-old">
              現在のパスワード
            </label>
            <input
              id="password-dialog-old"
              className="password-dialog__input"
              type="password"
              autoFocus
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
            />
            <label className="password-dialog__label" htmlFor="password-dialog-new">
              新しいパスワード
            </label>
            <input
              id="password-dialog-new"
              className="password-dialog__input"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <label className="password-dialog__label" htmlFor="password-dialog-new-confirm">
              新しいパスワード（確認再入力）
            </label>
            <input
              id="password-dialog-new-confirm"
              className="password-dialog__input"
              type="password"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
            />
            {changeMismatch && <p className="password-dialog__message">※ パスワードが一致しません。</p>}
          </>
        )}

        {(isSetup || isChangePassword) && <p className="password-dialog__warning">※ {FORGOTTEN_PASSWORD_WARNING}</p>}

        {errorMessage && <p className="password-dialog__error">{errorMessage}</p>}

        <div className="password-dialog__actions">
          <button type="button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" disabled={!canSubmit}>
            {SUBMIT_LABELS[mode]}
          </button>
        </div>
      </form>
    </Modal>
  );
}
