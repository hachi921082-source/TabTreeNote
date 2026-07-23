// src/renderer/components/Tree/Tree.tsx
// 仮想化ツリー本体（DESIGN §2.2）。開閉/複数選択(Ctrl/Shift)/DND(並べ替え・階層変更・タブ間移動)/
// 右クリックメニュー(追加位置・リネーム・複製・削除・ラベル)を扱う。
// 外部の仮想化/DND ライブラリは追加せず、固定行高のウィンドウイング + ネイティブ HTML5 DnD で実装
// （docs/milestones/M2-tree-ui.md「仮想化ツリー」「DND」、PLAN §0 は tanstack/react-virtual や
// dnd-kit を候補として例示するが「developer は妥当な理由があれば変更してよい」との明記に基づき、
// 依存追加のリスクを避け軽量な自前実装を採用した）。
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type UIEvent as ReactUIEvent
} from 'react';
import type { AddPosition } from '@shared/ipc-contract';
import type { TreeNode } from '@shared/models';
import { rangeSelect, selectSingle, toggleSelection, type SelectionState } from '../../store/selection';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { TreeRow, ROW_HEIGHT } from './TreeRow';
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
  onOpenMemo: (memoName: string, encrypted: boolean) => void;
  onToggleExpand: (memoName: string) => void;
  onRequestCreate: (position: AddPosition, anchorMemoName?: string) => void;
  onRequestRename: (memoName: string) => void;
  onRequestDuplicate: (memoName: string) => void;
  onRequestDelete: (memoNames: string[]) => void;
  onRequestSetLabel: (memoName: string, color: string | null) => void;
  /** パスワードを設定して暗号化する（平文メモのみ, M6）。 */
  onRequestEncrypt: (memoName: string) => void;
  /** 暗号化を解除して平文へ戻す（暗号化メモのみ, M6）。 */
  onRequestDecrypt: (memoName: string) => void;
  /** パスワードを変更する（暗号化メモのみ, M6）。 */
  onRequestChangePassword: (memoName: string) => void;
  /** 同一タブ内の並べ替え・階層変更（ファイル移動不要, tree:updateStructure）。 */
  onLocalMove: (draggedNames: string[], destAnchorMemoName: string, zone: DropZone) => void;
  /** 同一タブ内コピー（実ファイル複製が必要, memo:move copy:true）。 */
  onLocalCopy: (draggedNames: string[], destAnchorMemoName: string, zone: DropZone) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  memoName: string;
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
  onRequestDuplicate,
  onRequestDelete,
  onRequestSetLabel,
  onRequestEncrypt,
  onRequestDecrypt,
  onRequestChangePassword,
  onLocalMove,
  onLocalCopy
}: TreeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragNames, setDragNames] = useState<string[] | null>(null);
  const [dropTarget, setDropTarget] = useState<{ memoName: string; zone: DropZone } | null>(null);

  const flatRows = useMemo(() => flattenVisibleTree(tree), [tree]);
  const visibleOrder = useMemo(() => flatRows.map((r) => r.memoName), [flatRows]);
  const range = computeVirtualRange(flatRows.length, ROW_HEIGHT, scrollTop, viewportHeight);
  const visibleRows = flatRows.slice(range.startIndex, range.endIndex);

  const handleScroll = useCallback((e: ReactUIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const measureRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node) setViewportHeight(node.clientHeight);
  }, []);

  const handleRowClick = useCallback(
    (memoName: string, encrypted: boolean, e: ReactMouseEvent) => {
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
    (memoName: string): ContextMenuItem[] => {
      const multi = selection.selected.size > 1 && selection.selected.has(memoName);
      // M6: 暗号化/暗号化解除/パスワード変更は単一選択時のみ（rename/duplicate と同様の制約）。
      const rowEncrypted = flatRows.find((r) => r.memoName === memoName)?.encrypted ?? false;
      const items: ContextMenuItem[] = [
        { label: '前に追加', onSelect: () => onRequestCreate('before', memoName) },
        { label: '後に追加', onSelect: () => onRequestCreate('after', memoName) },
        { label: '子として追加', onSelect: () => onRequestCreate('child', memoName) }
      ];
      if (!multi) {
        items.push(
          { label: '名前変更', onSelect: () => onRequestRename(memoName), separatorBefore: true },
          { label: '複製', onSelect: () => onRequestDuplicate(memoName) }
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
        for (const preset of LABEL_PRESETS) {
          items.push({
            label: `ラベル: ${preset.name}`,
            separatorBefore: preset === LABEL_PRESETS[0],
            onSelect: () => onRequestSetLabel(memoName, preset.color)
          });
        }
      }
      return items;
    },
    [
      selection,
      flatRows,
      onRequestCreate,
      onRequestRename,
      onRequestDuplicate,
      onRequestDelete,
      onRequestSetLabel,
      onRequestEncrypt,
      onRequestDecrypt,
      onRequestChangePassword
    ]
  );

  return (
    <div className="tree-toolbar-wrap">
      <div className="tree-toolbar">
        <button type="button" onClick={() => onRequestCreate('first')}>
          先頭に追加
        </button>
        <button type="button" onClick={() => onRequestCreate('last')}>
          末尾に追加
        </button>
      </div>
      <div
        className="tree-scroll"
        ref={measureRef}
        onScroll={handleScroll}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setContextMenu(null);
          }
        }}
      >
        <div className="tree-spacer" style={{ height: range.paddingTop + range.paddingBottom + visibleRows.length * ROW_HEIGHT }}>
          {visibleRows.map((row, i) => (
            <TreeRow
              key={row.memoName}
              row={row}
              top={range.paddingTop + i * ROW_HEIGHT}
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
