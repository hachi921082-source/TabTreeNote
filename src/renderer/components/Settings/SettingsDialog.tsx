// src/renderer/components/Settings/SettingsDialog.tsx
// 設定画面（M7, PLAN §7 M7「設定画面」/ docs/milestones/M7-polish.md）。
//
// 永続化（`settings:set`）は本コンポーネントでは行わず、すべて App.tsx の各 `onChange*` へ
// 委譲する（Tree/TabBar 等、他コンポーネントと同じくファイル操作/設定保存は親経由という既存の
// アーキテクチャ方針に合わせる, PLAN §1.3）。表示内容は AppSettings のうち本フェーズが扱う一式
// （editorDefaults/links/autosave/eol/shortcuts/theme）。
// 「パスワード」セクション（sessionRememberPassword トグル）は、実際のセッション鍵保持ロジック
// に未接続の設定値であったため、ユーザー判断により UI 項目ごと削除した（AppSettings 側の型・
// 既定値・保存/読込ロジックも合わせて削除, M7 仕上げ）。
import type { AppSettings } from '@shared/models';
import { SHORTCUT_ACTION_LABELS, formatShortcutFromEvent, type ShortcutAction } from '@shared/shortcuts';
import type { EditorSettings } from '../../editor/codeMirrorSetup';
import { Modal } from '../dialogs/Modal';

export interface SettingsDialogProps {
  theme: AppSettings['theme'];
  onToggleTheme: () => void;
  /** UI（タブ・ツリー・ボタン・設定画面等、エディタ本文を除く）の文字サイズ倍率。 */
  uiFontScale: AppSettings['uiFontScale'];
  onChangeUiFontScale: (next: number) => void;
  editorSettings: EditorSettings;
  onChangeEditorSettings: (patch: Partial<EditorSettings>) => void;
  linkSettings: AppSettings['links'];
  onChangeLinks: (patch: Partial<AppSettings['links']>) => void;
  autosave: AppSettings['autosave'];
  onChangeAutosave: (patch: Partial<AppSettings['autosave']>) => void;
  eolPolicy: AppSettings['eol']['policy'];
  onChangeEolPolicy: (policy: AppSettings['eol']['policy']) => void;
  shortcuts: Record<string, string>;
  onChangeShortcut: (action: ShortcutAction, value: string) => void;
  /** Windowsログイン時の自動起動（トレイに隠れた状態で常駐, ユーザー要望）。状態はOS側が真実源。 */
  openAtLogin: boolean;
  onChangeOpenAtLogin: (enabled: boolean) => void;
  onClose: () => void;
}

const SHORTCUT_ACTIONS = Object.keys(SHORTCUT_ACTION_LABELS) as ShortcutAction[];

/**
 * 「押して記録」方式の入力欄（一般的なショートカット設定UIの慣習に倣う）。
 * フォーカスしてキーを押すと `onKeyDown` で捕捉し組合せ表記へ変換するため、`readOnly` にして
 * 直接のテキスト編集はさせない（`preventDefault` で大半のキー入力は結果的にブロックされる
 * ため、素の text input のまま自由編集を許可すると挙動が中途半端になるのを避ける, developer 判断）。
 * `readOnly` でもフォーカス・keydown 受信は可能。
 */
function ShortcutInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <input
      className="settings-dialog__shortcut-input"
      type="text"
      value={value}
      readOnly
      onKeyDown={(e) => {
        const formatted = formatShortcutFromEvent(e);
        if (formatted) {
          e.preventDefault();
          onChange(formatted);
        }
      }}
    />
  );
}

