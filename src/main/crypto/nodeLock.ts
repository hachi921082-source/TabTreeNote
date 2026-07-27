// src/main/crypto/nodeLock.ts
// v3 M8: ノード（サブツリー）単位パスワードロックのオーケストレーション
// （docs/v3/DESIGNv3.md §1、docs/v3/PLANv3.md §5.1/§5.2/§5.3(一部)、
// docs/v3/milestones/M8-node-lock-core.md）。
// v3 M9a（docs/v3/milestones/M9a-node-lock-session-ops.md）で以下を追加した:
//   - `lockNode`/`unlockNode` への `lockContext` 引数（入れ子ロック、PLANv3 §7.4）。
//   - `persistNodeLockSession`（セッション中の構造変更の都度、対象セッション（および入れ子の
//     場合は祖先セッションを再帰的に辿って）再暗号化しメタJSONへアトミック保存する、
//     DESIGNv3 §1.5「操作の都度、即座に再暗号化・アトミック保存」）。
//   - `readSessionMemoContent`/`writeSessionMemoContent`（セッション配下メモ本文の読込/保存。
//     `memo:read`/`memo:save` の `lockContext` 分岐が使う。ipc/memoHandlers.ts 参照）。
// 既存 M6 暗号化プリミティブ（cipher.ts, AES-256-GCM + scrypt）をそのまま再利用する。
//
// セキュリティ不変条件（00-core-principles.md §10）: 鍵・パスワード・復号平文はメインに閉じ、
// レンダラへは復号済みの「名前・階層構造」のみ渡す（鍵/パスワードは渡さない）。内部ログにも
// 鍵・パスワード・復号平文・実名は一切出力しない。
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { CryptoUnlockNodeResult, LockContext } from '@shared/ipc-contract';
import { MEMO_EXT_ENCRYPTED, SCRYPT_DEFAULTS } from '@shared/constants';
import type { Eol, MetaTreeNode, NodeLock, NodeLockBlob, Result, SaveResult } from '@shared/models';
import { err, ok } from '../util/result';
import { getTabFolderPath } from '../fs/tabService';
import { findMemoFile, readMemo, scanTabFolder } from '../fs/memoFileService';
import { findNode, loadTabMeta, saveTabMeta } from '../fs/metaStore';
import { atomicWrite } from '../fs/atomicWrite';
import { withRetry } from '../fs/retry';
import { consumeSelfWrite, registerSelfWrite } from '../watch/selfWriteRegistry';
import { decryptBuffer, deriveKey, encryptBuffer, generateIv, generateSalt } from './cipher';
import { buildTxtEncFile, parseTxtEncFile, serializeTxtEncFile } from './encFormat';
import { generateUniqueObfuscatedName } from './obfuscatedNaming';
import {
  buildOriginTreeNode,
  deleteAllNodeLockSessionsForTab,
  deleteNodeLockSession,
  getNodeLockSession,
  setNodeLockSession,
  type NodeLockSessionEntry
} from './nodeLockSessionStore';
import { removeMemo as removeMemoFromIndex } from '../search/searchIndex';
import { hashBytes } from '../util/hash';

/** 誤パスワード時のメッセージにヒントを付与する（既存 M6 パターンと同一）。 */
function decryptFailedMessage(hint: string | undefined): string {
  return hint ? `パスワードが違います。（ヒント: ${hint}）` : 'パスワードが違います。';
}

/**
 * 部分木(起点を含む)を平坦なリストへ集める。
 * 【v3 M9b】`memoHandlers.ts` の `moveIntoSession`（「外→内」境界跨ぎ移動・コピー）からも
 * 共用するため export する。
 */
export function flattenSubtree(node: MetaTreeNode, out: MetaTreeNode[] = []): MetaTreeNode[] {
  out.push(node);
  for (const child of node.children) flattenSubtree(child, out);
  return out;
}

