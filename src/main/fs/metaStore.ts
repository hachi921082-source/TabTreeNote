// src/main/fs/metaStore.ts
// タブ単位メタ JSON（`.tabtreenote.json`）の読書き・復旧カスケード（PLAN §5.7 / DESIGN §3.2）。
//
// 復旧カスケード（docs/00-core-principles.md §9）:
//   1. 直近 .bak があれば読込を試行 → 成功すれば採用。
//   2. 失敗/.bak 無し → フォルダ直下実ファイルからフラット構造でメタ再生成。
//   3. 呼び出し側が evt:metaRecovered で通知する（本モジュールは recovered フラグ/メッセージのみ返す）。
//
// 突合ロジック（data-model.md §1）: メタ JSON の tree（MetaTreeNode[]）とフォルダ直下実ファイル
// 走査結果を突合し、実行時用の TreeNode[]（拡張子由来の encrypted 付与）を構築する。
// メタにあり実体が無いノードは除外（子は親の位置へ繰り上げて温存し、実在する子メモの参照を失わない
// ようにする。data-model.md はこの「子の扱い」までは規定していないため developer 判断）。
// 実体にありメタに無いファイルはツリー末尾へフラット追加。
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { META_FILE_NAME, SCHEMA_VERSION, BACKUP_SUFFIX } from '@shared/constants';
import type { MetaTreeNode, TabMeta, TreeNode } from '@shared/models';
import type { AddPosition } from '@shared/ipc-contract';
import { atomicWrite } from './atomicWrite';
import { scanTabFolder, type ScannedMemo } from './memoFileService';
import { migrateSchema } from '../util/migrate';

export interface LoadedMeta {
  tree: TreeNode[];
  /** 内部保持用の永続化表現（次回の create/rename 等で書き換える対象）。 */
  metaTree: MetaTreeNode[];
  recovered: boolean;
  recoveredMessage?: string;
}

function metaFilePath(folderPath: string): string {
  return join(folderPath, META_FILE_NAME);
}

function isValidTabMeta(value: unknown): value is TabMeta {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.schemaVersion === 'number' && Array.isArray(v.tree);
}

async function tryReadMeta(path: string): Promise<TabMeta | null> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    // マイグレーション土台（M7, PLAN §7 / util/migrate.ts）: v1 のみの現状は no-op。
    return isValidTabMeta(parsed) ? migrateSchema(parsed, []) : null;
  } catch {
    return null;
  }
}

function generateFlatMeta(scanned: ScannedMemo[]): MetaTreeNode[] {
  return [...scanned]
    .sort((a, b) => a.memoName.localeCompare(b.memoName, 'ja'))
    .map((s) => ({ memoName: s.memoName, expanded: true, children: [] }));
}

/** メタの MetaTreeNode[] と実ファイル走査結果を突合し、実行時用 TreeNode[] を構築する。 */
function reconcile(metaTree: MetaTreeNode[], scanned: ScannedMemo[]): TreeNode[] {
  const scannedMap = new Map(scanned.map((s) => [s.memoName, s]));
  const usedNames = new Set<string>();

  function reconcileList(nodes: MetaTreeNode[]): TreeNode[] {
    const out: TreeNode[] = [];
    for (const node of nodes) {
      const reconciledChildren = reconcileList(node.children);
      const scannedEntry = scannedMap.get(node.memoName);
      if (scannedEntry) {
        usedNames.add(node.memoName);
        out.push({
          memoName: node.memoName,
          encrypted: scannedEntry.encrypted,
          expanded: node.expanded,
          label: node.label,
          editor: node.editor,
          locked: node.locked,
          children: reconciledChildren
        });
      } else {
        // 実体が無いノードは除外するが、子（実在するものに限られる）は繰り上げて温存する。
        out.push(...reconciledChildren);
      }
    }
    return out;
  }

  const reconciled = reconcileList(metaTree);

  // 実体にありメタに無いファイルはツリー末尾へフラット追加。
  const extras = scanned
    .filter((s) => !usedNames.has(s.memoName))
    .sort((a, b) => a.memoName.localeCompare(b.memoName, 'ja'))
    .map((s): TreeNode => ({ memoName: s.memoName, encrypted: s.encrypted, expanded: true, children: [] }));

  return [...reconciled, ...extras];
}

