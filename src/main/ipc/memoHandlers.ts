// src/main/ipc/memoHandlers.ts
// メモ操作の IPC ハンドラ（PLAN §2.2）。M1 で read/readWithEncoding/save/create/rename。
// M2 で delete/duplicate/move、および tree:updateStructure を追加した
// （docs/milestones/M2-tree-ui.md「このフェーズで扱うディレクトリ/ファイル」: tabHandlers.ts /
// memoHandlers.ts の拡張、として本ファイルへ集約）。
// M3 で各操作の完了点から全文検索インデックス経路①（`searchIndex` の直接更新）を配線し、
// `evt:indexUpdated` を発火するようにした（docs/milestones/M3-search.md「インデックス差分更新の
// 2経路」。経路②=ファイル監視経由の反映は M4）。
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import {
  IpcChannels,
  IpcEvents,
  type AddPosition,
  type IndexUpdatedPayload,
  type LockContext,
  type MemoConvertFormatArgs,
  type MemoCreateArgs,
  type MemoDeleteArgs,
  type MemoDuplicateArgs,
  type MemoGetPropertiesArgs,
  type MemoMoveArgs,
  type MemoProperties,
  type MemoReadArgs,
  type MemoRenameArgs,
  type MemoRevealInFolderArgs,
  type MemoSaveArgs,
  type TreeUpdateStructureArgs,
  type TrashFallbackPayload
} from '@shared/ipc-contract';
import type { Eol, MemoInfo, MetaTreeNode, MemoReadResult, Result, SaveResult } from '@shared/models';
import { orderForBatchInsert } from '@shared/treeOps';
import { err, ok, wrapHandler } from '../util/result';
import { getTabFolderPath } from '../fs/tabService';
import { validateName, normalizeForCompare } from '../fs/pathSafety';
import {
  convertMemoFileFormat,
  copyMemoFileToFolder,
  createEmptyMemoFile,
  deleteMemoFileDirect,
  deleteMemoFileViaTrash,
  duplicateMemoFile,
  findMemoFile,
  getMemoProperties,
  moveMemoFileToFolder,
  pickAvailableName,
  readMemo,
  readMemoWithEncoding,
  renameMemoFile,
  saveMemo,
  scanTabFolder,
  validateExistingMemoNameForPath
} from '../fs/memoFileService';
import {
  collectClaimedTokens,
  collectLockedNodesByName,
  findNode,
  insertNode,
  loadTabMeta,
  removeNode,
  renameNodeInTree,
  saveTabMeta
} from '../fs/metaStore';
import type { DetectedEncoding } from '../fs/encoding';
import { moveMemoInIndex, removeMemo as removeMemoFromIndex, renameMemoInIndex, updateMemo as updateMemoIndex } from '../search/searchIndex';
import { deleteSessionKey, renameSessionKey } from '../crypto/sessionKeyStore';
import { getNodeLockSession, type NodeLockSessionEntry } from '../crypto/nodeLockSessionStore';
import { generateUniqueObfuscatedName } from '../crypto/obfuscatedNaming';
import {
  deleteConvertedSourceFile,
  flattenSubtree,
  persistNodeLockSession,
  readSessionMemoContent,
  readSubtreeMember,
  writeSessionMemoContent
} from '../crypto/nodeLock';

/** `evt:indexUpdated` を発火する（全文検索インデックス更新, PLAN §2.7）。 */
function emitIndexUpdated(event: IpcMainInvokeEvent, tabId: string): void {
  const payload: IndexUpdatedPayload = { tabId };
  event.sender.send(IpcEvents.indexUpdated, payload);
}

async function isMemoNameTaken(
  folderPath: string,
  memoName: string,
  excludeName?: string,
  extraNames?: ReadonlySet<string>
): Promise<boolean> {
  const scanned = await scanTabFolder(folderPath);
  const normalizedTarget = normalizeForCompare(memoName);
  const diskTaken = scanned.some(
    (s) => normalizeForCompare(s.memoName) === normalizedTarget && s.memoName !== excludeName
  );
  if (diskTaken) return true;
  if (!extraNames) return false;
  for (const n of extraNames) {
    if (n !== excludeName && normalizeForCompare(n) === normalizedTarget) return true;
  }
  return false;
}

/**
 * 【v3 M8 / レビューM8-T1-R1-01対応】そのタブでアクティブなロック解除セッション
 * （`nodeLockSessionStore`）が可視化している起点ノードの実名（`realMemoName`）を集める。
 * ディスク上には対応する実ファイルが存在しない「仮想的な」名前だが、以後クライアントが
 * `tree:updateStructure` で実名ベースの構造を送ってくる（`crypto:unlockNode` 参照）ため、
 * ディスクスキャンのみを見る `isMemoNameTaken` では検出できない同名衝突を未然に防ぐ用途で使う
 * （衝突すると `tree:updateStructure` の `reattachLocks` がセッション本来の位置と無関係な新規/
 * リネーム後ノードを同じトークン名へ書き換えてしまい、以後 `NAME_DUPLICATE` で恒常的に拒否される）。
 */