/**
 * 【v3 M8/M9b】変換元ファイルを削除する（新ファイル永続化(fsync)確認後に旧ファイルを削除する順序、
 * PLANv3 §7.7）。呼び出し元は既に新ファイルの書込みが成功していることを確認済みであることが前提。
 * `lockNode`（既存M8）と `memoHandlers.ts` の `moveIntoSession`（v3 M9b、「外→内」境界跨ぎ移動）の
 * 両方から共用する。
 */
export async function deleteConvertedSourceFile(oldPath: string): Promise<void> {
  registerSelfWrite(oldPath, { kind: 'delete' });
  try {
    await withRetry(() => fs.unlink(oldPath));
  } catch (e) {
    consumeSelfWrite(oldPath);
    throw e;
  }
}

/**
 * 【v3 M9a】ロック対象の部分木メンバー1件分の平文本文+改行コードを読み込む。
 * - `parentEntry` 省略時（`lockContext` 無し=通常領域）: 既存M8ロジック。実ファイルは常に
 *   平文でなければならない（既存 `.txtenc` が混在していれば `LOCK_CONTAINS_ENCRYPTED`、
 *   DESIGNv3 §1.10）。
 * - `parentEntry` 指定時（入れ子ロック）: 親セッション配下のファイルは常に親セッションの鍵で
 *   暗号化済みの `.txtenc`（DESIGNv3 §1.5）のため、親の鍵で復号して平文を得る。
 */
export async function readSubtreeMember(
  folderPath: string,
  n: MetaTreeNode,
  parentEntry: NodeLockSessionEntry | undefined
): Promise<Result<{ contentLF: string; eol: Eol; oldPath: string; format: 'plain' | 'markdown' }>> {
  if (!parentEntry) {
    const found = await findMemoFile(folderPath, n.memoName);
    if (!found) return err('NOT_FOUND', `メモが見つかりません: ${n.memoName}`, folderPath);
    if (found.encrypted) {
      return err(
        'LOCK_CONTAINS_ENCRYPTED',
        '暗号化済みのメモが含まれています。先に個別の暗号化を解除してください。',
        found.path
      );
    }
    const plainRead = await readMemo(folderPath, n.memoName);
    if (!plainRead.ok) return plainRead;
    return ok({ contentLF: plainRead.value.contentLF, eol: plainRead.value.eol, oldPath: found.path, format: found.format });
  }

  const token = parentEntry.nameMap[n.memoName];
  if (!token) return err('NOT_FOUND', `メモが見つかりません: ${n.memoName}`, folderPath);
  const oldPath = join(folderPath, `${token}${MEMO_EXT_ENCRYPTED}`);
  const raw = await fs.readFile(oldPath).catch(() => null);
  if (!raw) return err('NOT_FOUND', `メモが見つかりません: ${n.memoName}`, folderPath);
  const file = parseTxtEncFile(raw);
  if (!file) return err('DECRYPT_FAILED', 'ファイル形式が不正です（読み込めません）。', oldPath);
  let plaintext: Buffer;
  try {
    plaintext = decryptBuffer(parentEntry.key, file.cipher.ivB64, file.cipher.tagB64, file.ciphertextB64);
  } catch {
    // 親セッションの鍵で復号できない＝メタ情報の内部不整合（本来起こり得ない防御的分岐）。
    return err('DECRYPT_FAILED', 'ロック情報の復号に失敗しました。', oldPath);
  }
  // 【2026-07-26追記・v3 M10b前提】親セッション配下から読む場合、個々の `.txtenc` ヘッダの
  // `format` は参照せず親セッションの `formatMap` を使う（DESIGNv3 §1.13「伝播の設計」1、
  // M10b-markdown-live-preview.md §0.2）。
  return ok({
    contentLF: plaintext.toString('utf-8'),
    eol: file.eol,
    oldPath,
    format: parentEntry.formatMap[n.memoName] ?? 'plain'
  });
}

