// src/renderer/components/StatusBar/StatusBar.tsx
// ステータスバー（DESIGN §2.3「文字数/行数/カーソル位置をステータスバーに表示」/ §2.7、M7）。
// App.tsx に直書きされていた表示を、PLAN §3 のディレクトリ構成
// （`src/renderer/components/StatusBar/`）に合わせて独立コンポーネント化した（M7, developer 判断。
// 表示内容自体は M0〜M6 で既に実装済みのものをそのまま移設し、設定画面を開くボタンのみ追加）。
import type { AppInfo } from '@shared/ipc-contract';
import type { EditorStats } from '../../editor/codeMirrorSetup';

export interface StatusBarProps {
  theme: 'light' | 'dark';
  appInfo: AppInfo | null;
  editorStats: EditorStats | null;
  fontSize: number;
  statusMessage: string | null;
  onOpenSettings: () => void;
}

export function StatusBar({ theme, appInfo, editorStats, fontSize, statusMessage, onOpenSettings }: StatusBarProps) {
  return (
    <div className="app__statusbar">
      <button type="button" className="app__statusbar-settings-button" onClick={onOpenSettings} title="設定">
        ⚙ 設定
      </button>
      <span>Theme: {theme}</span>
      <span>{appInfo ? `v${appInfo.appVersion} / schema ${appInfo.schemaVersion}` : 'app:getInfo 応答待ち…'}</span>
      {editorStats && (
        <span className="app__statusbar-editor-stats">
          {editorStats.charCount} 文字 / {editorStats.lineCount} 行 / 行 {editorStats.cursorLine}, 列{' '}
          {editorStats.cursorColumn}
          {editorStats.selectedCharCount > 0 ? ` (選択 ${editorStats.selectedCharCount} 文字)` : ''} / フォント{' '}
          {fontSize}px
        </span>
      )}
      {statusMessage && <span className="app__statusbar-message">{statusMessage}</span>}
    </div>
  );
}
