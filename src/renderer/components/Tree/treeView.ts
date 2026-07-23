// src/renderer/components/Tree/treeView.ts
// ツリー描画・DND 用の純粋ヘルパー（仮想化のための可視行フラット化・ドロップ位置計算・
// TreeNode(実行時, readonly, encrypted付き) <-> MetaTreeNode(永続化用) 変換, data-model.md §1）。
import type { AddPosition } from '@shared/ipc-contract';
import type { Label, MetaTreeNode, TreeNode } from '@shared/models';

/** ツリー行の DND で使うカスタム MIME タイプ（Tree からドラッグし TabBar 等へドロップする際の payload）。 */
export const MEMO_DND_MIME = 'application/x-ttn-memo';

export interface MemoDragPayload {
  srcTabId: string;
  memoNames: string[];
}

export interface FlatTreeRow {
  memoName: string;
  encrypted: boolean;
  expanded: boolean;
  hasChildren: boolean;
  depth: number;
  label?: Label;
}

/** 開閉状態（expanded）を反映して、現在表示すべき行だけをフラットな配列にする（仮想化の入力）。 */
export function flattenVisibleTree(nodes: readonly TreeNode[], depth = 0, out: FlatTreeRow[] = []): FlatTreeRow[] {
  for (const node of nodes) {
    out.push({
      memoName: node.memoName,
      encrypted: node.encrypted,
      expanded: node.expanded,
      hasChildren: node.children.length > 0,
      depth,
      label: node.label
    });
    if (node.expanded && node.children.length > 0) {
      flattenVisibleTree(node.children, depth + 1, out);
    }
  }
  return out;
}

/** `tab:openTree` の実行時ツリー（`encrypted` 付き readonly）から永続化用 `MetaTreeNode[]` を作る。 */
export function toMetaTree(nodes: readonly TreeNode[]): MetaTreeNode[] {
  return nodes.map((n) => ({
    memoName: n.memoName,
    expanded: n.expanded,
    label: n.label,
    editor: n.editor,
    children: toMetaTree(n.children)
  }));
}

/** ツリー中の指定 memoName のノードだけを `updater` で書き換えた新しい TreeNode[] を返す（不変更新）。 */
export function updateTreeNode(
  nodes: readonly TreeNode[],
  memoName: string,
  updater: (node: TreeNode) => TreeNode
): TreeNode[] {
  return nodes.map((n) => {
    if (n.memoName === memoName) return updater(n);
    if (n.children.length > 0) return { ...n, children: updateTreeNode(n.children, memoName, updater) };
    return n;
  });
}

export type DropZone = 'before' | 'after' | 'child';

/** 行の矩形内でのポインタ縦位置比率（0=上端〜1=下端）から、ドロップ位置を判定する。 */
export function computeDropZone(offsetYRatio: number): DropZone {
  if (offsetYRatio < 0.25) return 'before';
  if (offsetYRatio > 0.75) return 'after';
  return 'child';
}

export function dropZoneToPosition(zone: DropZone): AddPosition {
  return zone;
}

export interface VirtualRange {
  startIndex: number;
  endIndex: number;
  paddingTop: number;
  paddingBottom: number;
}

/** 固定行高の単純ウィンドウイング計算（仮想化ツリー、外部ライブラリ非依存）。 */
export function computeVirtualRange(
  totalCount: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 8
): VirtualRange {
  if (totalCount === 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 };
  }
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIndex = Math.min(totalCount, startIndex + visibleCount);
  const paddingTop = startIndex * rowHeight;
  const paddingBottom = (totalCount - endIndex) * rowHeight;
  return { startIndex, endIndex, paddingTop, paddingBottom };
}