/**
 * v3 M8/M9a: `crypto:lockNode`（対象ノード配下=起点+子孫を丸ごとロックする）。
 * `lockContext` 省略時の処理フローは docs/v3/milestones/M8-node-lock-core.md「ロック実行フロー」、
 * 指定時（入れ子ロック）は docs/v3/milestones/M9a-node-lock-session-ops.md「入れ子ロック」を参照。
 */
export async function lockNode(
  tabId: string,
  memoName: string,
  password: string,
  hint: string | undefined,
  lockContext?: LockContext
): Promise<Result<void>> {
  const folder = getTabFolderPath(tabId);
  if (!folder.ok) return folder;
  const folderPath = folder.value;

  // 【v3 M9a】起点ノードの探索先: lockContext 指定時は親セッションの実行時構造(children)上、
  // 省略時は既存M8通りタブ直下のメタツリー上（PLANv3 §7.4「対象セッションの実行時構造上で
  // 起点ノードを探してロック/解除処理を行う分岐」）。
  const parentLockToken = lockContext?.lockToken;
  let parentEntry: NodeLockSessionEntry | undefined;
  let loadedMetaTree: MetaTreeNode[] | undefined;
  let searchTree: MetaTreeNode[];
  if (parentLockToken) {
    parentEntry = getNodeLockSession(tabId, parentLockToken);
    if (!parentEntry) {
      return err('LOCK_SESSION_NOT_FOUND', 'ロックセッションが見つかりません（既に再ロックされた可能性があります）。');
    }
    searchTree = parentEntry.children;
  } else {
    const loaded = await loadTabMeta(folderPath);
    loadedMetaTree = loaded.metaTree;
    searchTree = loaded.metaTree;
  }

  const location = findNode(searchTree, memoName);
  if (!location) return err('NOT_FOUND', `メモが見つかりません: ${memoName}`, folderPath);
  const originNode = location.node;

  const subtree = flattenSubtree(originNode);

  // 1. 個別暗号化(.txtenc)混在チェック（いずれかが既存M6暗号化なら中断, DESIGNv3 §1.10）+
  //    既に別のノードロックが掛かっている部分木混在チェック（多重ロックは非対応。DESIGNv3/PLANv3に
  //    明記は無いが、透過的に再暗号化できないコンテンツを含む点でLOCK_CONTAINS_ENCRYPTEDと同趣旨の
  //    安全側の判断, developer判断）。実ファイル所在確認も兼ねる。この段階ではまだファイルへ
  //    一切触れない。
  for (const n of subtree) {
    if (n.lock) {
      return err('LOCK_CONTAINS_ENCRYPTED', '既にロックされているノードが含まれています。', folderPath);
    }
  }
  const reads = new Map<string, { contentLF: string; eol: Eol; oldPath: string; format: 'plain' | 'markdown' }>();
  for (const n of subtree) {
    const read = await readSubtreeMember(folderPath, n, parentEntry);
    if (!read.ok) return read;
    reads.set(n.memoName, read.value);
  }

  // 2. パスワードから新規salt+非同期scryptで鍵導出（既存cipher.tsを再利用）。
  const salt = generateSalt();
  const key = await deriveKey(password, salt, SCRYPT_DEFAULTS);

  // 3. 起点+子孫それぞれについて難読化ファイル名を採番（同一フォルダ内衝突時は再生成, DESIGNv3 §1.4）。
  //    ノードロックのファイルは常にタブフォルダ直下にフラットに置かれるため、入れ子ロックでも
  //    フォルダ全体を走査すれば衝突を検出できる（既存M8ロジックと同一）。
  const existingScanned = await scanTabFolder(folderPath);
  const takenTokens = new Set(existingScanned.map((s) => s.memoName));
  const nameMap: Record<string, string> = {};
  // 【2026-07-26追記・v3 M10b前提】nameMap を構築する同じループで formatMap も構築する
  // （M10b-markdown-live-preview.md §0.2）。
  const formatMap: Record<string, 'plain' | 'markdown'> = {};
  for (const n of subtree) {
    const token = generateUniqueObfuscatedName(takenTokens);
    takenTokens.add(token);
    nameMap[n.memoName] = token;
    const read = reads.get(n.memoName);
    formatMap[n.memoName] = read?.format ?? 'plain';
  }

  // 4. 各ファイルを .txtenc化(平文/親鍵暗号化のいずれも新規鍵で暗号化し直す)した上で難読化名で
  //    書込み。新ファイル永続化(fsync)確認後に旧ファイルを削除する順序（M6暗号化変換フロー、
  //    PLANv3 §7.7 と同じ順序）。
  const claimedTokens: string[] = [];
  for (const n of subtree) {
    const read = reads.get(n.memoName);
    if (!read) continue; // 型上ありえない（上のループで全件 reads に登録済み）。

    const iv = generateIv();
    const plaintext = Buffer.from(read.contentLF, 'utf-8');
    const { ivB64, tagB64, ciphertextB64 } = encryptBuffer(key, iv, plaintext);
    const container = buildTxtEncFile({
      saltB64: salt.toString('base64'),
      ivB64,
      tagB64,
      eol: read.eol,
      // 【2026-07-26追記・v3 M10b前提】自己記述性のための多重化（セッション内ロジックは
      // formatMap を参照するため本フィールド自体は参照しないが書いておく, §0.2）。
      format: read.format,
      ciphertextB64,
      kdf: SCRYPT_DEFAULTS
    });
    const data = serializeTxtEncFile(container);

    const token = nameMap[n.memoName];
    if (!token) continue; // 型上ありえない。
    const newPath = join(folderPath, `${token}${MEMO_EXT_ENCRYPTED}`);
    await atomicWrite(newPath, data);

    await deleteConvertedSourceFile(read.oldPath);

    claimedTokens.push(token);
    // 全文検索インデックスから該当配下の名前を除去（DESIGNv3 §1.7 Q1）。入れ子ロックの場合、
    // 親セッション配下は元々インデックス対象外のため no-op（冪等、既存ロジックの延長）。
    removeMemoFromIndex(tabId, n.memoName);
  }

  // 5. NodeLockBlob{ realMemoName, children, nameMap } を JSON化→鍵で暗号化(新IV)→Base64化。
  //    children は実名のまま保持してよい（ブロブ自体が暗号化されているため, DESIGNv3 §1.3）。
  const originToken = nameMap[originNode.memoName];
  if (!originToken) return err('UNKNOWN', 'ロック処理内部エラー: 起点ノードのトークンが未生成です。');
  const blob: NodeLockBlob = {
    realMemoName: originNode.memoName,
    children: structuredClone(originNode.children),
    nameMap,
    formatMap
  };
  const blobIv = generateIv();
  const blobPlain = Buffer.from(JSON.stringify(blob), 'utf-8');
  const blobEnc = encryptBuffer(key, blobIv, blobPlain);

  const lock: NodeLock = {
    kdf: { algo: 'scrypt', N: SCRYPT_DEFAULTS.N, r: SCRYPT_DEFAULTS.r, p: SCRYPT_DEFAULTS.p, keyLen: SCRYPT_DEFAULTS.keyLen },
    saltB64: salt.toString('base64'),
    ivB64: blobEnc.ivB64,
    tagB64: blobEnc.tagB64,
    blobCiphertextB64: blobEnc.ciphertextB64,
    claimedTokens
  };
  if (hint !== undefined && hint.length > 0) {
    lock.hint = hint;
  }

  // 6. 起点ノードのMetaTreeNodeを差し替える（label/editor/既存編集ロック等、通常フィールドは
  //    一切持たせない＝「🔒」以外の情報を露出しない, DESIGNv3 §1.2）。
  const lockedNode: MetaTreeNode = {
    memoName: originToken,
    expanded: false,
    children: [],
    lock
  };
  location.siblings[location.index] = lockedNode;

  // 7. 永続化。
  //    - lockContext 無し（通常領域）: 既存M8通り直接メタJSONをアトミック保存。
  //    - lockContext 有り（入れ子ロック）: ロックした部分木の実名はもう親セッションから
  //      直接アドレスできない（nameMap から除去, §5.3「起点ノード自身のリネーム」と同種の
  //      即時再暗号化保存）ため除去した上で、親セッション（および、その親がさらに入れ子なら
  //      祖先を再帰的に辿って）を再暗号化しメタJSONへアトミック保存する（PLANv3 §5.3 step4）。
  if (parentEntry && parentLockToken) {
    for (const n of subtree) {
      delete parentEntry.nameMap[n.memoName];
      delete parentEntry.formatMap[n.memoName];
    }
    const persisted = await persistNodeLockSession(tabId, parentLockToken);
    if (!persisted.ok) return persisted;
  } else if (loadedMetaTree) {
    await saveTabMeta(folderPath, loadedMetaTree);
  }

  return ok(undefined);
}

