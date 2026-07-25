// src/renderer/components/dialogs/PropertiesDialog.tsx
// メモのプロパティ画面（ユーザー要望。参考: CatMemoNote のプロパティ画面）。
// ファイル情報（名前/パス/作成・更新日時/サイズ）+ 文字数カウント（総字数/改行・空白を除く字数/
// 行数のみ。半角/全角内訳や文字コード別バイト数は実装コスト優先でスコープ外, ユーザー判断）。
// 暗号化メモ（.txtenc）は復号しないため文字数カウントは表示しない（ファイル情報のみ）。
import type { MemoProperties } from '@shared/ipc-contract';
import { Modal } from './Modal';

interface PropertiesDialogProps {
  properties: MemoProperties;
  onRevealInFolder: () => void;
  onClose: () => void;
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} (${WEEKDAYS[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const daysAgo = Math.max(0, Math.floor((Date.now() - ms) / 86400000));
  return `${dateStr}（${daysAgo}日前）`;
}

export function PropertiesDialog({ properties, onRevealInFolder, onClose }: PropertiesDialogProps) {
  const displayName = `${properties.memoName}${properties.encrypted ? '.txtenc' : '.txt'}`;

  return (
    <Modal title="プロパティ" onClose={onClose}>
      <div className="properties-dialog">
        <section className="properties-dialog__section">
          <h3 className="properties-dialog__section-title">ファイル情報</h3>
          <dl className="properties-dialog__list">
            <dt>ファイル名</dt>
            <dd>{displayName}</dd>
            <dt>ファイルパス</dt>
            <dd className="properties-dialog__path">{properties.filePath}</dd>
            <dt>作成日時</dt>
            <dd>{formatDateTime(properties.createdAtMs)}</dd>
            <dt>更新日時</dt>
            <dd>{formatDateTime(properties.modifiedAtMs)}</dd>
            <dt>ファイルサイズ</dt>
            <dd>{properties.sizeBytes.toLocaleString('ja-JP')}</dd>
          </dl>
        </section>

        {properties.charCounts ? (
          <section className="properties-dialog__section">
            <h3 className="properties-dialog__section-title">文字数カウント</h3>
            <dl className="properties-dialog__list">
              <dt>総字数</dt>
              <dd>{properties.charCounts.total.toLocaleString('ja-JP')}</dd>
              <dt>字数</dt>
              <dd>{properties.charCounts.excludingWhitespace.toLocaleString('ja-JP')}（改行・空白を除く）</dd>
              <dt>行数</dt>
              <dd>{properties.charCounts.lines.toLocaleString('ja-JP')}</dd>
            </dl>
          </section>
        ) : (
          <p className="properties-dialog__hint">※ 暗号化メモのため文字数カウントは表示できません。</p>
        )}

        <div className="properties-dialog__actions">
          <button type="button" onClick={onRevealInFolder}>
            ファイルの場所を開く(O)
          </button>
          <button type="button" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </Modal>
  );
}
