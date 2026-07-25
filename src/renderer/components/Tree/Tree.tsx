// src/renderer/components/Tree/Tree.tsx
// 仮想化ツリー本体（DESIGN §2.2）。開閉/複数選択(Ctrl/Shift)/DND(並べ替え・階層変更・タブ間移動)/
// 右クリックメニュー(追加位置・リネーム・複製・削除・ラベル)を扱う。
// 外部の仮想化/DND ライブラリは追加せず、固定行高のウィンドウイング + ネイティブ HTML5 DnD で実装
// （docs/milestones/M2-tree-ui.md「仮想化ツリー」「DND」、PLAN §0 は tanstack/react-virtual や
// dnd-kit を候補として例示するが「developer は妥当な理由があれば変更してよい」との明記に基づき、
// 依存追加のリスクを避け軽量な自前実装を採用した）。
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type UIEvent as ReactUIEvent
} from 'react';
import type { AddPosition } from '@shared/ipc-contract';
import type { TreeNode } from '@shared/models';
import { rangeSelect, selectSingle, toggleSelection, type SelectionState } from '../../store/selection';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { TreeRow, BASE_ROW_HEIGHT } from './TreeRow';
import { computeVirtualRange, flattenVisibleTree, MEMO_DND_MIME, type DropZone, type MemoDragPayload } from './treeView';

const LABEL_PRESETS: { name: string; color: string | null }[] = [
  { name: 'なし', color: null },
  { name: '赤', color: '#e05a5a' },
  { name: '青', color: '#4a90d9' },
  { name: '緑', color: '#4caf50' },
  { name: '黄', color: '#e0c040' }
];

export interface TreeProps {
  tabId: string;
  tree: readonly TreeNode[];
  openMemoName: string | null;
  selection: SelectionState;
  onSelectionChange: (next: SelectionState) => void;
  /** `focusEditor` 省略時（クリック等）は既定でエディタへフォーカス移動する。矢印キー連続移動の
   * 間はツリー側にフォーカスを残したいため（ユーザー要望）、その場合のみ明示的に `false` を渡す。 */
  onOpenMemo: (memoName: string, encrypted: boolean, focusEditor?: boolean) => void;
  onToggleExpand: (memoName: string) => void;
  onRequestCreate: (position: AddPosition, anchorMemoName?: string) => void;
  onRequestRename: (memoName: string) => void;
  onRequestDelete: (memoNames: string[]) => void;
  onRequestSetLabel: (memoName: string, color: string | null) => void;
  /** パスワードを設定して暗号化する（平文メモのみ, M6）。 */
  onRequestEncrypt: (memoName: string) => void;
  /** 暗号化を解除して平文へ戻す（暗号化メモのみ, M6）。 */
  onRequestDecrypt: (memoName: string) => void;
  /** パスワードを変更する（暗号化メモのみ, M6）。 */
  onRequestChangePassword: (memoName: string) => void;
  /** 編集ロックの切替（本文編集のみ禁止。リネーム/削除等ファイル操作は対象外, ユーザー要望）。 */
  onRequestToggleLock: (memoName: string) => void;
  /** プロパティ画面を開く（ユーザー要望）。 */
  onRequestProperties: (memoName: string) => void;
  /** 同一タブ内の並べ替え・階層変更（ファイル移動不要, tree:updateStructure）。 */
  onLocalMove: (draggedNames: string[], destAnchorMemoName: string, zone: DropZone) => void;
  /** 同一タブ内コピー（実ファイル複製が必要, memo:move copy:true）。 */
  onLocalCopy: (draggedNames: string[], destAnchorMemoName: string, zone: DropZone) => void;
  /** UI 文字サイズ倍率（設定画面「外観」）。行高（仮想化・DnD 判定に使う固定高）をこれに連動させる。 */
  uiFontScale: number;
}

interface ContextMenuState {
  x: number;
  y: number;
  /** null = 行ではなく空白部分の右クリック（ユーザー要望: ツリーが空でもメモを作成できるように）。 */
  memoName: string | null;
}