/**
 * v3 M8/M9a: `crypto:unlockNode`（ロック中ノードをパスワードで復号しセッション開始する）。
 * `lockContext` 省略時の処理フローは docs/v3/milestones/M8-node-lock-core.md「ロック解除フロー」、
 * 指定時（入れ子ロック）は docs/v3/milestones/M9a-node-lock-session-ops.md「入れ子ロック」を参照。
 * `memoName` はロック中ノードの難読化トークン（`crypto:lockNode` が書き換えた `memoName`）。
 */
export async function unlockNode(
  tabId: string,
  memoName: string,
  password: string,
  lockContext?: LockContext
): Promise<Result<CryptoUnlockNodeResult>> {
  const folder = getTabFolderPath(tabId);
  if (!folder.ok) return folder;
  const folderPath = folder.value;

  let lock: NodeLock;
  let parentLockToken: string | undefined;

  if (lockContext) {
    // 【v3 M9a 入れ子ロック】起点ノードを親セッションの実行時構造(children)上で探す
    // （ファイル操作・ブロブ暗号化ロジック自体はM8のものをそのまま再利用, PLANv3 §7.4）。
    const parentEntry = getNodeLockSession(tabId, lockContext.lockToken);
    if (!parentEntry) {
      return err('LOCK_SESSION_NOT_FOUND', 'ロックセッションが見つかりません（既に再ロックされた可能性があります）。');
    }
    const location = findNode(parentEntry.children, memoName);
    if (!location || !location.node.lock) {
      return err('NOT_FOUND', `ロック中のメモが見つかりません: ${memoName}`, folderPath);
    }
    lock = location.node.lock;
    parentLockToken = lockContext.lockToken;
  } else {
    const loaded = await loadTabMeta(folderPath);
    const location = findNode(loaded.metaTree, memoName);
    if (!location || !location.node.lock) {
      return err('NOT_FOUND', `ロック中のメモが見つかりません: ${memoName}`, folderPath);
    }
    lock = location.node.lock;
  }

  // 1-2. salt+KDFパラメータで鍵導出→blobCiphertextB64をIV+tagで復号。認証タグ検証失敗時は
  //      既存 DECRYPT_FAILED（本文含め一切返さない）。ネストの場合も、そのロック自身は独立した
  //      パスワード/鍵を持つ（親の鍵とは無関係, DESIGNv3の「常駐セッション方式」の自然な帰結）。
  const key = await deriveKey(password, Buffer.from(lock.saltB64, 'base64'), lock.kdf);
  let blobPlain: Buffer;
  try {
    blobPlain = decryptBuffer(key, lock.ivB64, lock.tagB64, lock.blobCiphertextB64);
  } catch {
    return err('DECRYPT_FAILED', decryptFailedMessage(lock.hint), folderPath);
  }

  let blob: NodeLockBlob;
  try {
    blob = JSON.parse(blobPlain.toString('utf-8')) as NodeLockBlob;
  } catch {
    return err('DECRYPT_FAILED', 'ロック情報の形式が不正です（読み込めません）。', folderPath);
  }

  // 3. 復号結果 NodeLockBlob をパースし、nodeLockSessionStore へ (tabId, lockToken=起点の難読化名)
  //    キーで保持する。入れ子の場合は parentLockToken も保持する（PLANv3 §7.4）。
  const lockToken = memoName;
  const entry: NodeLockSessionEntry = {
    key,
    saltB64: lock.saltB64,
    kdf: lock.kdf,
    hint: lock.hint,
    nameMap: blob.nameMap,
    // 【2026-07-26追記・v3 M10b前提】ブロブに formatMap が無い（本変更前に作成された既存ロック等）
    // 場合は空オブジェクトへフォールバックする（M10b-markdown-live-preview.md §0.2）。
    formatMap: blob.formatMap ?? {},
    children: blob.children,
    realMemoName: blob.realMemoName,
    parentLockToken
  };
  setNodeLockSession(tabId, lockToken, entry);

  // 4. realMemoName と children から実行時 TreeNode[] を構築（各ノードに lockToken を付与）して
  //    返却する。tree は起点ノード自身を含む単一要素配列（=可視ツリー上でロック済みプレースホルダ
  //    と丸ごと差し替えられる形。metaStore.reconcile が既存セッション再表示にも同じ構築関数
  //    buildOriginTreeNode/buildSessionTreeNodes を使うため、ロジックを二重管理しない）。
  const revealed = buildOriginTreeNode(entry, lockToken);
  return ok({ lockToken, tree: [revealed] });
}