export function SettingsDialog({
  theme,
  onToggleTheme,
  uiFontScale,
  onChangeUiFontScale,
  editorSettings,
  onChangeEditorSettings,
  linkSettings,
  onChangeLinks,
  autosave,
  onChangeAutosave,
  eolPolicy,
  onChangeEolPolicy,
  shortcuts,
  onChangeShortcut,
  openAtLogin,
  onChangeOpenAtLogin,
  onClose
}: SettingsDialogProps) {
  return (
    <Modal title="設定" onClose={onClose}>
      <div className="settings-dialog">
        <section className="settings-dialog__section">
          <h3 className="settings-dialog__section-title">起動</h3>
          <label className="settings-dialog__row">
            <span>Windowsログイン時に自動起動する（トレイに常駐）</span>
            <input
              type="checkbox"
              checked={openAtLogin}
              onChange={(e) => onChangeOpenAtLogin(e.target.checked)}
            />
          </label>
        </section>

        <section className="settings-dialog__section">
          <h3 className="settings-dialog__section-title">外観</h3>
          <label className="settings-dialog__row">
            <span>テーマ</span>
            <button type="button" onClick={onToggleTheme}>
              {theme === 'light' ? 'Light（クリックで Dark へ）' : 'Dark（クリックで Light へ）'}
            </button>
          </label>
          <label className="settings-dialog__row">
            <span>UI文字サイズ（タブ・ツリー・ボタン等。エディタ本文は別設定）</span>
            <span>
              <input
                type="number"
                min={80}
                max={150}
                step={5}
                value={Math.round(uiFontScale * 100)}
                onChange={(e) => {
                  const percent = Number(e.target.value);
                  if (Number.isFinite(percent) && percent >= 80 && percent <= 150) {
                    onChangeUiFontScale(percent / 100);
                  }
                }}
              />{' '}
              %
            </span>
          </label>
        </section>

        <section className="settings-dialog__section">
          <h3 className="settings-dialog__section-title">エディタ</h3>
          <label className="settings-dialog__row">
            <span>折り返し</span>
            <select
              value={editorSettings.wrap}
              onChange={(e) => onChangeEditorSettings({ wrap: e.target.value as EditorSettings['wrap'] })}
            >
              <option value="none">なし</option>
              <option value="chars">文字数指定</option>
              <option value="window">ウィンドウ幅</option>
            </select>
          </label>
          <label className="settings-dialog__row">
            <span>タブ幅</span>
            <input
              type="number"
              min={1}
              max={16}
              value={editorSettings.tabWidth}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 1 && n <= 16) onChangeEditorSettings({ tabWidth: n });
              }}
            />
          </label>
          <label className="settings-dialog__row">
            <span>ソフトタブ（スペース挿入）</span>
            <input
              type="checkbox"
              checked={editorSettings.softTab}
              onChange={(e) => onChangeEditorSettings({ softTab: e.target.checked })}
            />
          </label>
          <label className="settings-dialog__row">
            <span>行番号を表示</span>
            <input
              type="checkbox"
              checked={editorSettings.showLineNumbers}
              onChange={(e) => onChangeEditorSettings({ showLineNumbers: e.target.checked })}
            />
          </label>
          <label className="settings-dialog__row">
            <span>空白・改行を可視化</span>
            <input
              type="checkbox"
              checked={editorSettings.showWhitespace}
              onChange={(e) => onChangeEditorSettings({ showWhitespace: e.target.checked })}
            />
          </label>
          <label className="settings-dialog__row">
            <span>カーソル行をハイライト</span>
            <input
              type="checkbox"
              checked={editorSettings.highlightActiveLine}
              onChange={(e) => onChangeEditorSettings({ highlightActiveLine: e.target.checked })}
            />
          </label>
          <label className="settings-dialog__row">
            <span>フォントサイズ（Ctrl+ホイールでも変更可）</span>
            <input
              type="number"
              min={10}
              max={32}
              value={editorSettings.fontSize}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 10 && n <= 32) onChangeEditorSettings({ fontSize: n });
              }}
            />
          </label>
          <label className="settings-dialog__row">
            <span>改行コード</span>
            <select value={eolPolicy} onChange={(e) => onChangeEolPolicy(e.target.value as typeof eolPolicy)}>
              <option value="preserve">読込時のまま維持</option>
              <option value="crlf">常に CRLF で保存</option>
              <option value="lf">常に LF で保存</option>
              <option value="cr">常に CR で保存</option>
            </select>
          </label>
        </section>

        <section className="settings-dialog__section">
          <h3 className="settings-dialog__section-title">自動保存</h3>
          <label className="settings-dialog__row">
            <span>平文メモ（編集停止からの待機時間, ms）</span>
            <input
              type="number"
              min={200}
              max={10000}
              step={100}
              value={autosave.plainDebounceMs}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 200 && n <= 10000) onChangeAutosave({ plainDebounceMs: n });
              }}
            />
          </label>
          <label className="settings-dialog__row">
            <span>暗号化メモ（編集停止からの待機時間, ms）</span>
            <input
              type="number"
              min={1000}
              max={60000}
              step={500}
              value={autosave.encryptedDebounceMs}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 1000 && n <= 60000) onChangeAutosave({ encryptedDebounceMs: n });
              }}
            />
          </label>
        </section>

        <section className="settings-dialog__section">
          <h3 className="settings-dialog__section-title">リンク</h3>
          <label className="settings-dialog__row">
            <span>クリック操作</span>
            <select
              value={linkSettings.openTrigger}
              onChange={(e) => onChangeLinks({ openTrigger: e.target.value as AppSettings['links']['openTrigger'] })}
            >
              <option value="ctrlClick">Ctrl+クリック</option>
              <option value="singleClick">シングルクリック</option>
              <option value="doubleClick">ダブルクリック</option>
            </select>
          </label>
          <label className="settings-dialog__row">
            <span>開く前に確認する</span>
            <input
              type="checkbox"
              checked={linkSettings.confirmBeforeOpen}
              onChange={(e) => onChangeLinks({ confirmBeforeOpen: e.target.checked })}
            />
          </label>
        </section>

        <section className="settings-dialog__section">
          <h3 className="settings-dialog__section-title">ショートカット</h3>
          <p className="settings-dialog__hint">
            入力欄をクリックして新しいキーの組合せを押すと記録されます。CodeMirror
            エディタ内蔵のショートカット（保存 Ctrl+S、検索 Ctrl+F 等）は対象外です。
          </p>
          {SHORTCUT_ACTIONS.map((action) => (
            <label className="settings-dialog__row" key={action}>
              <span>{SHORTCUT_ACTION_LABELS[action]}</span>
              <ShortcutInput value={shortcuts[action] ?? ''} onChange={(value) => onChangeShortcut(action, value)} />
            </label>
          ))}
        </section>

        <div className="settings-dialog__actions">
          <button type="button" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </Modal>
  );
}
