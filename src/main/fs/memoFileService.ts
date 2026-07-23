// src/main/fs/memoFileService.ts
// .txt/.txtenc の read/write/rename（M1 は read/save/rename 中心, PLAN §3）。
// フォルダ直下走査（リンク無視）もここに置く（metaStore/tabService から利用される）。
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { MEMO_EXT_ENCRYPTED, MEMO_EXT_PLAIN, TEMP_FILE_PREFIX, BACKUP_SUFFIX } from '@shared/constants';
import type { MemoReadResult, Result, SaveResult } from '@shared/models';
import { err, ok } from '../util/result';
import { atomicWrite } from './atomicWrite';
import { decodeBuffer, decodeBufferAs, encodeText, type DetectedEncoding } from './encoding';
import { detectEol, normalizeToLf, restoreEol } from './eol';
import { hashBytes } from '../util/hash';
import { isLongPath, isPathContained, normalizeForCompare, validateName } from './pathSafety';
import { consumeSelfWrite, refineSelfWriteExpectation, registerSelfWrite } from '../watch/selfWriteRegistry';
import { withRetry } from './retry';
import { deletePathDirect, trashPath } from './trash';

/**
 * `memoName` に由来する実ファイルパスを構築する前に、fs 層として一元的に安全性を検証する
 * （reviewer 指摘 M1-R1-01: memoName がフォルダ閉じ込め・禁止文字/長パスの検証を経ずに
 * `join(folderPath, memoName+ext)` へ直結していた欠落を修正）。
 * `validateName` は `\ / : * ? " < > |` を禁止しているため通常はこの時点でトラバーサル文字列を
 * 弾けるが、`isPathContained` による構築後の閉じ込め確認を防御的に併用する（多層防御）。
 */
function validateMemoNameForPath(folderPath: string, memoName: string): Result<void> {
  const nameCheck = validateName(memoName);
  if (!nameCheck.ok) return nameCheck;

  const candidate = join(folderPath, `${memoName}${MEMO_EXT_PLAIN}`);
  if (!isPathContained(folderPath, candidate)) {
    return err('NAME_INVALID', `不正なメモ名です: ${memoName}`);
  }
  if (isLongPath(candidate)) {
    return err('LONG_PATH', `パスが長すぎます（260文字超）: ${candidate}`, candidate);
  }
  return ok(undefined);
}

export interface ScannedMemo {
  memoName: string;
  encrypted: boolean;
}

/**
 * フォルダ直下の `.txt`/`.txtenc` を走査する（直下のみ、シンボリックリンク/ジャンクション無視,
 * DESIGN §2.2）。一時ファイル・`.bak`・メタ JSON は対象外。
 */
export async function scanTabFolder(folderPath: string): Promise<ScannedMemo[]> {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const result: ScannedMemo[] = [];

  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(TEMP_FILE_PREFIX)) continue;
    if (entry.name.endsWith(BACKUP_SUFFIX)) continue;

    // シンボリックリンク/ジャンクションは対象外（実ファイルかどうかを lstat で確認）。
    const lstat = await fs.lstat(join(folderPath, entry.name));
    if (lstat.isSymbolicLink()) continue;
    if (!lstat.isFile()) continue;

    if (entry.name.endsWith(MEMO_EXT_ENCRYPTED)) {
      result.push({ memoName: entry.name.slice(0, -MEMO_EXT_ENCRYPTED.length), encrypted: true });
    } else if (entry.name.endsWith(MEMO_EXT_PLAIN)) {
      result.push({ memoName: entry.name.slice(0, -MEMO_EXT_PLAIN.length), encrypted: false });
    }
  }

  return result;
}

/** 指定メモ名の実ファイルパスを解決する（`.txt`/`.txtenc` のどちらが存在するかを確認）。 */
export async function findMemoFile(
  folderPath: string,
  memoName: string
): Promise<{ path: string; encrypted: boolean } | null> {
  const plainPath = join(folderPath, `${memoName}${MEMO_EXT_PLAIN}`);
  const encPath = join(folderPath, `${memoName}${MEMO_EXT_ENCRYPTED}`);

  const [plainExists, encExists] = await Promise.all([pathExists(plainPath), pathExists(encPath)]);
  if (plainExists) return { path: plainPath, encrypted: false };
  if (encExists) return { path: encPath, encrypted: true };
  return null;
}

