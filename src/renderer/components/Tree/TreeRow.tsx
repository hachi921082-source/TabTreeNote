// src/renderer/components/Tree/TreeRow.tsx
// 仮想化ツリーの1行分の描画（開閉トライアングル・暗号アイコン・ラベル色・選択/ドラッグ状態）。
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { FileIcon } from './FileIcon';
import type { DropZone, FlatTreeRow } from './treeView';
import { computeDropZone } from './treeView';

/** 既定の行高（px）。実際の描画高は `uiFontScale` を乗じた値を Tree.tsx が計算して渡す。 */
export const BASE_ROW_HEIGHT = 26;

interface TreeRowProps {
  row: FlatTreeRow;
  top: number;
  rowHeight: number;
  selected: boolean;
  isOpenMemo: boolean;
  isDragging: boolean;
  dropZone: DropZone | null;
  onClick: (e: ReactMouseEvent) => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onToggleExpand: () => void;
  onDragStart: (e: ReactDragEvent) => void;
  onDragOver: (e: ReactDragEvent, zone: DropZone) => void;
  onDragLeave: () => void;
  onDrop: (e: ReactDragEvent, zone: DropZone) => void;
  onDragEnd: () => void;
}

export function TreeRow({
  row,
  top,
  rowHeight,
  selected,
  isOpenMemo,
  isDragging,
  dropZone,
  onClick,
  onContextMenu,
  onToggleExpand,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd
}: TreeRowProps) {
  const labelColor = row.label?.color ?? null;

  const handleDragOver = (e: ReactDragEvent): void => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    onDragOver(e, computeDropZone(ratio));
  };

  const handleDrop = (e: ReactDragEvent): void => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    onDrop(e, computeDropZone(ratio));
  };

  const classNames = [
    'tree-row',
    selected ? 'tree-row--selected' : '',
    isOpenMemo ? 'tree-row--open' : '',
    isDragging ? 'tree-row--dragging' : '',
    row.locked ? 'tree-row--locked' : '',
    dropZone ? `tree-row--drop-${dropZone}` : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classNames}
      style={{ position: 'absolute', top, left: 0, right: 0, height: rowHeight, paddingLeft: 6 + row.depth * 16 }}
      draggable
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragOver={handleDragOver}
      onDragLeave={onDragLeave}
      onDrop={handleDrop}
      onDragEnd={onDragEnd}
    >
      <span
        className={`tree-row__twisty${row.hasChildren ? ' tree-row__twisty--has-children' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          if (row.hasChildren) onToggleExpand();
        }}
      >
        {row.hasChildren ? (row.expanded ? '▾' : '▸') : ''}
      </span>
      <span className="tree-row__icon">
        <FileIcon color={labelColor ?? 'var(--color-text-muted)'} encrypted={row.encrypted} />
      </span>
      <span className="tree-row__name">{row.memoName}</span>
      {row.locked && (
        <span className="tree-row__lock-icon" title="編集ロック中">
          🔏
        </span>
      )}
    </div>
  );
}