function collectActiveSessionRealNames(tabId: string, metaTree: MetaTreeNode[]): Set<string> {
  const out = new Set<string>();
  for (const token of collectLockedNodesByName(metaTree).keys()) {
    const session = getNodeLockSession(tabId, token);
    if (session) out.add(session.realMemoName);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 【v3 M9a】ロック解除セッション配下での構造変更（`lockContext` 指定時の共通処理）。
// docs/v3/milestones/M9a-node-lock-session-ops.md「セッション中の構造変更フロー」。
// 操作の都度、`persistNodeLockSession`（src/main/crypto/nodeLock.ts）でセッションを再暗号化し
// メタJSONへアトミック保存する（DESIGNv3 §1.5「操作の都度、即座に再暗号化・アトミック保存」）。
// ---------------------------------------------------------------------------

/** `lockContext` からセッションを解決する（無ければ `LOCK_SESSION_NOT_FOUND`）。 */
function requireSession(tabId: string, lockContext: LockContext): Result<NodeLockSessionEntry> {
  const entry = getNodeLockSession(tabId, lockContext.lockToken);
  if (!entry) {
    return err('LOCK_SESSION_NOT_FOUND', 'ロックセッションが見つかりません（既に再ロックされた可能性があります）。');
  }
  return ok(entry);
}

/**
 * セッション内の名前重複チェック（PLANv3 §7.3「ロック配下のmemoNameはブロブ内でのみ一意で
 * あればよく、タブ全体の名前空間とは独立」）。`NodeLockBlob.nameMap` は深さに関わらずセッション
 * 全体でフラットな `realName -> token` の対応表であるため（1件のみが実装可能, PLANv3 §4）、
 * 一意性チェックも兄弟階層に限らずセッション全体（`nameMap` の全キー）を対象にする。
 */
function isNameTakenInSession(entry: NodeLockSessionEntry, name: string, excludeName?: string): boolean {
  const target = normalizeForCompare(name);
  for (const key of Object.keys(entry.nameMap)) {
    if (key !== excludeName && normalizeForCompare(key) === target) return true;
  }
  return false;
}

/** `memo:create` の `lockContext` 分岐（PLANv3 §5.3 step2「新規作成」）。 */
async function createMemoInSession(
  tabId: string,
  lockToken: string,
  folderPath: string,
  entry: NodeLockSessionEntry,
  name: string,
  position: AddPosition,
  anchorMemoName: string | undefined,
  format: 'plain' | 'markdown' | undefined
): Promise<Result<MemoInfo>> {
  if (isNameTakenInSession(entry, name)) {
    return err('NAME_DUPLICATE', `同名のメモが既に存在します: ${name}`);
  }
  if (position === 'child' && anchorMemoName) {
    if (collectLockedNodesByName(entry.children).has(anchorMemoName)) {
      return err('NAME_INVALID', 'ロック中のノードの配下へは作成できません。');
    }
  }

  // ノードロックのファイルはタブフォルダ直下にフラットに置かれるため、フォルダ全体を走査すれば
  // 衝突を検出できる（既存 crypto/nodeLock.ts の lockNode と同一パターン）。
  const existingScanned = await scanTabFolder(folderPath);
  const takenTokens = new Set(existingScanned.map((s) => s.memoName));
  const token = generateUniqueObfuscatedName(takenTokens);

  // ②実ファイル操作（新規の空メモを、セッション配下は常に .txtenc として作成する。DESIGNv3 §1.5
  // 「常駐セッション方式」＝ディスク上は常に難読化名の暗号化ファイルのまま）。
  const written = await writeSessionMemoContent(folderPath, entry, token, '', 'lf', undefined, format ?? 'plain');
  if (!written.ok) return written;

  // ①ストア更新（メモリ上のセッション構造）。
  insertNode(entry.children, { memoName: name, expanded: true, children: [] }, position, anchorMemoName);
  entry.nameMap[name] = token;
  entry.formatMap[name] = format ?? 'plain';

  // ③再暗号化+メタJSONアトミック保存（直後、PLANv3 §5.3 step4）。
  const persisted = await persistNodeLockSession(tabId, lockToken);
  if (!persisted.ok) return persisted;

  return ok<MemoInfo>({ memoName: name, encrypted: true });
}

/** `memo:rename` の `lockContext` 分岐（PLANv3 §5.3 step2「リネーム」「起点ノード自身のリネーム」）。 */
async function renameMemoInSession(
  tabId: string,
  lockToken: string,
  entry: NodeLockSessionEntry,
  oldName: string,
  newName: string
): Promise<Result<void>> {
  if (oldName === newName) return ok(undefined);

  const nameCheck = validateName(newName);
  if (!nameCheck.ok) return nameCheck;

  if (collectLockedNodesByName(entry.children).has(oldName)) {
    return err('NAME_INVALID', 'ロック中のノードの名前は変更できません。');
  }
  if (isNameTakenInSession(entry, newName, oldName)) {
    return err('NAME_DUPLICATE', `同名のメモが既に存在します: ${newName}`);
  }

  if (oldName === entry.realMemoName) {
    // 起点ノード自身のリネーム（DESIGNv3 §1.5「起点ノード自身のリネーム」）:
    // NodeLockBlob.realMemoName を更新する（他の構造変更と同一の扱い、特別扱いしない）。
    entry.realMemoName = newName;
  } else {
    const found = renameNodeInTree(entry.children, oldName, newName);
    if (!found) return err('NOT_FOUND', `メモが見つかりません: ${oldName}`);
  }

  // nameMap のキー（realName側）のみ差し替える。難読化ファイル名は不変（PLANv3 §5.3 step2）。
  const token = entry.nameMap[oldName];
  delete entry.nameMap[oldName];
  if (token) entry.nameMap[newName] = token;

  // 【2026-07-26追記・v3 M10b前提】formatMap も同様にキー付け替えする（起点ノード自身のリネームも
  // 同じコードパスを通るため特別扱い不要, M10b-markdown-live-preview.md §0.3）。
  const format = entry.formatMap[oldName];
  delete entry.formatMap[oldName];
  if (format) entry.formatMap[newName] = format;

  return persistNodeLockSession(tabId, lockToken);
}

/** `memo:delete` の `lockContext` 分岐（PLANv3 §5.3 step2「削除」）。 */
async function deleteMemosInSession(
  tabId: string,
  lockToken: string,
  folderPath: string,
  entry: NodeLockSessionEntry,
  memoNames: string[],
  forceDirect: boolean | undefined
): Promise<Result<void>> {
  // reviewer 指摘 M9a-R1-01: 入れ子ロック済みノードのプレースホルダ表示名（＝ entry.nameMap
  // には存在しない難読化トークン）が対象名に含まれる場合、無検証で進めると
  // `entry.nameMap[name]` が undefined のため「実ファイル無し＝削除済み」と誤認して成功扱いに
  // なり、続く removeNode がツリーからプレースホルダごと取り除いてしまう。これにより、その
  // ロック済みサブツリー自身の暗号化ファイルと `lock.claimedTokens` 配下の全ファイルが以後
  // どのメタ情報からも参照されない孤児として残る。createMemoInSession/renameMemoInSession と
  // 同水準に、対象名がロック済みノードのトークンと一致する場合はバッチ全体を拒否する
  // （他ハンドラと同じ NAME_INVALID、IPC 境界での再検証という既存方針を踏襲）。
  const lockedByName = collectLockedNodesByName(entry.children);
  for (const name of memoNames) {
    if (lockedByName.has(name)) {
      return err('NAME_INVALID', 'ロック中のノードは削除できません。');
    }
  }

  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const name of memoNames) {
    const token = entry.nameMap[name];
    if (!token) {
      // 実ファイル（トークン）が無い＝既に削除済み等。既存v1と同様、成功扱いにしてメタ参照
      // 除去対象にする。
      succeeded.push(name);
      continue;
    }
    try {
      const res = forceDirect
        ? await deleteMemoFileDirect(folderPath, token)
        : await deleteMemoFileViaTrash(folderPath, token);
      if (res.ok || res.error.code === 'NOT_FOUND') {
        succeeded.push(name);
      } else {
        failed.push(name);
      }
    } catch (e) {
      // eslint-disable-next-line no-console -- 内部診断ログ（00-core-principles.md §10 Fix8）
      console.error('[main] memo:delete(session) item failed', name, e);
      failed.push(name);
    }
  }

  for (const name of succeeded) {
    removeNode(entry.children, name);
    delete entry.nameMap[name];
    delete entry.formatMap[name];
  }
  if (succeeded.length > 0) {
    const persisted = await persistNodeLockSession(tabId, lockToken);
    if (!persisted.ok) return persisted;
  }

  if (failed.length > 0) {
    // `evt:trashFallback` によるユーザー確認→`forceDirect` 再 invoke のフォールバック導線は
    // `lockContext` を運ぶ型を持たないため、セッション配下では通常のごみ箱送り失敗として
    // エラーを返すのみに留める（developer 判断。UI 配線自体は本マイルストーンの対象外）。
    return err('TRASH_FAILED', `削除できなかったメモがあります: ${failed.join(', ')}`);
  }
  return ok(undefined);
}

/** `memo:duplicate` の `lockContext` 分岐。 */
async function duplicateMemoInSession(
  tabId: string,
  lockToken: string,
  folderPath: string,
  entry: NodeLockSessionEntry,
  memoName: string
): Promise<Result<MemoInfo>> {
  const token = entry.nameMap[memoName];
  if (!token) return err('NOT_FOUND', `メモが見つかりません: ${memoName}`, folderPath);

  const newName = pickAvailableName(new Set(Object.keys(entry.nameMap)), memoName);
  const existingScanned = await scanTabFolder(folderPath);
  const takenTokens = new Set(existingScanned.map((s) => s.memoName));
  const newToken = generateUniqueObfuscatedName(takenTokens);

  // ②実ファイル操作: 暗号化済みバイト列をそのまま複製する（同一鍵・同一IV/tag のまま。
  // 平文と同じ意味での「複製」＝内容の byte-for-byte コピーであり、再暗号化は不要）。
  const copyResult = await copyMemoFileToFolder(folderPath, token, folderPath, newToken);
  if (!copyResult.ok) return copyResult;

  // ①/③相当: 元の直後（同階層）へ挿入して再暗号化保存。
  insertNode(entry.children, { memoName: newName, expanded: true, children: [] }, 'after', memoName);
  entry.nameMap[newName] = newToken;
  entry.formatMap[newName] = entry.formatMap[memoName] ?? 'plain';

  const persisted = await persistNodeLockSession(tabId, lockToken);
  if (!persisted.ok) return persisted;

  return ok<MemoInfo>({ memoName: newName, encrypted: true });
}

/**
 * `tree:updateStructure` の `lockContext` 分岐。既存の実ファイル/メタ突合チェック
 * （`memoHandlers.ts` トップレベル版の `tree:updateStructure`）と同じ考え方を、対象セッションの
 * `entry.children`/`nameMap` を基準に適用する。
 */
async function updateStructureInSession(
  tabId: string,
  lockToken: string,
  folderPath: string,
  entry: NodeLockSessionEntry,
  treeStructure: MetaTreeNode[]
): Promise<Result<void>> {
  // クライアント（実行時 TreeNode ベース）が送ってくる構造には `lock` フィールドが含まれないため、
  // 現在セッションが保持する入れ子ロックノードへ `lock` を再付与する（トップレベル版
  // `reattachLocks` と同じ考え方）。
  const lockedByName = collectLockedNodesByName(entry.children);

  function reattachLocks(nodes: MetaTreeNode[]): MetaTreeNode[] {
    return nodes.map((n) => {
      const locked = lockedByName.get(n.memoName);
      if (locked) {
        return { memoName: n.memoName, expanded: n.expanded, lock: locked.lock, children: [] };
      }
      return { ...n, children: reattachLocks(n.children) };
    });
  }
  const finalStructure = reattachLocks(treeStructure);

  const flatNames: string[] = [];
  (function flatten(nodes: MetaTreeNode[]): void {
    for (const n of nodes) {
      flatNames.push(n.memoName);
      flatten(n.children);
    }
  })(finalStructure);

  const nameSet = new Set(flatNames);
  if (nameSet.size !== flatNames.length) {
    return err('NAME_DUPLICATE', '送信されたツリー構造内にメモ名の重複があります。');
  }

  // 期待される名前集合 = nameMap の全キー（起点ノード自身のキーを除く。起点自身は children に
  // 含まれない） ∪ 入れ子ロックノードのトークン。
  const expectedNames = new Set(Object.keys(entry.nameMap).filter((n) => n !== entry.realMemoName));
  for (const token of lockedByName.keys()) expectedNames.add(token);

  const setsMatch = nameSet.size === expectedNames.size && [...nameSet].every((n) => expectedNames.has(n));
  if (!setsMatch) {
    return err(
      'NOT_FOUND',
      'ツリー構造が実ファイルと一致しません。画面を再読み込みしてから再度お試しください。',
      folderPath
    );
  }

  entry.children = finalStructure;
  return persistNodeLockSession(tabId, lockToken);
}

// ---------------------------------------------------------------------------
// M2: memo:delete / memo:duplicate / memo:move / tree:updateStructure のヘルパー
// （docs/milestones/M2-tree-ui.md「リネーム/移動/コピー/複製の同期順序」「削除」）。
// ---------------------------------------------------------------------------

/** ツリー中の指定ノードの部分木に含まれる全 memoName（自分自身を含む）を収集する。 */
function collectSubtreeNames(node: MetaTreeNode, out: string[] = []): string[] {
  out.push(node.memoName);
  for (const child of node.children) collectSubtreeNames(child, out);
  return out;
}

/**
 * `name` の祖先（自分自身は含まない）のいずれかが `selected` に含まれるか。
 * 親ごと選択された子孫を移動対象から除外する（親が動けば子も一緒に動くため二重処理を避ける）。
 */
function hasSelectedAncestor(tree: MetaTreeNode[], name: string, selected: ReadonlySet<string>): boolean {
  function search(nodes: MetaTreeNode[], ancestors: string[]): boolean | null {
    for (const node of nodes) {
      if (node.memoName === name) {
        return ancestors.some((a) => selected.has(a));
      }
      const found = search(node.children, [...ancestors, node.memoName]);
      if (found !== null) return found;
    }
    return null;
  }
  return search(tree, []) ?? false;
}

/** `candidateName` が `rootName` 自身、またはその部分木（子孫）に含まれるか（移動先の循環防止）。 */
function isSelfOrDescendant(tree: MetaTreeNode[], rootName: string, candidateName: string): boolean {
  if (rootName === candidateName) return true;
  const loc = findNode(tree, rootName);
  if (!loc) return false;
  return collectSubtreeNames(loc.node).includes(candidateName);
}

/**
 * サブツリーを複製しつつ、`reservedNames`（呼び出し側で随時追加していく可変集合）と衝突する
 * 名前だけ `pickAvailableName` で採番し直す。同一タブ内コピーは（同じフォルダ内に同名ファイルが
 * 既にあるため）全ノードが必ず改名され、タブ間コピーは衝突するノードのみ改名される。
 */
function cloneSubtreeWithUniqueNames(
  node: MetaTreeNode,
  reservedNames: Set<string>
): { node: MetaTreeNode; renames: { from: string; to: string }[] } {
  const renames: { from: string; to: string }[] = [];

  function walk(n: MetaTreeNode): MetaTreeNode {
    const finalName = pickAvailableName(reservedNames, n.memoName);
    reservedNames.add(finalName);
    renames.push({ from: n.memoName, to: finalName });
    return { memoName: finalName, expanded: n.expanded, label: n.label, editor: n.editor, children: n.children.map(walk) };
  }

  return { node: walk(node), renames };
}

// ---------------------------------------------------------------------------
// 【v3 M9b】ロック境界を跨ぐ移動・コピー（「一方通行の金庫」、DESIGNv3 §1.12、PLANv3 §5.4/§7.5）。
// `memo:move` の `srcLockContext`/`destLockContext` のいずれかが指定された場合にのみ呼ばれる
// （両方省略時は既存v1の通常移動、`registerMemoHandlers` 内の memo:move ハンドラ本体を参照）。
// 判定表（M9b-node-lock-boundary-move.md）:
//   通常 → 通常                         : 対象外（既存v1がそのまま処理する）
//   通常 → ロック解除セッション配下       : 許可（外→内）→ moveIntoSession
//   ロック解除セッション配下 → 通常       : 禁止 LOCK_BOUNDARY_VIOLATION（内→外）
//   ロックA配下 → ロックB配下（別トークン）: 禁止 LOCK_BOUNDARY_VIOLATION（別ロック間）
//   ロックA配下 → ロックA配下（同一トークン）: 許可（境界を跨がない）→ moveWithinSession
// ---------------------------------------------------------------------------

/** ノード自身またはその子孫のいずれかがロック中（`.lock` 保有）か。 */
function containsLockedDescendant(node: MetaTreeNode, lockedByName: ReadonlyMap<string, MetaTreeNode>): boolean {
  if (lockedByName.has(node.memoName)) return true;
  return node.children.some((c) => containsLockedDescendant(c, lockedByName));
}

/**
 * v3 M9b: 同一ロックセッション配下での移動・コピー（境界を跨がない、PLANv3 §5.4 表の最終行
 * 「§5.3の通常の構造変更として処理」）。既存のトップレベル `memo:move`（境界跨ぎ無し版）と
 * 同型の move/copy ロジックを、対象セッションの `entry.children`/`nameMap` に適用したもの。
 */
async function moveWithinSession(
  tabId: string,
  folderPath: string,
  entry: NodeLockSessionEntry,
  lockToken: string,
  memoNames: string[],
  destPosition: AddPosition,
  destAnchorMemoName: string | undefined,
  copy: boolean
): Promise<Result<void>> {
  const selectedSet = new Set(memoNames);
  const topLevelNames = memoNames.filter((name) => {
    const loc = findNode(entry.children, name);
    return loc !== null && !hasSelectedAncestor(entry.children, name, selectedSet);
  });
  if (topLevelNames.length === 0) {
    return err('NOT_FOUND', '移動/コピー対象のメモが見つかりません。');
  }

  if (destAnchorMemoName) {
    for (const name of topLevelNames) {
      if (isSelfOrDescendant(entry.children, name, destAnchorMemoName)) {
        return err('NAME_INVALID', '選択したメモ自身またはその子孫へは移動できません。');
      }
    }
  }
  if (destPosition === 'child' && destAnchorMemoName) {
    if (collectLockedNodesByName(entry.children).has(destAnchorMemoName)) {
      return err('NAME_INVALID', 'ロック中のノードの配下へは移動/コピーできません。');
    }
  }

  if (!copy) {
    // 移動: 実ファイルは常にタブフォルダ直下にフラットに置かれているため物理的な移動は発生しない
    // （nameMap のトークンも不変）。entry.children 内での位置のみ変更する。
    const movedNodes: MetaTreeNode[] = [];
    for (const name of topLevelNames) {
      const node = removeNode(entry.children, name);
      if (node) movedNodes.push(node);
    }
    for (const node of orderForBatchInsert(movedNodes, destPosition)) {
      insertNode(entry.children, node, destPosition, destAnchorMemoName);
    }
    return persistNodeLockSession(tabId, lockToken);
  }

  // コピー: 入れ子ロック済み子孫（`.lock` 保有、`nameMap` に対応トークンが無い）が選択範囲に
  // 含まれる場合は拒否する（developer判断）。`cloneSubtreeWithUniqueNames` は `lock` フィールドを
  // 引き継がず、かつ複製先の実ファイルもトークン不明のため生成できない。誤って複製すると
  // 「ロックの痕跡を失った空のノード」を生んでしまうため、既存 lockNode の「既にロック済みノードが
  // 混在する場合は拒否」（LOCK_CONTAINS_ENCRYPTED）と同水準の防御として書込み前に弾く。
  const lockedByName = collectLockedNodesByName(entry.children);
  for (const name of topLevelNames) {
    const loc = findNode(entry.children, name);
    if (loc && containsLockedDescendant(loc.node, lockedByName)) {
      return err('LOCK_CONTAINS_ENCRYPTED', '既にロックされているノードが含まれています。', folderPath);
    }
  }

  const reservedNames = new Set(Object.keys(entry.nameMap));
  const existingScanned = await scanTabFolder(folderPath);
  const takenTokens = new Set(existingScanned.map((s) => s.memoName));
  const newTopNodes: MetaTreeNode[] = [];
  const allRenames: { from: string; to: string }[] = [];

  for (const name of topLevelNames) {
    const loc = findNode(entry.children, name);
    if (!loc) continue;
    const cloned = cloneSubtreeWithUniqueNames(structuredClone(loc.node), reservedNames);
    newTopNodes.push(cloned.node);
    allRenames.push(...cloned.renames);
  }

  for (const rename of allRenames) {
    const oldToken = entry.nameMap[rename.from];
    if (!oldToken) continue; // 型上ありえない（上のガードで入れ子ロック済みは既に拒否済み）。
    const newToken = generateUniqueObfuscatedName(takenTokens);
    takenTokens.add(newToken);
    const copyResult = await copyMemoFileToFolder(folderPath, oldToken, folderPath, newToken);
    if (!copyResult.ok) return copyResult;
    entry.nameMap[rename.to] = newToken;
    entry.formatMap[rename.to] = entry.formatMap[rename.from] ?? 'plain';
  }

  for (const node of orderForBatchInsert(newTopNodes, destPosition)) {
    insertNode(entry.children, node, destPosition, destAnchorMemoName);
  }

  return persistNodeLockSession(tabId, lockToken);
}

/**
 * v3 M9b: 通常領域からロック解除セッション配下への移動・コピー（「外→内」、DESIGNv3 §1.12、
 * PLANv3 §5.4）。呼び出し時点で `nodes` は既に src 側ツリーから読み取り専用に集めた実名ノード
 * （move は既に取り除き済み、copy は `structuredClone` 済み）。名前重複チェック（move のみ）は
 * 呼び出し元（`handleLockBoundaryMove`）が事前に実施済み（copy は自動改名で衝突解決するため
 * 事前チェック不要）。
 */
async function moveIntoSession(
  srcTabId: string,
  srcFolderPath: string,
  destTabId: string,
  destFolderPath: string,
  destEntry: NodeLockSessionEntry,
  destLockToken: string,
  nodes: MetaTreeNode[],
  destPosition: AddPosition,
  destAnchorMemoName: string | undefined,
  copy: boolean
): Promise<Result<void>> {
  // 1. 個別暗号化(.txtenc)混在チェック + 平文読込（既存 lockNode と同じ readSubtreeMember を再利用。
  //    src は常に通常領域＝ parentEntry 省略。ロック中(未解除)プレースホルダの実体も .txtenc の
  //    ため同じ判定で自然に LOCK_CONTAINS_ENCRYPTED となる, PLANv3 §5.4「対象に個別暗号化 .txtenc
  //    が含まれる場合は LOCK_CONTAINS_ENCRYPTED」）。この段階ではまだファイルへ一切触れない。
  const allMembers: MetaTreeNode[] = [];
  for (const node of nodes) allMembers.push(...flattenSubtree(node));

  const reads = new Map<string, { contentLF: string; eol: Eol; oldPath: string; format: 'plain' | 'markdown' }>();
  for (const n of allMembers) {
    const read = await readSubtreeMember(srcFolderPath, n, undefined);
    if (!read.ok) return read;
    reads.set(n.memoName, read.value);
  }

  // 2. コピー時のみ自動改名（既存 v1 コピー方式を踏襲。reservedNames はセッション全体でフラットな
  //    nameMap のキー全体, PLANv3 §7.3）。
  let topNodesToInsert: MetaTreeNode[] = nodes;
  let renameOf = (realName: string): string => realName;
  if (copy) {
    const reservedNames = new Set(Object.keys(destEntry.nameMap));
    const allRenames: { from: string; to: string }[] = [];
    const clonedTop: MetaTreeNode[] = [];
    for (const node of nodes) {
      const cloned = cloneSubtreeWithUniqueNames(node, reservedNames);
      clonedTop.push(cloned.node);
      allRenames.push(...cloned.renames);
    }
    topNodesToInsert = clonedTop;
    const renameMap = new Map(allRenames.map((r) => [r.from, r.to] as const));
    renameOf = (realName: string) => renameMap.get(realName) ?? realName;
  }

  // 3. 各ファイルを dest セッションの鍵で暗号化し難読化名で書込み（既存 createMemoInSession と同一
  //    パターン。新ファイル永続化(fsync)確認後に旧ファイルを削除する順序, PLANv3 §7.7）。
  const existingScanned = await scanTabFolder(destFolderPath);
  const takenTokens = new Set(existingScanned.map((s) => s.memoName));

  for (const n of allMembers) {
    const read = reads.get(n.memoName);
    if (!read) continue; // 型上ありえない（上のループで全件 reads に登録済み）。
    const token = generateUniqueObfuscatedName(takenTokens);
    takenTokens.add(token);
    const written = await writeSessionMemoContent(destFolderPath, destEntry, token, read.contentLF, read.eol, undefined, read.format);
    if (!written.ok) return written;
    destEntry.nameMap[renameOf(n.memoName)] = token;
    destEntry.formatMap[renameOf(n.memoName)] = read.format;

    if (!copy) {
      await deleteConvertedSourceFile(read.oldPath);
      // 全文検索インデックスから該当名を除去する（元は通常領域＝インデックス対象だった,
      // DESIGNv3 §1.7 Q1「セッション配下は対象外」）。
      removeMemoFromIndex(srcTabId, n.memoName);
    }
  }

  // 4. ①ストア更新: dest セッションの children へ挿入。
  for (const node of orderForBatchInsert(topNodesToInsert, destPosition)) {
    insertNode(destEntry.children, node, destPosition, destAnchorMemoName);
  }

  // 5. 再暗号化+メタJSONアトミック保存。
  return persistNodeLockSession(destTabId, destLockToken);
}

/**
 * v3 M9b: `memo:move` のロック境界跨ぎ判定本体。`srcLockContext`/`destLockContext` の
 * いずれかが指定された場合にのみ呼ばれる（`registerMemoHandlers` 内の memo:move ハンドラ参照）。
 */
async function handleLockBoundaryMove(
  event: IpcMainInvokeEvent,
  args: MemoMoveArgs,
  srcFolderPath: string,
  destFolderPath: string
): Promise<Result<void>> {
  let srcEntry: NodeLockSessionEntry | undefined;
  if (args.srcLockContext) {
    const session = requireSession(args.srcTabId, args.srcLockContext);
    if (!session.ok) return session;
    srcEntry = session.value;
  }
  let destEntry: NodeLockSessionEntry | undefined;
  if (args.destLockContext) {
    const session = requireSession(args.destTabId, args.destLockContext);
    if (!session.ok) return session;
    destEntry = session.value;
  }

  // セッションは (tabId, lockToken) キーのため、異なるタブでは物理的に同一セッションになり得ない。
  // トークン文字列がたまたま一致しても srcTabId!==destTabId なら「別ロック」として扱う。
  const sameLock =
    !!srcEntry && !!destEntry && args.srcTabId === args.destTabId && args.srcLockContext!.lockToken === args.destLockContext!.lockToken;

  // 「一方通行の金庫」（DESIGNv3 §1.12、PLANv3 §5.4/§7.5）。UIはドロップ自体を無効化（レンダラ側の
  // 事前拒否）した上で、IPC側でも同一ルールを再検証する二重防御（M9b-node-lock-boundary-move.md
  // 「reviewer/testerへの申し送り」最重要確認項目）。
  if (srcEntry && !destEntry) {
    return err(
      'LOCK_BOUNDARY_VIOLATION',
      'ロック解除中の場所から通常の場所へは移動・コピーできません（一方通行の金庫）。'
    );
  }
  if (srcEntry && destEntry && !sameLock) {
    return err('LOCK_BOUNDARY_VIOLATION', '異なるロックの間では移動・コピーできません（一方通行の金庫）。');
  }

  if (sameLock) {
    // 同一ロック配下（境界を跨がない、PLANv3 §5.4 表の最終行）: 通常の構造変更として処理する。
    return moveWithinSession(
      args.destTabId,
      destFolderPath,
      destEntry!,
      args.destLockContext!.lockToken,
      args.memoNames,
      args.destPosition,
      args.destAnchorMemoName,
      args.copy
    );
  }

  const entry = destEntry;
  if (!entry) {
    // 型上ありえない（呼び出し元の memo:move ハンドラは srcLockContext||destLockContext が
    // truthy な場合のみここへ委譲し、上のガードで srcEntry のみ有り／別ロックの場合は既に
    // return 済みのため、残るのは destEntry のみ有り＝このブロックのみ）。
    return err('UNKNOWN', 'ロック境界移動の内部エラーです。');
  }

  // 残る唯一の許可パターン: 通常領域 → ロック解除セッション配下（「外→内」、PLANv3 §5.4）。
  const srcLoaded = await loadTabMeta(srcFolderPath);
  const selectedSet = new Set(args.memoNames);
  const topLevelNames = args.memoNames.filter((name) => {
    const loc = findNode(srcLoaded.metaTree, name);
    return loc !== null && !hasSelectedAncestor(srcLoaded.metaTree, name, selectedSet);
  });
  if (topLevelNames.length === 0) {
    return err('NOT_FOUND', '移動/コピー対象のメモが見つかりません。');
  }

  // ロック中ノードの配下(children)への挿入禁止（既存 M8 多層防御と同水準）。
  if (args.destPosition === 'child' && args.destAnchorMemoName) {
    if (collectLockedNodesByName(entry.children).has(args.destAnchorMemoName)) {
      return err('NAME_INVALID', 'ロック中のノードの配下へは移動/コピーできません。');
    }
  }

  if (!args.copy) {
    // 移動（コピーではない）は名前を変えないため、事前に重複を検出しバッチ全体を拒否する
    // （①ストア更新前の重複チェック先行の原則。セッション全体でフラットな nameMap が対象,
    // PLANv3 §7.3）。
    const conflicts: string[] = [];
    for (const name of topLevelNames) {
      const loc = findNode(srcLoaded.metaTree, name);
      if (!loc) continue;
      for (const n of collectSubtreeNames(loc.node)) {
        if (isNameTakenInSession(entry, n)) conflicts.push(n);
      }
    }
    if (conflicts.length > 0) {
      return err('NAME_DUPLICATE', `移動先に同名のメモが既に存在します: ${conflicts.join(', ')}`);
    }
  }

  // ①相当（読み取りのみ。move は src ツリーから取り除き、copy は複製しても src はそのまま残す）。
  const nodes: MetaTreeNode[] = [];
  for (const name of topLevelNames) {
    if (args.copy) {
      const loc = findNode(srcLoaded.metaTree, name);
      if (loc) nodes.push(structuredClone(loc.node));
    } else {
      const removed = removeNode(srcLoaded.metaTree, name);
      if (removed) nodes.push(removed);
    }
  }

  // ②実ファイル操作(暗号化変換)+③再暗号化+メタJSONアトミック保存（dest セッション側）。
  const res = await moveIntoSession(
    args.srcTabId,
    srcFolderPath,
    args.destTabId,
    destFolderPath,
    entry,
    args.destLockContext!.lockToken,
    nodes,
    args.destPosition,
    args.destAnchorMemoName,
    args.copy
  );
  if (!res.ok) return res;

  if (!args.copy) {
    // src 側メタJSONもアトミック保存（move のみ。copy は元を残すので src メタは不変）。
    // 【M9b-T1-01 対応】ここで①時点（moveIntoSession 呼び出し前）に読み込んだ古いスナップショット
    // srcLoaded.metaTree をそのまま保存すると、srcFolderPath === destFolderPath（同一タブ内での
    // 「外→内」移動）の場合に moveIntoSession 内の persistNodeLockSession が正しく保存済みの
    // セッションの新しいロックプレースホルダ（新規 claimedTokens 含む）を、この古いスナップショット
    // で丸ごと上書きしてしまい、移動したノードの参照がセッションから消失する（tester報告
    // M9b-T1-01: 移動直後は表示上成功して見えるが、再ロック→再解除後に消失し、物理ファイルのみ
    // 孤児として残るデータ消失バグ）。moveIntoSession が完了した後の最新ディスク状態を再読込し、
    // 対象ノードのみをそこから取り除いてから保存することで、この上書きを回避する。
    const latestSrc = await loadTabMeta(srcFolderPath);
    for (const name of topLevelNames) {
      removeNode(latestSrc.metaTree, name);
    }
    await saveTabMeta(srcFolderPath, latestSrc.metaTree);
    emitIndexUpdated(event, args.srcTabId);
  }
  return ok(undefined);
}

export function registerMemoHandlers(): void {
  ipcMain.handle(
    IpcChannels.memo.read,
    wrapHandler(async (_event: IpcMainInvokeEvent, args: MemoReadArgs): Promise<Result<MemoReadResult>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;

      // 【v3 M9a】lockContext 指定時: ロック解除セッション配下の実名として解決する
      // （PLANv3 §5.3）。セッション配下の実ファイルは常に .txtenc のため、通常の平文
      // readMemo ではなく専用の復号ヘルパーを使う。
      if (args.lockContext) {
        const session = requireSession(args.tabId, args.lockContext);
        if (!session.ok) return session;
        const entry = session.value;
        const token = entry.nameMap[args.memoName];
        if (!token) return err('NOT_FOUND', `メモが見つかりません: ${args.memoName}`, folder.value);
        const read = await readSessionMemoContent(folder.value, entry, token);
        if (!read.ok) return read;
        return ok<MemoReadResult>({
          contentLF: read.value.contentLF,
          encoding: 'utf-8',
          eol: read.value.eol,
          encrypted: true,
          hash: read.value.hash
        });
      }

      return readMemo(folder.value, args.memoName);
    })
  );

  ipcMain.handle(
    IpcChannels.memo.getProperties,
    wrapHandler(async (_event: IpcMainInvokeEvent, args: MemoGetPropertiesArgs): Promise<Result<MemoProperties>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      return getMemoProperties(folder.value, args.memoName);
    })
  );

  ipcMain.handle(
    IpcChannels.memo.revealInFolder,
    wrapHandler(async (_event: IpcMainInvokeEvent, args: MemoRevealInFolderArgs): Promise<Result<void>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      const found = await findMemoFile(folder.value, args.memoName);
      if (!found) return err('NOT_FOUND', `メモが見つかりません: ${args.memoName}`, folder.value);
      shell.showItemInFolder(found.path);
      return ok(undefined);
    })
  );

  ipcMain.handle(
    IpcChannels.memo.readWithEncoding,
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        args: { tabId: string; memoName: string; encoding: DetectedEncoding }
      ): Promise<Result<MemoReadResult>> => {
        const folder = getTabFolderPath(args.tabId);
        if (!folder.ok) return folder;
        return readMemoWithEncoding(folder.value, args.memoName, args.encoding);
      }
    )
  );

  ipcMain.handle(
    IpcChannels.memo.save,
    wrapHandler(
      async (event: IpcMainInvokeEvent, args: MemoSaveArgs): Promise<Result<SaveResult>> => {
        const folder = getTabFolderPath(args.tabId);
        if (!folder.ok) return folder;

        // 【v3 M9a】lockContext 指定時: セッション鍵で再暗号化して保存する（PLANv3 §5.3）。
        // セッション配下は全文検索インデックス対象外（DESIGNv3 §1.7 Q1）のため
        // updateMemoIndex/emitIndexUpdated は呼ばない（既存ロジックの延長）。
        if (args.lockContext) {
          const session = requireSession(args.tabId, args.lockContext);
          if (!session.ok) return session;
          const entry = session.value;
          const token = entry.nameMap[args.memoName];
          if (!token) return err('NOT_FOUND', `メモが見つかりません: ${args.memoName}`, folder.value);
          // 【2026-07-26追記・v3 M10b前提】内容だけの保存なので既存値をそのまま使い、変更しない
          // （M10b-markdown-live-preview.md §0.3）。
          return writeSessionMemoContent(
            folder.value,
            entry,
            token,
            args.contentLF,
            args.eol,
            args.expectedHash,
            entry.formatMap[args.memoName] ?? 'plain'
          );
        }

        const result = await saveMemo(folder.value, args.memoName, args.contentLF, args.eol, args.encoding, args.expectedHash);
        if (result.ok) {
          // インデックス経路①（PLAN §5.2 step7）: 保存成功直後に本文を直接反映する。
          // 【v3 M10a】保存先の実拡張子（.txt/.md）を確認し、.md はタグ除去してから索引化する
          // （DESIGNv3 §2.6 Q11）。
          const saved = await findMemoFile(folder.value, args.memoName);
          updateMemoIndex(args.tabId, args.memoName, false, args.contentLF, saved?.format ?? 'plain');
          emitIndexUpdated(event, args.tabId);
        }
        return result;
      }
    )
  );

  ipcMain.handle(
    IpcChannels.memo.create,
    wrapHandler(async (event: IpcMainInvokeEvent, args: MemoCreateArgs): Promise<Result<MemoInfo>> => {
        const folder = getTabFolderPath(args.tabId);
        if (!folder.ok) return folder;
        const folderPath = folder.value;

        const nameCheck = validateName(args.name);
        if (!nameCheck.ok) return nameCheck;

        // 【v3 M9a】lockContext 指定時: ロック解除セッション配下へ作成する（PLANv3 §5.3）。
        if (args.lockContext) {
          const session = requireSession(args.tabId, args.lockContext);
          if (!session.ok) return session;
          return createMemoInSession(
            args.tabId,
            args.lockContext.lockToken,
            folderPath,
            session.value,
            args.name,
            args.position,
            args.anchorMemoName,
            args.format
          );
        }

        // ①ストア更新（メモリ上のみ。NG ならここで既に return 済みなのでファイル操作しない）。
        const loaded = await loadTabMeta(folderPath);

        // 【v3 M8 / レビューM8-T1-R1-01対応】ディスクスキャンだけでなく、そのタブでアクティブな
        // ロック解除セッションが可視化している実名とも衝突しないか確認する（衝突を許すと
        // tree:updateStructure が恒常的にNAME_DUPLICATEで失敗し続ける、reviewerラウンド1指摘）。
        if (await isMemoNameTaken(folderPath, args.name, undefined, collectActiveSessionRealNames(args.tabId, loaded.metaTree))) {
          return err('NAME_DUPLICATE', `同名のメモが既に存在します: ${args.name}`);
        }

        // 【v3 M8 / レビューM8-R1-02対応】ロック中ノードの配下(children)への挿入を禁止する
        // （ロック中ノードの children は常に [] でなければならない, DESIGNv3 §1.2/§1.6）。
        // 現行UIは常に position:'after' のみを送るため実UIからは到達不能だが、memo:move と
        // 同水準の多層防御を揃える（IPC 境界での再検証、reviewer 指摘 M1-R1-01 以来の既存方針）。
        if (args.position === 'child' && args.anchorMemoName) {
          const lockedAnchor = collectLockedNodesByName(loaded.metaTree).has(args.anchorMemoName);
          if (lockedAnchor) {
            return err('NAME_INVALID', 'ロック中のノードの配下へは作成できません。');
          }
        }

        insertNode(loaded.metaTree, { memoName: args.name, expanded: true, children: [] }, args.position, args.anchorMemoName);

        // ②実ファイル操作。【v3 M10a】format:'markdown' 指定時は拡張子 .md で作成する
        // （省略時は既存どおり 'plain' = .txt, DESIGNv3 §2.4）。
        const createResult = await createEmptyMemoFile(folderPath, args.name, args.format);
        if (!createResult.ok) return createResult;

        // ③メタ JSON アトミック保存（直後）。
        await saveTabMeta(folderPath, loaded.metaTree);

        // インデックス経路①: 新規メモ（空本文）を反映する。
        updateMemoIndex(args.tabId, args.name, false, '', args.format);
        emitIndexUpdated(event, args.tabId);

        return ok<MemoInfo>({ memoName: args.name, encrypted: false });
    })
  );

  ipcMain.handle(
    IpcChannels.memo.rename,
    wrapHandler(async (event: IpcMainInvokeEvent, args: MemoRenameArgs): Promise<Result<void>> => {
        const folder = getTabFolderPath(args.tabId);
        if (!folder.ok) return folder;
        const folderPath = folder.value;

        if (args.oldName === args.newName) return ok(undefined);

        const nameCheck = validateName(args.newName);
        if (!nameCheck.ok) return nameCheck;

        // 【v3 M9a】lockContext 指定時: ロック解除セッション配下の実名リネームとして解決する
        // （PLANv3 §5.3）。
        if (args.lockContext) {
          const session = requireSession(args.tabId, args.lockContext);
          if (!session.ok) return session;
          return renameMemoInSession(args.tabId, args.lockContext.lockToken, session.value, args.oldName, args.newName);
        }

        // ①ストア更新（メモリ上のみ）。メタに未登録（実ファイルはあるがメタ未反映）の場合は
        // ルート末尾へ新規追加してフォールバックする。
        const loaded = await loadTabMeta(folderPath);

        // 【v3 M8 / レビューM8-T1-R1-01対応】memo:create と同様、アクティブなロック解除セッション
        // の可視実名とも衝突しないか確認する。
        if (
          await isMemoNameTaken(
            folderPath,
            args.newName,
            args.oldName,
            collectActiveSessionRealNames(args.tabId, loaded.metaTree)
          )
        ) {
          return err('NAME_DUPLICATE', `同名のメモが既に存在します: ${args.newName}`);
        }

        const found = renameNodeInTree(loaded.metaTree, args.oldName, args.newName);
        if (!found) {
          loaded.metaTree.push({ memoName: args.newName, expanded: true, children: [] });
        }

        // ②実ファイル操作。
        const renameResult = await renameMemoFile(folderPath, args.oldName, args.newName);
        if (!renameResult.ok) return renameResult;

        // ③メタ JSON アトミック保存（直後）。
        await saveTabMeta(folderPath, loaded.metaTree);

        // インデックス経路①（PLAN §5.3 step4）: メモ名キーを更新する。
        renameMemoInIndex(args.tabId, args.oldName, args.newName);
        // 開封中の暗号化メモがリネームされてもセッション鍵を失わないよう引き継ぐ（M6, developer
        // 判断）。対象キーが無ければ何もしない（平文メモ/未開封メモのリネーム）。
        renameSessionKey(args.tabId, args.oldName, args.newName);
        emitIndexUpdated(event, args.tabId);

        return ok(undefined);
    })
  );

  // --- memo:delete（既定はごみ箱送り。失敗時は evt:trashFallback → forceDirect 再 invoke, PLAN §2.6） ---
  ipcMain.handle(
    IpcChannels.memo.delete,
    wrapHandler(async (event: IpcMainInvokeEvent, args: MemoDeleteArgs): Promise<Result<void>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      const folderPath = folder.value;

      // 【v3 M9a】lockContext 指定時: ロック解除セッション配下の実名として解決する（PLANv3 §5.3）。
      if (args.lockContext) {
        const session = requireSession(args.tabId, args.lockContext);
        if (!session.ok) return session;
        return deleteMemosInSession(
          args.tabId,
          args.lockContext.lockToken,
          folderPath,
          session.value,
          args.memoNames,
          args.forceDirect
        );
      }

      const loaded = await loadTabMeta(folderPath);

      // 【v3 §1.15】ロック中(セッション無し)ノードの直接削除を防ぐ（防御的多層防御。UI側の
      // ガード（Tree.tsx）が既に同じ制限を課しているが、バイパスされた場合にもここで一貫して
      // 防ぐ, docs/v3/DESIGNv3.md §1.15）。対象のいずれかが lock フィールドを持つノードに
      // 解決される場合、削除ループを開始する前にバッチ全体を拒否する（①ストア更新前の重複チェック
      // 先行と同じ原則、他の構造変更操作と共通）。`lockContext` 指定時（セッション内からの削除）は
      // 既に別チェック（deleteMemosInSession の NAME_INVALID）があるため本チェックの対象外。
      const lockedByName = collectLockedNodesByName(loaded.metaTree);
      const lockedTargets = args.memoNames.filter((name) => lockedByName.has(name));
      if (lockedTargets.length > 0) {
        return err('NODE_LOCKED', 'ロック中のノードは削除できません。先にロックを解除してください。', folderPath);
      }

      const succeeded: string[] = [];
      const failed: string[] = [];

      for (const name of args.memoNames) {
        try {
          const res = args.forceDirect
            ? await deleteMemoFileDirect(folderPath, name)
            : await deleteMemoFileViaTrash(folderPath, name);
          if (res.ok || res.error.code === 'NOT_FOUND') {
            // 既に無い（外部で削除済み等）場合もメタ参照を除去する対象として成功扱いにする。
            succeeded.push(name);
          } else {
            failed.push(name);
          }
        } catch (e) {
          // 個々の失敗でバッチ全体を中断しない（既に削除済みの他メモのメタ反映は維持する）。
          // 内部診断ログ（00-core-principles.md §10 Fix8）。
          // eslint-disable-next-line no-console -- 内部診断ログ
          console.error('[main] memo:delete item failed', name, e);
          failed.push(name);
        }
      }

      // ①/③相当: 成功分のみメタから除去してアトミック保存する。
      for (const name of succeeded) removeNode(loaded.metaTree, name);
      if (succeeded.length > 0) {
        await saveTabMeta(folderPath, loaded.metaTree);
        // インデックス経路①: 削除成功分をインデックスからも除去する。
        for (const name of succeeded) {
          removeMemoFromIndex(args.tabId, name);
          // 削除された暗号化メモのセッション鍵が残らないよう破棄する（M6, developer 判断。
          // 実体が無くなった鍵をメモリに残さないための衛生上の後始末）。
          deleteSessionKey(args.tabId, name);
        }
        emitIndexUpdated(event, args.tabId);
      }

      if (failed.length > 0) {
        if (!args.forceDirect) {
          const payload: TrashFallbackPayload = {
            tabId: args.tabId,
            memoNames: failed,
            reason: 'ごみ箱へ送れませんでした（権限またはネットワークドライブの可能性があります）。'
          };
          event.sender.send(IpcEvents.trashFallback, payload);
        }
        return err('TRASH_FAILED', `削除できなかったメモがあります: ${failed.join(', ')}`);
      }
      return ok(undefined);
    })
  );

  // --- memo:duplicate ---
  ipcMain.handle(
    IpcChannels.memo.duplicate,
    wrapHandler(async (event: IpcMainInvokeEvent, args: MemoDuplicateArgs): Promise<Result<MemoInfo>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      const folderPath = folder.value;

      // 【v3 M9a】lockContext 指定時: ロック解除セッション配下の実名として解決する（PLANv3 §5.3）。
      if (args.lockContext) {
        const session = requireSession(args.tabId, args.lockContext);
        if (!session.ok) return session;
        return duplicateMemoInSession(args.tabId, args.lockContext.lockToken, folderPath, session.value, args.memoName);
      }

      // ②実ファイル操作（複製先の名前は disk 走査から一意に採番されるため事前重複チェック不要）。
      const dup = await duplicateMemoFile(folderPath, args.memoName);
      if (!dup.ok) return dup;

      // ①/③相当: 元の直後（同階層）へ挿入してメタ保存。
      const loaded = await loadTabMeta(folderPath);
      const newNode: MetaTreeNode = { memoName: dup.value.newName, expanded: true, children: [] };
      insertNode(loaded.metaTree, newNode, 'after', args.memoName);
      await saveTabMeta(folderPath, loaded.metaTree);

      // インデックス経路①: 同一タブ内の複製として、元エントリを複製元に残したまま反映する。
      moveMemoInIndex(args.tabId, args.memoName, args.tabId, dup.value.newName, true);
      emitIndexUpdated(event, args.tabId);

      return ok<MemoInfo>({ memoName: dup.value.newName, encrypted: dup.value.encrypted });
    })
  );

  // --- v3 M10a: memo:convertFormat（`.txt`⇔`.md`変換。拡張子のみリネーム、本文は無変更,
  // DESIGNv3 §2.4）。呼び出し元UI（変換前の装飾/画像検出・確認ダイアログ）は M10c スコープ。
  // 本ハンドラは無条件でリネームするのみ（docs/v3/milestones/M10a-markdown-format-core.md） ---
  ipcMain.handle(
    IpcChannels.memo.convertFormat,
    wrapHandler(async (event: IpcMainInvokeEvent, args: MemoConvertFormatArgs): Promise<Result<MemoInfo>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      const folderPath = folder.value;

      // 【v3 M10a・developer判断】ロック解除セッション配下のメモは常に難読化名の `.txtenc` として
      // 保存され、`.txt`/`.md` の拡張子概念自体を持たない（DESIGNv3/PLANv3にセッションメンバー
      // 単位の format 追跡は定義が無く、M10a は M8/M9 と独立スコープのため新設しない）。
      // 対応外として明示的に拒否する（MemoConvertFormatArgs のコメント参照）。
      if (args.lockContext) {
        return err('NAME_INVALID', 'ロック解除セッション配下のメモは形式変換に対応していません。');
      }

      const nameCheck = validateExistingMemoNameForPath(folderPath, args.memoName);
      if (!nameCheck.ok) return nameCheck;

      const targetFormat: 'plain' | 'markdown' = args.targetFormat === 'md' ? 'markdown' : 'plain';
      const converted = await convertMemoFileFormat(folderPath, args.memoName, targetFormat);
      if (!converted.ok) return converted;

      // インデックス経路①: 本文は無変更だが、拡張子変更でタグ除去要否（DESIGNv3 §2.6 Q11）が
      // 変わるため、現在の本文を読み直して反映する。
      const reread = await readMemo(folderPath, args.memoName);
      updateMemoIndex(args.tabId, args.memoName, false, reread.ok ? reread.value.contentLF : '', targetFormat);
      emitIndexUpdated(event, args.tabId);

      return ok<MemoInfo>({ memoName: args.memoName, encrypted: false });
    })
  );

  // --- memo:move（タブ間/タブ内移動・コピー, PLAN §2.2/§5.3） ---
  ipcMain.handle(
    IpcChannels.memo.move,
    wrapHandler(async (event: IpcMainInvokeEvent, args: MemoMoveArgs): Promise<Result<void>> => {
      const srcFolder = getTabFolderPath(args.srcTabId);
      if (!srcFolder.ok) return srcFolder;
      const destFolder = getTabFolderPath(args.destTabId);
      if (!destFolder.ok) return destFolder;
      if (args.memoNames.length === 0) return ok(undefined);

      // 【v3 M9b】ロック境界を跨ぐ移動・コピー（「一方通行の金庫」、PLANv3 §5.4）。
      // srcLockContext/destLockContext のいずれかが指定されている場合は専用の判定・処理へ
      // 委譲する（両方省略時のみ以下の既存v1ロジックを通る）。
      if (args.srcLockContext || args.destLockContext) {
        return handleLockBoundaryMove(event, args, srcFolder.value, destFolder.value);
      }

      const sameTab = args.srcTabId === args.destTabId;
      const srcLoaded = await loadTabMeta(srcFolder.value);
      const destLoaded = sameTab ? srcLoaded : await loadTabMeta(destFolder.value);

      // 親も選択されている子孫は対象から除外（親の移動に随伴するため）。
      const selectedSet = new Set(args.memoNames);
      const topLevelNames = args.memoNames.filter((name) => {
        const loc = findNode(srcLoaded.metaTree, name);
        return loc !== null && !hasSelectedAncestor(srcLoaded.metaTree, name, selectedSet);
      });
      if (topLevelNames.length === 0) {
        return err('NOT_FOUND', '移動/コピー対象のメモが見つかりません。');
      }

      // 【v3 M9b・reviewer指摘 M9b-R1-01】ロック中(セッション無し)ノード自身（`.lock` 保有、
      // トップレベル/入れ子いずれのプレースホルダも該当）は、この plain v1 経路（srcLockContext/
      // destLockContext いずれも無指定＝タブ間は常に「通常領域→通常領域」の移動・コピー）では
      // タブをまたぐ移動・コピーの対象にできない（DESIGNv3 §1.1「ロック中はあらゆる構造変更操作を
      // 禁止」、タブ間移動も構造変更の一種）。同一タブ内での並べ替え（この関数のコピー分岐、または
      // tree:updateStructure 経由の移動）はロック対象の中身に一切触れない外側の位置変更に留まる
      // ため対象外とする（既存の「ロック済みノードの前後を並べ替える操作は許可」という設計判断,
      // Tree.tsx clampZoneForLockedTarget コメント参照、と同じ扱い）。レンダラ側の事前拒否
      // （Tree.tsx canAcceptDrop・App.tsx handleDropMemoOnTab の srcNodeLocked ガード）に続く、
      // IPC側の再検証（多層防御。milestone doc 「reviewer/testerへの申し送り」参照）。
      // 【reviewer指摘 M9b-R2-01】選択ノード自身が非ロックでも、その部分木内に（未選択の）
      // 個別ロック済み子孫が入れ子で存在するケースがある（M8の個別ロックはセッション無しでも
      // 任意の子ノードに掛けられるため）。moveWithinSession のコピー分岐・moveIntoSession と
      // 同様、`collectLockedNodesByName`+`containsLockedDescendant` で部分木全体を走査する。
      if (!sameTab) {
        const lockedByName = collectLockedNodesByName(srcLoaded.metaTree);
        for (const name of topLevelNames) {
          const loc = findNode(srcLoaded.metaTree, name);
          if (loc && containsLockedDescendant(loc.node, lockedByName)) {
            return err('LOCK_BOUNDARY_VIOLATION', 'ロック中のノードは別のタブへ移動・コピーできません。');
          }
        }
      }

      // 循環防止: 同一タブ内で、選択ノード自身またはその子孫をアンカーに指定していないか。
      if (sameTab && args.destAnchorMemoName) {
        for (const name of topLevelNames) {
          if (isSelfOrDescendant(srcLoaded.metaTree, name, args.destAnchorMemoName)) {
            return err('NAME_INVALID', '選択したメモ自身またはその子孫へは移動できません。');
          }
        }
      }

      // 【v3 M8】ロック中ノードの配下(children)へ挿入(destPosition==='child')することを禁止する
      // （ロック中ノードの children は常に [] でなければならない, DESIGNv3 §1.2/§1.6）。
      // Tree.tsx の DND は既にこのケースをクライアント側で 'after' へ丸めているが、IPC 境界でも
      // 同一ルールを再検証する多層防御（reviewer 指摘 M1-R1-01 以来の既存方針を踏襲）。
      if (args.destPosition === 'child' && args.destAnchorMemoName) {
        const lockedAnchor = collectLockedNodesByName(destLoaded.metaTree).has(args.destAnchorMemoName);
        if (lockedAnchor) {
          return err('NAME_INVALID', 'ロック中のノードの配下へは移動/コピーできません。');
        }
      }

      const destScanned = await scanTabFolder(destFolder.value);
      const destExistingNames = new Set(destScanned.map((s) => s.memoName));

      if (!args.copy) {
        // 移動: 名前は変えない。タブ間移動時のみ、宛先に同名の実ファイルがあれば拒否し
        // バッチ全体を中断する（部分適用しない＝①ストア更新前の重複チェック先行の原則）。
        if (!sameTab) {
          const conflicts: string[] = [];
          for (const name of topLevelNames) {
            const loc = findNode(srcLoaded.metaTree, name);
            if (!loc) continue;
            for (const n of collectSubtreeNames(loc.node)) {
              if (destExistingNames.has(n)) conflicts.push(n);
            }
          }
          if (conflicts.length > 0) {
            return err('NAME_DUPLICATE', `移動先に同名のメモが既に存在します: ${conflicts.join(', ')}`);
          }
        }

        // ①ストア更新: 選択ノードを src メタツリーから取り出す。
        const movedNodes: MetaTreeNode[] = [];
        for (const name of topLevelNames) {
          const node = removeNode(srcLoaded.metaTree, name);
          if (node) movedNodes.push(node);
        }

        // ②実ファイル操作（タブ間移動時のみ物理ファイルを移動。同一タブ内はツリー位置のみ変更）。
        // 複数ファイルのバッチ処理中に一部だけ失敗した場合、既に移動済みのファイルは両タブの
        // ディスク上メタにまだ未反映のまま関数を抜ける（movedNodes の変更はメモリ上のみで
        // 破棄される）。次回 tab:openTree の実ファイル突合（reconcile）で、移動済みファイルは
        // 移動先タブの末尾へフラット追加、移動元タブでは参照が失われるだけでメモ本体は失われない
        // （PLAN §5.3「クラッシュ時の隙は復旧カスケードが安全網」と同種の受容済みトレードオフ）。
        if (!sameTab) {
          for (const node of movedNodes) {
            for (const name of collectSubtreeNames(node)) {
              const res = await moveMemoFileToFolder(srcFolder.value, name, destFolder.value);
              if (!res.ok) return res;
              // インデックス経路①（PLAN §5.3）: 物理ファイル移動に合わせて移設する（名前は不変）。
              moveMemoInIndex(args.srcTabId, name, args.destTabId, name, false);
            }
          }
        }

        // reviewer 指摘 M2-R1-02: 'after' は反復順のまま挿入すると選択順が反転するため、
        // orderForBatchInsert で反復順序を補正する（before/child/first/last は順反復のままでよい）。
        for (const node of orderForBatchInsert(movedNodes, args.destPosition)) {
          insertNode(destLoaded.metaTree, node, args.destPosition, args.destAnchorMemoName);
        }

        // ③メタ JSON アトミック保存（直後）。両タブに影響する場合は両方保存。
        await saveTabMeta(destFolder.value, destLoaded.metaTree);
        if (!sameTab) {
          await saveTabMeta(srcFolder.value, srcLoaded.metaTree);
          // タブ間移動のみインデックスへ反映済み（上記ループ内）なので両タブへ通知する。
          // 同一タブ内の移動はツリー位置のみの変更（実ファイル・本文とも不変）でインデックスに
          // 影響しないため通知しない。
          emitIndexUpdated(event, args.destTabId);
          emitIndexUpdated(event, args.srcTabId);
        }
        return ok(undefined);
      }

      // コピー（Ctrl 併用）: 元を残す。名前衝突があるノードのみ「〇〇のコピー」方式で改名する。
      // 【reviewer指摘 M9b-R2-02】選択範囲に個別ロック済み(.lock保有)の子孫が含まれる場合、
      // `cloneSubtreeWithUniqueNames` は `lock` フィールドを引き継がないため、複製先が
      // 「ロックの痕跡を失った空のノード」になる一方、実ファイルはそのまま暗号化済みで複製されて
      // しまい、メタと実ファイルが食い違う破損コピーが生成される。moveWithinSession のコピー分岐と
      // 同じ `containsLockedDescendant` チェックで書込み前に拒否する（クロスタブの場合は直前の
      // LOCK_BOUNDARY_VIOLATION チェックで既に弾かれているため、ここは主に同一タブ内コピー
      // （Ctrl+ドラッグ複製）を保護する）。
      const lockedByNameForCopy = collectLockedNodesByName(srcLoaded.metaTree);
      for (const name of topLevelNames) {
        const loc = findNode(srcLoaded.metaTree, name);
        if (loc && containsLockedDescendant(loc.node, lockedByNameForCopy)) {
          return err('LOCK_CONTAINS_ENCRYPTED', '既にロックされているノードが含まれています。', srcFolder.value);
        }
      }

      const reservedNames = new Set(destExistingNames);
      const newTopNodes: MetaTreeNode[] = [];
      const allRenames: { from: string; to: string }[] = [];

      for (const name of topLevelNames) {
        const loc = findNode(srcLoaded.metaTree, name);
        if (!loc) continue;
        const cloned = cloneSubtreeWithUniqueNames(structuredClone(loc.node), reservedNames);
        newTopNodes.push(cloned.node);
        allRenames.push(...cloned.renames);
      }

      // ②実ファイル操作: 各ノードをコピー（元は残す）。
      for (const rename of allRenames) {
        const res = await copyMemoFileToFolder(srcFolder.value, rename.from, destFolder.value, rename.to);
        if (!res.ok) return res;
        // インデックス経路①: コピー先エントリを追加する（元エントリはそのまま残す, copy=true）。
        moveMemoInIndex(args.srcTabId, rename.from, args.destTabId, rename.to, true);
      }

      for (const node of orderForBatchInsert(newTopNodes, args.destPosition)) {
        insertNode(destLoaded.metaTree, node, args.destPosition, args.destAnchorMemoName);
      }

      // ③メタ JSON アトミック保存（コピー先のみ。元タブのメタは変更していない）。
      await saveTabMeta(destFolder.value, destLoaded.metaTree);
      emitIndexUpdated(event, args.destTabId);
      return ok(undefined);
    })
  );

  // --- tree:updateStructure（ツリー順序・階層・開閉・ラベルのメタ更新, PLAN §2.2） ---
  ipcMain.handle(
    IpcChannels.tree.updateStructure,
    wrapHandler(async (_event: IpcMainInvokeEvent, args: TreeUpdateStructureArgs): Promise<Result<void>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      const folderPath = folder.value;

      // 【v3 M9a】lockContext 指定時: treeStructure をロック解除セッション配下の実行時構造
      // （実名ベース、起点ノード自身を除く子ツリー）として保存する（PLANv3 §5.3）。タブ直下の
      // 可視ツリー（lockContext 無し呼び出し）とは別に、対象セッション単体で完結する。
      if (args.lockContext) {
        const session = requireSession(args.tabId, args.lockContext);
        if (!session.ok) return session;
        return updateStructureInSession(args.tabId, args.lockContext.lockToken, folderPath, session.value, args.treeStructure);
      }

      const scanned = await scanTabFolder(folderPath);

      // 【v3 M8】現在ディスク上のメタを読み、ロック中ノード（memoName -> MetaTreeNode）と
      // それらが占有する難読化ファイル名（claimedTokens）を控えておく。クライアント（実行時
      // TreeNode ベース）が送ってくる treeStructure には TreeNode に存在しない `lock` フィールドが
      // 含まれないため、そのまま保存するとロックブロブが消失する。また claimedTokens 配下の
      // 難読化ファイルはクライアントの可視ツリーに一切現れないため、実ファイル集合との厳密一致
      // チェックからも除外する必要がある（PLANv3 §7.1 の延長。metaStore.reconcile と同じ対応）。
      const currentLoaded = await loadTabMeta(folderPath);
      const lockedByName = collectLockedNodesByName(currentLoaded.metaTree);
      const claimedTokens = collectClaimedTokens(currentLoaded.metaTree);
      // 【v3 M8 / レビューM8-R1-01対応】claimedTokens はロックノード自身の memoName（起点トークン）
      // も含む（metaStore.collectClaimedTokens の仕様）。しかし起点トークンは finalStructure 側の
      // ロック placeholder ノードの memoName としてクライアントの可視ツリーに現れ、かつ実ファイルも
      // 1:1 で存在するため、実ファイル/メタ突合の除外対象に含めてはならない（含めると scannedNames
      // からだけ起点トークンが消え、nameSet との一致判定が恒常的に false になる）。除外対象は
      // 「ロックノードの子孫の難読化トークンのみ」に絞る。
      const descendantClaimedTokens = new Set(
        [...claimedTokens].filter((token) => !lockedByName.has(token))
      );

      // 【v3 M8 / テスターM8-T1-01対応】crypto:unlockNode 成功後、レンダラのローカルツリー状態は
      // 当該ノードを実名（`realMemoName`）ベースの展開済み構造へ丸ごと差し替える
      // （App.tsx handleCryptoDialogSubmit の unlockNode 分岐）。そのため以後クライアントが送って
      // くる treeStructure には、この起点ノード（および子孫）がトークン名ではなく実名で含まれる。
      // lockedByName はトークンキーのため一致せず、下の reattachLocks が「ロックなしの普通の
      // ノード」として通過させてしまうと、ディスク上は依然トークン名の .txtenc のままの実ファイル
      // 群と nameSet（実名ベース）が一致せず恒常的に NOT_FOUND になる（M8-T1-01）。
      // アクティブなセッション（nodeLockSessionStore、キー=(tabId, lockToken=起点トークン)）を
      // 一覧して実名 -> (トークン, ロック中MetaTreeNode) の逆引きを構築し、reattachLocks が
      // 実名ノードも検出できるようにする。セッション配下の変更内容（開閉・ラベル等）は M8 スコープ外
      // （M9 でセッション中の構造変更に対応予定）のため反映せず、ディスク上のロック placeholder へ
      // 差し戻す（無視する）。
      const sessionsByRealName = new Map<string, { lockToken: string; locked: MetaTreeNode }>();
      for (const [token, locked] of lockedByName) {
        const session = getNodeLockSession(args.tabId, token);
        if (session) {
          sessionsByRealName.set(session.realMemoName, { lockToken: token, locked });
        }
      }

      // ロック中ノードには `lock` を再付与し、children を強制的に空へ戻す（クライアントの誤送信/
      // 改ざんを信頼しない多層防御）。
      function reattachLocks(nodes: MetaTreeNode[]): MetaTreeNode[] {
        return nodes.map((n) => {
          const locked = lockedByName.get(n.memoName);
          if (locked) {
            return { memoName: n.memoName, expanded: n.expanded, lock: locked.lock, children: [] };
          }
          const session = sessionsByRealName.get(n.memoName);
          if (session) {
            return { memoName: session.lockToken, expanded: session.locked.expanded, lock: session.locked.lock, children: [] };
          }
          return { ...n, children: reattachLocks(n.children) };
        });
      }
      const finalStructure = reattachLocks(args.treeStructure);

      const scannedNames = new Set(
        scanned.map((s) => s.memoName).filter((n) => !descendantClaimedTokens.has(n))
      );

      const flatNames: string[] = [];
      (function flatten(nodes: MetaTreeNode[]): void {
        for (const n of nodes) {
          flatNames.push(n.memoName);
          flatten(n.children);
        }
      })(finalStructure);

      const nameSet = new Set(flatNames);
      if (nameSet.size !== flatNames.length) {
        return err('NAME_DUPLICATE', '送信されたツリー構造内にメモ名の重複があります。');
      }
      const setsMatch = nameSet.size === scannedNames.size && [...nameSet].every((n) => scannedNames.has(n));
      if (!setsMatch) {
        return err(
          'NOT_FOUND',
          'ツリー構造が実ファイルと一致しません。画面を再読み込みしてから再度お試しください。',
          folderPath
        );
      }

      await saveTabMeta(folderPath, finalStructure);
      return ok(undefined);
    })
  );
}