/**
 * 実ファイル操作（rename/copy）完了直後に、書き込まれた内容を読み直して自己書き込み予約の
 * 期待値（サイズ+ハッシュ）を補完する（M4）。対象は常に小容量の個人用メモ想定のため、
 * 補完専用の読み直しコストは許容する（developer 判断）。読み直しに失敗しても（極めて稀）
 * 期待値が未確定のまま残るだけで、watch/conflict.ts 側は安全側（自己発火扱い）に倒れる。
 */
async function refineUpsertFromDisk(path: string): Promise<void> {
  const buf = await fs.readFile(path).catch(() => null);
  if (!buf) return;
  refineSelfWriteExpectation(path, { kind: 'upsert', size: buf.length, hash: hashBytes(buf) });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/** 平文 `.txt` を読み込む。`.txtenc` の場合は本文を返さず暗号化フラグのみ（M1 スコープ, PLAN §2.2）。 */
export async function readMemo(folderPath: string, memoName: string): Promise<Result<MemoReadResult>> {
  const nameCheck = validateMemoNameForPath(folderPath, memoName);
  if (!nameCheck.ok) return nameCheck;

  const found = await findMemoFile(folderPath, memoName);
  if (!found) return err('NOT_FOUND', `メモが見つかりません: ${memoName}`, folderPath);

  const buf = await fs.readFile(found.path);
  const hash = hashBytes(buf);

  if (found.encrypted) {
    // 復号は M6 スコープ。M1 では本文を返さず暗号化フラグのみ返す。
    return ok({ contentLF: '', encoding: 'utf-8', eol: 'lf', encrypted: true, hash });
  }

  const { text, encoding } = decodeBuffer(buf);
  const eol = detectEol(text);
  const contentLF = normalizeToLf(text);
  return ok({ contentLF, encoding, eol, encrypted: false, hash });
}

/** エンコーディングを明示指定して `.txt` を開き直す（`memo:readWithEncoding`, DESIGN §2.3）。 */
export async function readMemoWithEncoding(
  folderPath: string,
  memoName: string,
  encoding: DetectedEncoding
): Promise<Result<MemoReadResult>> {
  const nameCheck = validateMemoNameForPath(folderPath, memoName);
  if (!nameCheck.ok) return nameCheck;

  const found = await findMemoFile(folderPath, memoName);
  if (!found) return err('NOT_FOUND', `メモが見つかりません: ${memoName}`, folderPath);
  if (found.encrypted) {
    return err('NAME_INVALID', '暗号化メモはエンコーディング指定で開けません。', found.path);
  }

  const buf = await fs.readFile(found.path);
  const hash = hashBytes(buf);
  const text = decodeBufferAs(buf, encoding);
  const eol = detectEol(text);
  const contentLF = normalizeToLf(text);
  return ok({ contentLF, encoding, eol, encrypted: false, hash });
}

/**
 * 平文メモを保存する（PLAN §5.2）。
 * 1. 競合チェック（`expectedHash` 指定時、現在のディスク実体ハッシュと一致するか一発判定）。
 * 2. EOL 復元 → エンコード → `atomicWrite`。
 */
export async function saveMemo(
  folderPath: string,
  memoName: string,
  contentLF: string,
  eol: MemoReadResult['eol'],
  encoding: DetectedEncoding,
  expectedHash: string | undefined
): Promise<Result<SaveResult>> {
  const nameCheck = validateMemoNameForPath(folderPath, memoName);
  if (!nameCheck.ok) return nameCheck;

  const targetPath = join(folderPath, `${memoName}${MEMO_EXT_PLAIN}`);

  if (expectedHash !== undefined) {
    const currentExists = await pathExists(targetPath);
    if (currentExists) {
      const currentBuf = await fs.readFile(targetPath);
      const currentHash = hashBytes(currentBuf);
      if (currentHash !== expectedHash) {
        return err('CONFLICT', '保存前に外部でメモが変更されています。', targetPath);
      }
    }
    // 期待ハッシュ指定時にファイルが存在しない（外部で削除された等）場合も競合として扱う。
    if (!currentExists) {
      return err('CONFLICT', '保存前にメモが外部で削除されています。', targetPath);
    }
  }

  const restored = restoreEol(contentLF, eol);
  const data = encodeText(restored, encoding);
  await atomicWrite(targetPath, data);
  const savedHash = hashBytes(data);
  return ok({ savedHash });
}

/** 新規の空メモ `.txt` を作成する（重複チェックは呼び出し側=metaStore 連携側で実施）。 */
export async function createEmptyMemoFile(folderPath: string, memoName: string): Promise<Result<void>> {
  const nameCheck = validateMemoNameForPath(folderPath, memoName);
  if (!nameCheck.ok) return nameCheck;

  const targetPath = join(folderPath, `${memoName}${MEMO_EXT_PLAIN}`);
  await atomicWrite(targetPath, Buffer.alloc(0));
  return ok(undefined);
}

/**
 * メモファイルをリネームする（実ファイル操作。呼び出し側が同期順序 §3.3
 * ①ストア更新→②本関数→③メタ保存 の順で呼ぶこと）。`fs.rename` 前に自己書き込み予約を登録する。
 * `oldName`/`newName` 双方をパス閉じ込め検証してから解決する（reviewer 指摘 M1-R1-01）。
 */
export async function renameMemoFile(folderPath: string, oldName: string, newName: string): Promise<Result<void>> {
  const oldNameCheck = validateMemoNameForPath(folderPath, oldName);
  if (!oldNameCheck.ok) return oldNameCheck;
  const newNameCheck = validateMemoNameForPath(folderPath, newName);
  if (!newNameCheck.ok) return newNameCheck;

  const found = await findMemoFile(folderPath, oldName);
  if (!found) return err('NOT_FOUND', `メモが見つかりません: ${oldName}`, folderPath);

  const ext = found.encrypted ? MEMO_EXT_ENCRYPTED : MEMO_EXT_PLAIN;
  const newPath = join(folderPath, `${newName}${ext}`);

  registerSelfWrite(found.path, { kind: 'delete' });
  registerSelfWrite(newPath);
  try {
    await withRetry(() => fs.rename(found.path, newPath));
  } catch (e) {
    // rename 失敗時は事前登録した予約を解放する（reviewer 指摘 M4-R1-01、atomicWrite.ts の
    // 既存パターンに合わせる）。解放しないと TTL 満了まで登録が残り、その間の真の外部変更を
    // 自己発火と誤判定して握りつぶし得る。
    consumeSelfWrite(found.path);
    consumeSelfWrite(newPath);
    throw e;
  }
  // リネームは内容を変えないが、旧パスの内容を保持していないため新パスを読み直して
  // 期待ハッシュを補完する（M4、自己発火判定の精度確保）。
  await refineUpsertFromDisk(newPath);
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// M2: 削除（ごみ箱+フォールバック）/複製/移動・コピー（PLAN §2.2/§5.3、docs/milestones/M2-tree-ui.md）
// ---------------------------------------------------------------------------

/** `folderPath` 内の `memoName` の実ファイルパスを検証込みで解決する（存在しなければ NOT_FOUND）。 */
async function resolveMemoPath(folderPath: string, memoName: string): Promise<Result<{ path: string; encrypted: boolean }>> {
  const nameCheck = validateMemoNameForPath(folderPath, memoName);
  if (!nameCheck.ok) return nameCheck;
  const found = await findMemoFile(folderPath, memoName);
  if (!found) return err('NOT_FOUND', `メモが見つかりません: ${memoName}`, folderPath);
  return ok(found);
}

/**
 * `reservedNames`（大文字小文字非区別で比較, NTFS 準拠）の中で衝突しない名前を返す。
 * `desired` が未使用ならそのまま返す。使用済みなら「`desired` のコピー」「`desired` のコピー (2)」…
 * と採番する（複製 `memo:duplicate` と、コピー系 `memo:move` の両方で共用する命名規則）。
 */
export function pickAvailableName(reservedNames: ReadonlySet<string>, desired: string): string {
  const has = (candidate: string): boolean => {
    const target = normalizeForCompare(candidate);
    for (const r of reservedNames) {
      if (normalizeForCompare(r) === target) return true;
    }
    return false;
  };
  if (!has(desired)) return desired;
  let n = 2;
  let candidate = `${desired} のコピー`;
  while (has(candidate)) {
    candidate = `${desired} のコピー (${n})`;
    n++;
  }
  return candidate;
}

/** メモを複製する（fs 操作のみ。メタツリーへの挿入は呼び出し側 IPC handler の責務, §3.2 同期順序）。 */
export async function duplicateMemoFile(
  folderPath: string,
  memoName: string
): Promise<Result<{ newName: string; encrypted: boolean }>> {
  const found = await resolveMemoPath(folderPath, memoName);
  if (!found.ok) return found;

  const scanned = await scanTabFolder(folderPath);
  const existingNames = new Set(scanned.map((s) => s.memoName));
  const newName = pickAvailableName(existingNames, memoName);

  const newNameCheck = validateMemoNameForPath(folderPath, newName);
  if (!newNameCheck.ok) return newNameCheck;

  const ext = found.value.encrypted ? MEMO_EXT_ENCRYPTED : MEMO_EXT_PLAIN;
  const destPath = join(folderPath, `${newName}${ext}`);

  registerSelfWrite(destPath);
  try {
    await withRetry(() => fs.copyFile(found.value.path, destPath));
  } catch (e) {
    // reviewer 指摘 M4-R1-01: copy 失敗時も予約を解放する（atomicWrite.ts と同一パターン）。
    consumeSelfWrite(destPath);
    throw e;
  }
  await refineUpsertFromDisk(destPath);
  return ok({ newName, encrypted: found.value.encrypted });
}

/**
 * 別タブ（別フォルダ）へメモを移動する（同一タブ内の移動は物理ファイルを動かす必要が無いため
 * 対象外。呼び出し側=IPC handler がタブ判定して呼び分ける）。`fs.rename` が別ボリューム間で
 * 失敗する `EXDEV` はコピー+削除へフォールバックする。
 */
export async function moveMemoFileToFolder(
  srcFolderPath: string,
  memoName: string,
  destFolderPath: string
): Promise<Result<void>> {
  const found = await resolveMemoPath(srcFolderPath, memoName);
  if (!found.ok) return found;
  const destCheck = validateMemoNameForPath(destFolderPath, memoName);
  if (!destCheck.ok) return destCheck;

  const ext = found.value.encrypted ? MEMO_EXT_ENCRYPTED : MEMO_EXT_PLAIN;
  const destPath = join(destFolderPath, `${memoName}${ext}`);

  registerSelfWrite(found.value.path, { kind: 'delete' });
  registerSelfWrite(destPath);
  try {
    await withRetry(async () => {
      try {
        await fs.rename(found.value.path, destPath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
          await fs.copyFile(found.value.path, destPath);
          await fs.unlink(found.value.path);
          return;
        }
        throw e;
      }
    });
  } catch (e) {
    // reviewer 指摘 M4-R1-01: rename/EXDEV フォールバック双方が全リトライ失敗した場合も
    // 予約を解放する（atomicWrite.ts と同一パターン）。
    consumeSelfWrite(found.value.path);
    consumeSelfWrite(destPath);
    throw e;
  }
  await refineUpsertFromDisk(destPath);
  return ok(undefined);
}

/** 別タブ（別フォルダ）へメモをコピーする（元は残す。宛先名は `destMemoName` を明示指定）。 */
export async function copyMemoFileToFolder(
  srcFolderPath: string,
  memoName: string,
  destFolderPath: string,
  destMemoName: string
): Promise<Result<void>> {
  const found = await resolveMemoPath(srcFolderPath, memoName);
  if (!found.ok) return found;
  const destCheck = validateMemoNameForPath(destFolderPath, destMemoName);
  if (!destCheck.ok) return destCheck;

  const ext = found.value.encrypted ? MEMO_EXT_ENCRYPTED : MEMO_EXT_PLAIN;
  const destPath = join(destFolderPath, `${destMemoName}${ext}`);

  registerSelfWrite(destPath);
  try {
    await withRetry(() => fs.copyFile(found.value.path, destPath));
  } catch (e) {
    // reviewer 指摘 M4-R1-01: copy 失敗時も予約を解放する（atomicWrite.ts と同一パターン）。
    consumeSelfWrite(destPath);
    throw e;
  }
  await refineUpsertFromDisk(destPath);
  return ok(undefined);
}

/** メモをごみ箱へ送る（既定の削除経路, PLAN §2.6）。 */
export async function deleteMemoFileViaTrash(folderPath: string, memoName: string): Promise<Result<void>> {
  const found = await resolveMemoPath(folderPath, memoName);
  if (!found.ok) return found;
  return trashPath(found.value.path);
}

/** ごみ箱送り失敗フォールバック用の直接削除（`forceDirect:true` 再 invoke でのみ呼ぶこと）。 */
export async function deleteMemoFileDirect(folderPath: string, memoName: string): Promise<Result<void>> {
  const found = await resolveMemoPath(folderPath, memoName);
  if (!found.ok) return found;
  await deletePathDirect(found.value.path);
  return ok(undefined);
}