/**
 * v3 M8: `crypto:relockNode`（単一セッションの明示的破棄。メモリ上の対応表・復号済み構造を
 * 破棄するのみでファイル操作は一切発生しない, DESIGNv3 §1.5）。
 * 存在しないセッションの破棄は no-op（既存 M6 `crypto:lock` と同じ冪等パターン）。
 * 【v3 M9a 注記】入れ子ロックがある状態で親セッションのみを再ロックした場合、子セッションの
 * `parentLockToken` は破棄済みの親を指したまま残る（ダングリング）。以後その子セッションへの
 * `persistNodeLockSession` は `LOCK_SESSION_NOT_FOUND` で安全に失敗する（M9aスコープでは
 * カスケード破棄は行わない。UIは親の再ロックで配下ごと🔒表示へ戻るため通常到達しない経路）。
 */
export function relockNode(tabId: string, lockToken: string): Result<void> {
  deleteNodeLockSession(tabId, lockToken);
  return ok(undefined);
}

/**
 * v3 M9c: `crypto:relockAllInTab`（タブ切替時のセッション一括破棄。`relockNode` のループ相当、
 * ファイル操作は一切発生しない, docs/v3/milestones/M9c-node-lock-tab-switch.md）。
 * 対象タブにセッションが1件も無い場合も何もせず成功扱い（冪等）。
 */
