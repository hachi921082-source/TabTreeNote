// src/shared/treeOps.ts
// `MetaTreeNode[]` に対する純粋なツリー操作関数群（Node API 非依存、レンダラから import 可能）。
//
// メイン側 `src/main/fs/metaStore.ts` は同種の操作（findNode/insertNode 等）を M1 時点で
// 既に自前実装済み・reviewer/tester 通過済みのため、本モジュールでは重複させず独立させている
// （M1 承認済みコードへの変更リスクを避けるための developer 判断）。
// 本モジュールはレンダラ側のツリー編集（DND のドロップ位置計算・複数選択の祖先/子孫判定等）で、
// メイン側へ `tree:updateStructure`/`memo:move` を invoke する前のローカルな構造計算に使う。
import type { AddPosition } from './ipc-contract';
import type { MetaTreeNode } from './models';

export interface TreeNodeLocation {
  node: MetaTreeNode;
  siblings: MetaTreeNode[];
  index: number;
}

/** ツリーを深さ優先で探索し、指定 memoName のノードとその親配列/index を返す。 */
export function findTreeNode(tree: MetaTreeNode[], memoName: string): TreeNodeLocation | null {
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    if (!node) continue;
    if (node.memoName === memoName) return { node, siblings: tree, index: i };
    const found = findTreeNode(node.children, memoName);
    if (found) return found;
  }
  return null;
}

/** 指定 memoName のノード（部分木ごと）をツリーから取り除いて返す。見つからなければ null。 */
export function removeTreeNode(tree: MetaTreeNode[], memoName: string): MetaTreeNode | null {
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    if (!node) continue;
    if (node.memoName === memoName) {
      tree.splice(i, 1);
      return node;
    }
    const removed = removeTreeNode(node.children, memoName);
    if (removed) return removed;
  }
  return null;
}

/**
 * 新規/移動ノードを追加位置（before/after/child/first/last）に従って挿入する
 * （メイン側 metaStore.insertNode と同じ規則、data-model.md §1）。
 */
export function insertTreeNode(
  tree: MetaTreeNode[],
  newNode: MetaTreeNode,
  position: AddPosition,
  anchorMemoName?: string
): void {
  if (position === 'first') {
    tree.unshift(newNode);
    return;
  }
  if (position === 'last') {
    tree.push(newNode);
    return;
  }

  const anchor = anchorMemoName ? findTreeNode(tree, anchorMemoName) : null;
  if (!anchor) {
    tree.push(newNode);
    return;
  }

  if (position === 'child') {
    anchor.node.children.push(newNode);
  } else if (position === 'before') {
    anchor.siblings.splice(anchor.index, 0, newNode);
  } else {
    anchor.siblings.splice(anchor.index + 1, 0, newNode);
  }
}

/** ツリー内の全 memoName をフラットに収集する（整合性チェック等に使用）。 */
export function collectTreeNames(tree: readonly MetaTreeNode[], out: string[] = []): string[] {
  for (const node of tree) {
    out.push(node.memoName);
    collectTreeNames(node.children, out);
  }
  return out;
}

/** `memoName` がツリー中の `ancestorName` の部分木（子孫）に含まれるか（循環移動防止用）。 */
export function isDescendantOf(tree: readonly MetaTreeNode[], ancestorName: string, memoName: string): boolean {
  const loc = findTreeNode(tree as MetaTreeNode[], ancestorName);
  if (!loc) return false;
  return collectTreeNames(loc.node.children).includes(memoName);
}

/**
 * 複数ノードを同一アンカー位置へ順に `insertTreeNode`（レンダラ）/ `insertNode`（メイン
 * metaStore.ts、同一ロジック）へ渡す際の反復順序を返す（reviewer 指摘 M2-R1-02 対応）。
 * `after` は反復ごとにアンカー直後へ挿入されるため、選択順のまま反復すると挿入順が反転する
 * （後から挿入したノードがアンカーとの間に割り込むため）。逆順に反復することで選択順を保つ。
 * `before`/`child`/`last`（末尾への追記型）は順反復のままで選択順が保たれる。
 * 注意: `first`（`unshift`）は本関数が現状カバーしていない。`after` と同様に順反復のままだと
 * 選択順が反転する（`unshift` を繰り返すと後から入れたものが先頭に来るため）。現状の呼び出し
 * 経路（`handleLocalMove`/`memo:move`）は `first` を一括挿入に使っていないため実害はないが、
 * 将来 `first` を複数ノードの一括挿入に使う場合は本関数の対象に追加すること
 * （reviewer 指摘 M2-R1-02 再レビュー時の非ブロッキング指摘）。
 */
export function orderForBatchInsert<T>(nodes: readonly T[], position: AddPosition): T[] {
  return position === 'after' ? [...nodes].reverse() : [...nodes];
}
