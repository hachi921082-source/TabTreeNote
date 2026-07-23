// src/renderer/components/dialogs/ConflictDialog.tsx
// 外部変更との競合解決ダイアログ（M4, DESIGN §3.3「外部編集との競合」）。
// 編集中（未保存の変更がある）メモに対して外部からの変更を検知した場合に表示する。
// 表示中は呼び出し側（App.tsx）がエディタ入力・保存を一時ロックする（解決中ロック, DESIGN §3.3）。
import { Modal } from './Modal';

interface ConflictDialogProps {
  memoName: string;
  /** 自分の変更を保存し、外部の変更を破棄する（`expectedHash` 無しで強制上書き保存）。 */
  onKeepMine: () => void;
  /** 外部の変更を採用し、自分の変更を破棄する（再読込。外部で削除済みならメモを閉じる）。 */
  onAdoptExternal: () => void;
}

export function ConflictDialog({ memoName, onKeepMine, onAdoptExternal }: ConflictDialogProps) {
  return (
    // 明示的な選択を求めるため、オーバーレイクリック/×クローズでは何も解決しない
    // （先祖返り・意図しない破棄を避ける。DESIGN §3.3「解決中ロック」の趣旨に沿う）。
    <Modal title="外部変更との競合" onClose={() => undefined}>
      <div className="confirm-dialog">
        <p className="confirm-dialog__message">
          「{memoName}」は編集中に外部（他のアプリ等）で変更されました。
          {'\n'}どちらの内容を反映するか選択してください。
        </p>
        <div className="confirm-dialog__actions">
          <button type="button" onClick={onAdoptExternal}>
            外部の変更を採用（自分の変更を破棄）
          </button>
          <button
            type="button"
            className="confirm-dialog__confirm confirm-dialog__confirm--danger"
            onClick={onKeepMine}
          >
            自分の変更を保存（外部の変更を破棄）
          </button>
        </div>
      </div>
    </Modal>
  );
}