export function relockAllInTab(tabId: string): Result<void> {
  deleteAllNodeLockSessionsForTab(tabId);
  return ok(undefined);
}

/**
 * 【v3 M9a】セッション（`entry`）の子ツリー構造ブロブを再暗号化する（`NodeLockBlob{realMemoName,
 * children,nameMap}` を鍵で暗号化(新IV)→`NodeLock` を構築, DESIGNv3 §1.5「操作の都度、即座に
 * 再暗号化」）。`claimedTokens` は常に現在の `nameMap`+入れ子ロックの `claimedTokens` から
 * 再計算する（リネーム・削除・入れ子ロック等で内容が変わるたびに古い値を使い回さないため）。
 */
function reencryptSessionBlob(entry: NodeLockSessionEntry): NodeLock {
  const blob: NodeLockBlob = {
    realMemoName: entry.realMemoName,
    children: entry.children,
    nameMap: entry.nameMap,
    formatMap: entry.formatMap
  };
  const iv = generateIv();
  const blobPlain = Buffer.from(JSON.stringify(blob), 'utf-8');
  const blobEnc = encryptBuffer(entry.key, iv, blobPlain);

  // claimedTokens = 現在 nameMap が指す全トークン（起点自身+非ロック子孫）∪ 入れ子ロックが
  // 占有するトークン（各ノードの lock.claimedTokens は既に自身の配下を再帰的に含んでいる,
  // PLANv3 §7.1 の延長）。
  const claimed = new Set<string>(Object.values(entry.nameMap));
  (function collectNestedClaims(nodes: MetaTreeNode[]): void {
    for (const n of nodes) {
      if (n.lock) {
        for (const t of n.lock.claimedTokens) claimed.add(t);
      } else {
        collectNestedClaims(n.children);
      }
    }
  })(entry.children);

  const lock: NodeLock = {
    kdf: { algo: 'scrypt', N: entry.kdf.N, r: entry.kdf.r, p: entry.kdf.p, keyLen: entry.kdf.keyLen },
    saltB64: entry.saltB64,
    ivB64: blobEnc.ivB64,
    tagB64: blobEnc.tagB64,
    blobCiphertextB64: blobEnc.ciphertextB64,
    claimedTokens: [...claimed]
  };
  if (entry.hint !== undefined) lock.hint = entry.hint;
  return lock;
}

