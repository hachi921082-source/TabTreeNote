// src/renderer/components/Editor/MarkdownToolbar.tsx
// v3 M10c: ライブプレビュー編集中専用のツールバー（DESIGNv3 §2.2「右クリックに気づかない人向け」、
// docs/v3/milestones/M10c-markdown-toolbar-ui.md）。`.md`メモを開いている間のみ App.tsx が表示する。
//
// 配置・ボタン構成は developer 裁量（milestone doc記載通り）。ソース/プレビュー切替と
// `.md`→`.txt`変換（`.txt`→`.md`は既に`.md`のこの画面では意味を持たないため含めない。
// `.txt`→`.md`変換ボタンは既存の共通ツールバー（App.tsx `app__editor-toolbar`）側に置く）を含む。
export interface MarkdownToolbarProps {
  previewMode: boolean;
  onTogglePreview: () => void;
  /** 変換ボタンを表示するか（暗号化メモ・ノードロックセッション配下は `memo:convertFormat` 対象外, M10a）。 */
  canConvertToTxt: boolean;
  onConvertToTxt: () => void;
}

export function MarkdownToolbar({ previewMode, onTogglePreview, canConvertToTxt, onConvertToTxt }: MarkdownToolbarProps) {
  return (
    <div className="app__markdown-toolbar">
      <span className="app__markdown-toolbar-label">Markdown</span>
      <button
        type="button"
        className={previewMode ? 'app__markdown-toolbar-btn app__markdown-toolbar-btn--active' : 'app__markdown-toolbar-btn'}
        onClick={onTogglePreview}
        title="ソース表示とプレビュー表示を切り替えます（本文は変化しません）"
      >
        {previewMode ? 'プレビュー中（クリックでソース表示）' : 'ソース表示中（クリックでプレビュー）'}
      </button>
      {canConvertToTxt && (
        <button type="button" className="app__markdown-toolbar-btn" onClick={onConvertToTxt} title="拡張子を .txt に変換します（本文は変換しません）">
          .txtに変換
        </button>
      )}
    </div>
  );
}