export function Tree({
  tabId,
  tree,
  openMemoName,
  selection,
  onSelectionChange,
  onOpenMemo,
  onToggleExpand,
  onRequestCreate,
  onRequestRename,
  onRequestDelete,
  onRequestSetLabel,
  onRequestEncrypt,
  onRequestDecrypt,
  onRequestChangePassword,
  onRequestToggleLock,
  onRequestProperties,
  onLocalMove,
  onLocalCopy,
  uiFontScale
}: TreeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragNames, setDragNames] = useState<string[] | null>(null);
  const [dropTarget, setDropTarget] = useState<{ memoName: string; zone: DropZone } | null>(null);

  const rowHeight = Math.round(BASE_ROW_HEIGHT * uiFontScale);
  const flatRows = useMemo(() => flattenVisibleTree(tree), [tree]);
  const visibleOrder = useMemo(() => flatRows.map((r) => r.memoName), [flatRows]);
  const range = computeVirtualRange(flatRows.length, rowHeight, scrollTop, viewportHeight);
  const visibleRows = flatRows.slice(range.startIndex, range.endIndex);

  const handleScroll = useCallback((e: ReactUIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  // F2 でリネーム（単一選択時のみ, ユーザー要望）。右クリックメニューの「名前変更」と同じ
  // onRequestRename に委譲する。
  // ↑/↓ は既定のスクロールではなく前後のメモへ移動する（ユーザー要望）。クリック時と同様に
  // 単一選択+オープンまで行う。仮想化のため、選択後は必要に応じて手動でスクロール位置を補正する。
  const handleTreeKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'F2') {
        if (selection.selected.size !== 1) return;
        e.preventDefault();
        const [memoName] = selection.selected;
        if (memoName) onRequestRename(memoName);
        return;
      }

      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (flatRows.length === 0) return;
      e.preventDefault();

      const currentName = selection.anchor ?? [...selection.selected][0] ?? null;
      const currentIndex = currentName ? flatRows.findIndex((r) => r.memoName === currentName) : -1;
      const nextIndex =
        currentIndex === -1
          ? e.key === 'ArrowDown'
            ? 0
            : flatRows.length - 1
          : e.key === 'ArrowDown'
            ? Math.min(currentIndex + 1, flatRows.length - 1)
            : Math.max(currentIndex - 1, 0);
      const nextRow = flatRows[nextIndex];
      if (!nextRow) return;

      onSelectionChange(selectSingle(nextRow.memoName));
      // 矢印キーでの連続移動中はツリー側にフォーカスを残す（ユーザー要望: 移動のたびに右ペイン
      // へフォーカスが奪われると、そのまま↑/↓を押し続けられなくなるため）。
      onOpenMemo(nextRow.memoName, nextRow.encrypted, false);

      const rowTop = nextIndex * rowHeight;
      const rowBottom = rowTop + rowHeight;
      const container = containerRef.current;
      if (container) {
        if (rowTop < scrollTop) container.scrollTop = rowTop;
        else if (rowBottom > scrollTop + viewportHeight) container.scrollTop = rowBottom - viewportHeight;
      }
    },
    [selection, flatRows, rowHeight, scrollTop, viewportHeight, onRequestRename, onSelectionChange, onOpenMemo]
  );

  // 開いているメモが変わったら（起動時の前回メモ復元/memo:リンク遷移/検索結果ジャンプ等）、
  // 対応する行が表示範囲内に入るようスクロール位置を補正する（ユーザー要望）。
  // `container.scrollTop` を直接読むことで、手動スクロール中の scrollTop state 更新のたびに
  // 再実行されるのを避ける（依存配列に scrollTop を含めない）。
  useEffect(() => {
    if (!openMemoName) return;
    const index = flatRows.findIndex((r) => r.memoName === openMemoName);
    if (index === -1) return;
    const container = containerRef.current;
    if (!container) return;
    const rowTop = index * rowHeight;
    const rowBottom = rowTop + rowHeight;
    if (rowTop < container.scrollTop) container.scrollTop = rowTop;
    else if (rowBottom > container.scrollTop + viewportHeight) container.scrollTop = rowBottom - viewportHeight;
  }, [openMemoName, flatRows, rowHeight, viewportHeight]);

  const measureRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node) setViewportHeight(node.clientHeight);
  }, []);

  const handleRowClick = useCallback(
    (memoName: string, encrypted: boolean, e: ReactMouseEvent) => {
      // F2 リネームはこのコンテナが DOM フォーカスを持っている必要がある（行クリック時点で
      // 明示的にフォーカスしておく。ユーザー要望）。
      containerRef.current?.focus();
      if (e.shiftKey) {
        onSelectionChange(rangeSelect(selection, visibleOrder, memoName));
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        onSelectionChange(toggleSelection(selection, memoName));
        return;
      }
      onSelectionChange(selectSingle(memoName));
      onOpenMemo(memoName, encrypted);
    },
    [selection, visibleOrder, onSelectionChange, onOpenMemo]
  );

  const handleContextMenu = useCallback(
    (memoName: string, e: ReactMouseEvent) => {
      e.preventDefault();
      if (!selection.selected.has(memoName)) {
        onSelectionChange(selectSingle(memoName));
      }
      setContextMenu({ x: e.clientX, y: e.clientY, memoName });
    },
    [selection, onSelectionChange]
  );

  const handleDragStart = useCallback(
    (memoName: string, e: ReactDragEvent) => {
      const names = selection.selected.has(memoName) ? [...selection.selected] : [memoName];
      setDragNames(names);
      const payload: MemoDragPayload = { srcTabId: tabId, memoNames: names };
      e.dataTransfer.setData(MEMO_DND_MIME, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = 'copyMove';
    },
    [selection, tabId]
  );

  const handleRowDragOver = useCallback((memoName: string, zone: DropZone) => {
    setDropTarget({ memoName, zone });
  }, []);

  const handleRowDrop = useCallback(
    (memoName: string, zone: DropZone, e: ReactDragEvent) => {
      setDropTarget(null);
      const raw = e.dataTransfer.getData(MEMO_DND_MIME);
      setDragNames(null);
      if (!raw) return;
      let payload: MemoDragPayload;
      try {
        payload = JSON.parse(raw) as MemoDragPayload;
      } catch {
        return;
      }
      if (payload.srcTabId !== tabId) return; // タブ間ドロップは TabBar 側 (memo:move) が扱う。
      if (payload.memoNames.includes(memoName)) return; // 自分自身へのドロップは無視。
      const copy = e.ctrlKey;
      if (copy) {
        onLocalCopy(payload.memoNames, memoName, zone);
      } else {
        onLocalMove(payload.memoNames, memoName, zone);
      }
    },
    [tabId, onLocalMove, onLocalCopy]
  );

  const buildContextMenuItems = useCallback(
    (memoName: string | null): ContextMenuItem[] => {
      // 空白部分の右クリック（ユーザー要望）: ツリーが空でも「メモを作成」だけは常に出す。
      if (memoName === null) {
        return [{ label: 'メモを作成', onSelect: () => onRequestCreate('last') }];
      }
      const multi = selection.selected.size > 1 && selection.selected.has(memoName);
      // M6: 暗号化/暗号化解除/パスワード変更は単一選択時のみ（rename/duplicate と同様の制約）。
      const row = flatRows.find((r) => r.memoName === memoName);
      const rowEncrypted = row?.encrypted ?? false;
      const rowLocked = row?.locked ?? false;
      // ユーザー要望: 前/後/子の3項目は「メモを作成」1つに統一し、常に後ろ（'after'）に追加する。
      const items: ContextMenuItem[] = [{ label: 'メモを作成', onSelect: () => onRequestCreate('after', memoName) }];
      if (!multi) {
        items.push(
          { label: '名前変更', onSelect: () => onRequestRename(memoName), separatorBefore: true },
          {
            label: rowLocked ? '編集ロックを解除' : '編集ロック',
            onSelect: () => onRequestToggleLock(memoName)
          }
        );
        if (rowEncrypted) {
          items.push(
            { label: '暗号化を解除', onSelect: () => onRequestDecrypt(memoName), separatorBefore: true },
            { label: 'パスワードを変更', onSelect: () => onRequestChangePassword(memoName) }
          );
        } else {
          items.push({
            label: 'パスワードを設定して暗号化',
            separatorBefore: true,
            onSelect: () => onRequestEncrypt(memoName)
          });
        }
      }
      items.push({
        label: '削除',
        danger: true,
        separatorBefore: true,
        onSelect: () => onRequestDelete(multi ? [...selection.selected] : [memoName])
      });
      if (!multi) {
        items.push({
          label: 'アイコン',
          separatorBefore: true,
          submenu: LABEL_PRESETS.map((preset) => ({
            label: preset.name,
            swatchColor: preset.color,
            onSelect: () => onRequestSetLabel(memoName, preset.color)
          }))
        });
        items.push({ label: 'プロパティ', onSelect: () => onRequestProperties(memoName) });
      }
      return items;
    },
    [
      selection,
      flatRows,
      onRequestCreate,
      onRequestRename,
      onRequestDelete,
      onRequestSetLabel,
      onRequestEncrypt,
      onRequestDecrypt,
      onRequestChangePassword,
      onRequestToggleLock,
      onRequestProperties
    ]
  );

  return (
    <div className="tree-toolbar-wrap">
      <div
        className="tree-scroll"
        ref={measureRef}
        tabIndex={0}
        onKeyDown={handleTreeKeyDown}
        onScroll={handleScroll}
        onContextMenu={(e) => {
          // 行ではなく空白部分の右クリック（ユーザー要望: ツリーが空でもメモを作成できるように）。
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY, memoName: null });
          }
        }}
      >
        <div className="tree-spacer" style={{ height: range.paddingTop + range.paddingBottom + visibleRows.length * rowHeight }}>
          {visibleRows.map((row, i) => (
            <TreeRow
              key={row.memoName}
              row={row}
              top={range.paddingTop + i * rowHeight}
              rowHeight={rowHeight}
              selected={selection.selected.has(row.memoName)}
              isOpenMemo={openMemoName === row.memoName}
              isDragging={dragNames?.includes(row.memoName) ?? false}
              dropZone={dropTarget?.memoName === row.memoName ? dropTarget.zone : null}
              onClick={(e) => handleRowClick(row.memoName, row.encrypted, e)}
              onContextMenu={(e) => handleContextMenu(row.memoName, e)}
              onToggleExpand={() => onToggleExpand(row.memoName)}
              onDragStart={(e) => handleDragStart(row.memoName, e)}
              onDragOver={(_e, zone) => handleRowDragOver(row.memoName, zone)}
              onDragLeave={() => setDropTarget((prev) => (prev?.memoName === row.memoName ? null : prev))}
              onDrop={(e, zone) => handleRowDrop(row.memoName, zone, e)}
              onDragEnd={() => {
                setDragNames(null);
                setDropTarget(null);
              }}
            />
          ))}
        </div>
        {flatRows.length === 0 && (
          <div className="tree-empty-state">
            <button type="button" onClick={() => onRequestCreate('last')}>
              メモを作成
            </button>
          </div>
        )}
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildContextMenuItems(contextMenu.memoName)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