/**
 * 【v3 M9a・最重要】セッション中の構造変更操作の都度、対象セッションを再暗号化してメタJSONへ
 * アトミック保存する（DESIGNv3 §1.5「操作の都度、即座に再暗号化・アトミック保存する」。
 * 「再ロック時にまとめて確定保存」は途中クラッシュで全構造変更が失われるため不可）。
 * 入れ子ロック（`entry.parentLockToken` 有り）の場合は、対象ノードを親セッションの `children`
 * 内で更新した上で親セッション自身を再帰的に同じ処理へ渡す（祖先を辿り、最終的にトップレベルの
 * メタツリーへ到達した時点で一度だけ `saveTabMeta` する、PLANv3 §7.4）。
 */
export async function persistNodeLockSession(tabId: string, lockToken: string): Promise<Result<void>> {
  const entry = getNodeLockSession(tabId, lockToken);
  if (!entry) {
    return err('LOCK_SESSION_NOT_FOUND', 'ロックセッションが見つかりません（既に再ロックされた可能性があります）。');
  }
  const folder = getTabFolderPath(tabId);
  if (!folder.ok) return folder;
  const folderPath = folder.value;

  const updatedLock = reencryptSessionBlob(entry);
  const lockedNode: MetaTreeNode = { memoName: lockToken, expanded: false, children: [], lock: updatedLock };

  if (!entry.parentLockToken) {
    const loaded = await loadTabMeta(folderPath);
    const location = findNode(loaded.metaTree, lockToken);
    if (!location) {
      return err('LOCK_SESSION_NOT_FOUND', 'ロック対象ノードがメタ情報から見つかりません。', folderPath);
    }
    location.siblings[location.index] = lockedNode;
    await saveTabMeta(folderPath, loaded.metaTree);
    return ok(undefined);
  }

  const parentEntry = getNodeLockSession(tabId, entry.parentLockToken);
  if (!parentEntry) {
    return err(
      'LOCK_SESSION_NOT_FOUND',
      '親ロックセッションが見つかりません（既に再ロックされた可能性があります）。',
      folderPath
    );
  }
  const parentLocation = findNode(parentEntry.children, lockToken);
  if (!parentLocation) {
    return err('LOCK_SESSION_NOT_FOUND', 'ロック対象ノードが親セッション内に見つかりません。', folderPath);
  }
  parentLocation.siblings[parentLocation.index] = lockedNode;
  return persistNodeLockSession(tabId, entry.parentLockToken);
}