/** タブフォルダのメタを読み込み、実ファイルと突合した実行時ツリーを返す（復旧カスケード込み）。 */
export async function loadTabMeta(folderPath: string): Promise<LoadedMeta> {
  const scanned = await scanTabFolder(folderPath);
  const primaryPath = metaFilePath(folderPath);
  const bakPath = `${primaryPath}${BACKUP_SUFFIX}`;

  const fileExists = await fs
    .access(primaryPath)
    .then(() => true)
    .catch(() => false);

  let metaTree: MetaTreeNode[];
  let recovered = false;
  let recoveredMessage: string | undefined;

  if (!fileExists) {
    // メタ未生成（初回タブ登録等）。これは破損ではないので通知しない。
    metaTree = generateFlatMeta(scanned);
  } else {
    const primary = await tryReadMeta(primaryPath);
    if (primary) {
      metaTree = primary.tree;
    } else {
      const fromBak = await tryReadMeta(bakPath);
      if (fromBak) {
        metaTree = fromBak.tree;
        recovered = true;
        recoveredMessage = 'メタ情報が破損していたため、直近のバックアップから復旧しました。';
      } else {
        metaTree = generateFlatMeta(scanned);
        recovered = true;
        recoveredMessage = 'メタ情報を再構築しました（階層構造は失われた可能性があります）。';
      }
    }
  }

  return { tree: reconcile(metaTree, scanned), metaTree, recovered, recoveredMessage };
}

/** タブフォルダのメタ JSON をアトミック保存する（メタ JSON へ書き出すのは常に MetaTreeNode）。 */
export async function saveTabMeta(folderPath: string, tree: MetaTreeNode[]): Promise<void> {
  const meta: TabMeta = { schemaVersion: SCHEMA_VERSION, appVersion: app.getVersion(), tree };
  await atomicWrite(metaFilePath(folderPath), Buffer.from(JSON.stringify(meta, null, 2), 'utf-8'));
}

interface NodeLocation {
  node: MetaTreeNode;
  siblings: MetaTreeNode[];
  index: number;
}

/** メタツリーを深さ優先で探索し、指定 memoName のノードとその親配列/index を返す。 */
export function findNode(tree: MetaTreeNode[], memoName: string): NodeLocation | null {
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    if (!node) continue;
    if (node.memoName === memoName) return { node, siblings: tree, index: i };
    const found = findNode(node.children, memoName);
    if (found) return found;
  }
  return null;
}

/**
 * 新規ノードを追加位置（DESIGN §2.2: before/after/child/first/last）に従って挿入する。
 * before/after/child は anchorMemoName が必須（見つからない場合はルート末尾へフォールバック）。
 * first/last はルート直下の先頭/末尾に挿入する。
 */
export function insertNode(
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

  const anchor = anchorMemoName ? findNode(tree, anchorMemoName) : null;
  if (!anchor) {
    // アンカー未指定/未検出時はルート末尾へフォールバック。
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

/** メタツリー上のノード名を変更する（実ファイル操作の直後に呼ぶ, §3.3 同期順序）。 */
export function renameNodeInTree(tree: MetaTreeNode[], oldName: string, newName: string): boolean {
  const found = findNode(tree, oldName);
  if (!found) return false;
  found.node.memoName = newName;
  return true;
}

/**
 * 指定 memoName のノード（部分木ごと）をメタツリーから取り除いて返す（M2: 削除/移動で使用）。
 * 見つからなければ null。子孫はノードにぶら下がったまま返るため、呼び出し側で別の位置へ
 * 再挿入する（移動）か、そのまま破棄する（削除）かを選べる。
 */
export function removeNode(tree: MetaTreeNode[], memoName: string): MetaTreeNode | null {
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    if (!node) continue;
    if (node.memoName === memoName) {
      tree.splice(i, 1);
      return node;
    }
    const removed = removeNode(node.children, memoName);
    if (removed) return removed;
  }
  return null;
}
