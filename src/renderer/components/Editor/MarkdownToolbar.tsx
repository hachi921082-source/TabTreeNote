// src/renderer/components/Editor/MarkdownToolbar.tsx
// v3 M10c: ライブプレビュー編集中専用のツールバー（DESIGNv3 §2.2「右クリックに気づかない人向け」、
// docs/v3/milestones/M10c-markdown-toolbar-ui.md）。`.md`メモを開いている間のみ App.tsx が表示する。
//
// 配置・ボタン構成は developer 裁量（milestone doc記載通り）。ソース/プレビュー切替と
// `.md`→`.txt`変換（`.txt`→`.md`は既に`.md`のこの画面では意味を持たないため含めない。
// `.txt`→`.md`変換ボタンは既存の共通ツールバー（App.tsx `app__editor-toolbar`）側に置く）を含む。
//
// 【post-M10 bugfix: 装飾ボタンの追加】文字色/太字/文字サイズは元々エディタ本文の右クリック
// メニューからのみ実行できたが、ユーザーがこの経路に気づけなかった（docs/post-M10-changes.md
// 「Markdown live preview decoration bugs (M10b)」"Toolbar missing" 報告の実体）ため、同じ
// コマンド（`decorationCommands.ts`の`runDecorationCommand`、`MarkdownDecorationCommand`）を
// ここから直接呼べるボタン群を追加する。この追加を受けて、右クリックメニュー側の装飾サブメニュー
// （`src/main/index.ts`）は重複のため削除した。ボタンの色/文字サイズの選択肢は、削除した
// 右クリックメニューが提示していたものと同じ値を踏襲する（ユーザーにとって見た目が変わらない
// ようにする軽微な配慮、developer裁量の範囲）。
import type { MarkdownDecorationCommand } from '@shared/ipc-contract';

/** 削除した右クリックメニュー（旧 src/main/index.ts）と同じ色パレットを踏襲する。 */
const DECORATION_COLORS: ReadonlyArray<{ label: string; value: string }> = [
  { label: '赤', value: '#e53935' },
  { label: '青', value: '#1e88e5' },
  { label: '緑', value: '#43a047' },
  { label: 'オレンジ', value: '#fb8c00' },
  { label: '紫', value: '#8e24aa' }
];

/** 同じく削除した右クリックメニューと同じ3段階を踏襲する。 */
const DECORATION_FONT_SIZES: ReadonlyArray<{ label: string; value: string }> = [
  { label: '小', value: '12px' },
  { label: '大', value: '20px' },
  { label: '特大', value: '28px' }
];

export interface MarkdownToolbarProps {
  previewMode: boolean;
  onTogglePreview: () => void;
  /** 変換ボタンを表示するか（暗号化メモ・ノードロックセッション配下は `memo:convertFormat` 対象外, M10a）。 */
  canConvertToTxt: boolean;
  onConvertToTxt: () => void;
  /** 文字色/太字/文字サイズの装飾コマンドを実行する（App.tsx が `editorRef.current?.runDecorationCommand` へ橋渡しする）。 */
  onDecorate: (command: MarkdownDecorationCommand) => void;
}

export function MarkdownToolbar({ previewMode, onTogglePreview, canConvertToTxt, onConvertToTxt, onDecorate }: MarkdownToolbarProps) {
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
      <span className="app__markdown-toolbar-sep" aria-hidden="true" />
      <button
        type="button"
        className="app__markdown-toolbar-btn"
        onClick={() => onDecorate({ command: 'bold' })}
        title="選択範囲の太字を切り替えます（もう一度押すと解除）"
      >
        <strong>B</strong>
      </button>
      {DECORATION_COLORS.map((c) => (
        <button
          key={c.value}
          type="button"
          className="app__markdown-toolbar-swatch"
          style={{ backgroundColor: c.value }}
          onClick={() => onDecorate({ command: 'color', value: c.value })}
          title={`文字色: ${c.label}`}
          aria-label={`文字色: ${c.label}`}
        />
      ))}
      <button
        type="button"
        className="app__markdown-toolbar-btn"
        onClick={() => onDecorate({ command: 'color', value: '' })}
        title="選択範囲の文字色を解除します"
      >
        色解除
      </button>
      {DECORATION_FONT_SIZES.map((s) => (
        <button
          key={s.value}
          type="button"
          className="app__markdown-toolbar-btn"
          onClick={() => onDecorate({ command: 'fontSize', value: s.value })}
          title={`文字サイズ: ${s.label} (${s.value})`}
        >
          {s.label}
        </button>
      ))}
      <button
        type="button"
        className="app__markdown-toolbar-btn"
        onClick={() => onDecorate({ command: 'fontSize', value: '' })}
        title="選択範囲の文字サイズを解除します"
      >
        サイズ解除
      </button>
    </div>
  );
}