/**
 * 【v3 M9a】セッション配下メモ本文の読込（`memo:read` の `lockContext` 分岐用）。既存
 * `crypto:open` と同種の復号処理をセッション鍵で行う（DESIGNv3 §1.5「常駐セッション方式」。
 * セッション配下の実ファイルは常に `.txtenc` のため、通常の平文 `readMemo` は使えない）。
 */
export async function readSessionMemoContent(
  folderPath: string,
  entry: NodeLockSessionEntry,
  token: string
): Promise<Result<{ contentLF: string; eol: Eol; hash: string }>> {
  const path = join(folderPath, `${token}${MEMO_EXT_ENCRYPTED}`);
  const raw = await fs.readFile(path).catch(() => null);
  if (!raw) return err('NOT_FOUND', 'メモが見つかりません。', path);
  const file = parseTxtEncFile(raw);
  if (!file) return err('DECRYPT_FAILED', 'ファイル形式が不正です（読み込めません）。', path);
  let plaintext: Buffer;
  try {
    plaintext = decryptBuffer(entry.key, file.cipher.ivB64, file.cipher.tagB64, file.ciphertextB64);
  } catch {
    return err('DECRYPT_FAILED', decryptFailedMessage(entry.hint), path);
  }
  // hash は .txtenc ファイル全体のバイト列（次回保存の競合判定用, 00-core-principles.md §6）。
  return ok({ contentLF: plaintext.toString('utf-8'), eol: file.eol, hash: hashBytes(raw) });
}

/**
 * 【v3 M9a】セッション配下メモ本文の保存（`memo:save` の `lockContext` 分岐用）。既存
 * `crypto:saveEncrypted` と同じハッシュ一発判定の競合チェック（00-core-principles.md §5）を行い、
 * 毎回新しい IV で再暗号化する（IV 再利用禁止, DESIGN §2.9）。ヒントは個々のファイルには付けない
 * （M8 `lockNode` と同じ方針。ヒントは `NodeLock` 側にのみ保持する）。
 */
export async function writeSessionMemoContent(
  folderPath: string,
  entry: NodeLockSessionEntry,
  token: string,
  contentLF: string,
  eol: Eol,
  expectedHash: string | undefined,
  /**
   * 【2026-07-26追記・v3 M10b前提】必須。呼び出し元が明示的に決定して渡す（内部で `formatMap` を
   * 更新する責務は持たせない＝呼び出し元が責務を持つ, M10b-markdown-live-preview.md §0.2）。
   */
  format: 'plain' | 'markdown'
): Promise<Result<SaveResult>> {
  const path = join(folderPath, `${token}${MEMO_EXT_ENCRYPTED}`);

  if (expectedHash !== undefined) {
    const currentRaw = await fs.readFile(path).catch(() => null);
    if (!currentRaw) return err('CONFLICT', '保存前にメモが外部で削除されています。', path);
    if (hashBytes(currentRaw) !== expectedHash) {
      return err('CONFLICT', '保存前に外部でメモが変更されています。', path);
    }
  }

  const iv = generateIv();
  const plaintext = Buffer.from(contentLF, 'utf-8');
  const { ivB64, tagB64, ciphertextB64 } = encryptBuffer(entry.key, iv, plaintext);
  const container = buildTxtEncFile({
    saltB64: entry.saltB64,
    ivB64,
    tagB64,
    eol,
    format,
    ciphertextB64,
    kdf: entry.kdf
  });
  const data = serializeTxtEncFile(container);

  // atomicWrite（temp→fsync→.bak→rename）。.bak も暗号化済みデータ（平文は残らない, §2.6）。
  await atomicWrite(path, data);
  return ok({ savedHash: hashBytes(data) });
}
