// src/main/ipc/cryptoHandlers.ts
// パスワード暗号化の IPC ハンドラ（PLAN §2.4、docs/milestones/M6-crypto.md、DESIGN §2.9）。
// 暗号化変換（平文原本直接削除・順序厳守）、開封/保存（新IV）/パスワード変更/ロックを扱う。
//
// セキュリティ不変条件（00-core-principles.md §10）: 鍵・パスワード・復号平文はメインに閉じ、
// レンダラへは復号「本文テキスト」のみ渡す（鍵/パスワードは渡さない）。内部ログにも
// 鍵・パスワード・復号平文は一切出力しない。
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import {
  IpcChannels,
  IpcEvents,
  type CryptoChangePasswordArgs,
  type CryptoDecryptToPlainArgs,
  type CryptoEncryptMemoArgs,
  type CryptoLockArgs,
  type CryptoLockNodeArgs,
  type CryptoOpenArgs,
  type CryptoOpenResult,
  type CryptoRelockAllInTabArgs,
  type CryptoRelockNodeArgs,
  type CryptoSaveEncryptedArgs,
  type CryptoUnlockNodeArgs,
  type CryptoUnlockNodeResult,
  type IndexUpdatedPayload
} from '@shared/ipc-contract';
import type { MemoInfo, Result, SaveResult } from '@shared/models';
import { MEMO_EXT_ENCRYPTED, MEMO_EXT_MARKDOWN, MEMO_EXT_PLAIN, SCRYPT_DEFAULTS } from '@shared/constants';
import { err, ok, wrapHandler } from '../util/result';
import { getTabFolderPath } from '../fs/tabService';
import { findMemoFile, readMemo, validateExistingMemoNameForPath } from '../fs/memoFileService';
import { atomicWrite } from '../fs/atomicWrite';
import { encodeText } from '../fs/encoding';
import { restoreEol } from '../fs/eol';
import { hashBytes } from '../util/hash';
import { withRetry } from '../fs/retry';
import { consumeSelfWrite, registerSelfWrite } from '../watch/selfWriteRegistry';
import { decryptBuffer, deriveKey, encryptBuffer, generateIv, generateSalt } from '../crypto/cipher';
import { buildTxtEncFile, parseTxtEncFile, serializeTxtEncFile, type TxtEncFile } from '../crypto/encFormat';
import { deleteSessionKey, getSessionKey, setSessionKey } from '../crypto/sessionKeyStore';
import { updateMemo as updateMemoIndex } from '../search/searchIndex';
import { lockNode, relockAllInTab, relockNode, unlockNode } from '../crypto/nodeLock';

function emitIndexUpdated(event: IpcMainInvokeEvent, tabId: string): void {
  const payload: IndexUpdatedPayload = { tabId };
  event.sender.send(IpcEvents.indexUpdated, payload);
}

function encPathOf(folderPath: string, memoName: string): string {
  return join(folderPath, `${memoName}${MEMO_EXT_ENCRYPTED}`);
}

/** `.txtenc` を読み込みパースする。読込/パース失敗は `null`（呼び出し側で NOT_FOUND/DECRYPT_FAILED へ）。 */
async function readTxtEncFile(path: string): Promise<{ raw: Buffer; file: TxtEncFile } | null> {
  const raw = await fs.readFile(path).catch(() => null);
  if (!raw) return null;
  const file = parseTxtEncFile(raw);
  if (!file) return null;
  return { raw, file };
}

/** 誤パスワード時のメッセージにヒントを付与する（設定時の「ヒント表示」相当。DESIGN §2.9）。 */
function decryptFailedMessage(hint: string | undefined): string {
  return hint ? `パスワードが違います。（ヒント: ${hint}）` : 'パスワードが違います。';
}

export function registerCryptoHandlers(): void {
  // --- crypto:encryptMemo（平文 .txt → .txtenc 変換, PLAN §5.4） ---
  ipcMain.handle(
    IpcChannels.crypto.encryptMemo,
    wrapHandler(async (event: IpcMainInvokeEvent, args: CryptoEncryptMemoArgs): Promise<Result<MemoInfo>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      const folderPath = folder.value;

      const nameCheck = validateExistingMemoNameForPath(folderPath, args.memoName);
      if (!nameCheck.ok) return nameCheck;

      const found = await findMemoFile(folderPath, args.memoName);
      if (!found) return err('NOT_FOUND', `メモが見つかりません: ${args.memoName}`, folderPath);
      if (found.encrypted) return err('NAME_INVALID', 'このメモは既に暗号化されています。', found.path);

      // 平文読込（メモリ上のみ）。
      const plainRead = await readMemo(folderPath, args.memoName);
      if (!plainRead.ok) return plainRead;

      const salt = generateSalt();
      const iv = generateIv();
      const key = await deriveKey(args.password, salt, SCRYPT_DEFAULTS);
      const plaintext = Buffer.from(plainRead.value.contentLF, 'utf-8');
      const { ivB64, tagB64, ciphertextB64 } = encryptBuffer(key, iv, plaintext);

      // 【v3 M10a】元ファイルの拡張子(.txt/.md)から format を自動判定しヘッダへ反映する
      // （DESIGNv3 §2.5 Q8。新規IPCパラメータは不要、既存 found.format をそのまま使う）。
      const container = buildTxtEncFile({
        saltB64: salt.toString('base64'),
        ivB64,
        tagB64,
        eol: plainRead.value.eol,
        hint: args.hint,
        format: found.format,
        ciphertextB64,
        kdf: SCRYPT_DEFAULTS
      });
      const data = serializeTxtEncFile(container);

      const encPath = encPathOf(folderPath, args.memoName);
      const plainPath = found.path;

      // atomicWrite が encPath/.bak の自己書き込み予約・fsync・rename を一元管理する（§2）。
      await atomicWrite(encPath, data);

      // 確認後に元の平文を直接削除（ごみ箱を経由しない, DESIGN §2.9）。順序厳守
      // （.txtenc 永続化後に削除。途中クラッシュ時は平文が残り再開可能, PLAN §5.4）。
      registerSelfWrite(plainPath, { kind: 'delete' });
      try {
        await withRetry(() => fs.unlink(plainPath));
      } catch (e) {
        consumeSelfWrite(plainPath);
        throw e;
      }

      // インデックス経路①: 本文除外・メモ名のみに更新（DESIGN §2.4）。
      updateMemoIndex(args.tabId, args.memoName, true, null);
      emitIndexUpdated(event, args.tabId);

      // セッション鍵ストアへ保持（そのまま開封状態にしてよい, PLAN §5.4 step7）。
      setSessionKey(args.tabId, args.memoName, {
        key,
        saltB64: container.kdf.saltB64,
        kdf: { N: container.kdf.N, r: container.kdf.r, p: container.kdf.p, keyLen: container.kdf.keyLen },
        hint: args.hint,
        format: found.format
      });

      return ok<MemoInfo>({ memoName: args.memoName, encrypted: true });
    })
  );

  // --- crypto:decryptMemoToPlain（明示的な暗号化解除, .txtenc → .txt） ---
  ipcMain.handle(
    IpcChannels.crypto.decryptMemoToPlain,
    wrapHandler(async (event: IpcMainInvokeEvent, args: CryptoDecryptToPlainArgs): Promise<Result<MemoInfo>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      const folderPath = folder.value;

      const nameCheck = validateExistingMemoNameForPath(folderPath, args.memoName);
      if (!nameCheck.ok) return nameCheck;

      const found = await findMemoFile(folderPath, args.memoName);
      if (!found) return err('NOT_FOUND', `メモが見つかりません: ${args.memoName}`, folderPath);
      if (!found.encrypted) return err('NAME_INVALID', 'このメモは暗号化されていません。', found.path);

      const loaded = await readTxtEncFile(found.path);
      if (!loaded) return err('DECRYPT_FAILED', 'ファイル形式が不正です（読み込めません）。', found.path);

      const key = await deriveKey(args.password, Buffer.from(loaded.file.kdf.saltB64, 'base64'), loaded.file.kdf);
      let plaintext: Buffer;
      try {
        plaintext = decryptBuffer(key, loaded.file.cipher.ivB64, loaded.file.cipher.tagB64, loaded.file.ciphertextB64);
      } catch {
        return err('DECRYPT_FAILED', decryptFailedMessage(loaded.file.hint), found.path);
      }

      const contentLF = plaintext.toString('utf-8');
      const restored = restoreEol(contentLF, loaded.file.eol);
      const data = encodeText(restored, 'utf-8');

      // 【v3 M10a】.txtenc の format フィールドに従い .txt/.md いずれかへ復元する（DESIGNv3 §2.5 Q8。
      // フィールド省略時は 'plain' 扱い＝既存 .txt へ復元する後方互換, data-model.md §3）。
      const restoredFormat: 'plain' | 'markdown' = loaded.file.format === 'markdown' ? 'markdown' : 'plain';
      const plainExt = restoredFormat === 'markdown' ? MEMO_EXT_MARKDOWN : MEMO_EXT_PLAIN;
      const plainPath = join(folderPath, `${args.memoName}${plainExt}`);
      await atomicWrite(plainPath, data);

      // 逆方向（暗号化解除）はユーザーが明示的に意図した通常操作のため、平文原本削除のような
      // 特別扱いは不要（DESIGN §2.9）。ただし同名衝突（.txt/.txtenc 併存）を避けるため、平文の
      // 永続化確認後に旧 .txtenc を直接削除する（暗号化変換フローと対称の順序、developer 判断）。
      registerSelfWrite(found.path, { kind: 'delete' });
      try {
        await withRetry(() => fs.unlink(found.path));
      } catch (e) {
        consumeSelfWrite(found.path);
        throw e;
      }

      updateMemoIndex(args.tabId, args.memoName, false, contentLF, restoredFormat);
      emitIndexUpdated(event, args.tabId);
      deleteSessionKey(args.tabId, args.memoName);

      return ok<MemoInfo>({ memoName: args.memoName, encrypted: false });
    })
  );

  // --- crypto:open（開封=復号。成功時セッション鍵をメイン保持し、本文平文をレンダラへ, PLAN §5.5） ---
  ipcMain.handle(
    IpcChannels.crypto.open,
    wrapHandler(async (_event: IpcMainInvokeEvent, args: CryptoOpenArgs): Promise<Result<CryptoOpenResult>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      const folderPath = folder.value;

      const nameCheck = validateExistingMemoNameForPath(folderPath, args.memoName);
      if (!nameCheck.ok) return nameCheck;

      const found = await findMemoFile(folderPath, args.memoName);
      if (!found) return err('NOT_FOUND', `メモが見つかりません: ${args.memoName}`, folderPath);
      if (!found.encrypted) return err('NAME_INVALID', 'このメモは暗号化されていません。', found.path);

      const loaded = await readTxtEncFile(found.path);
      if (!loaded) return err('DECRYPT_FAILED', 'ファイル形式が不正です（読み込めません）。', found.path);

      // hash は .txtenc ファイル全体のバイト列（次回保存の競合判定用, 00-core-principles.md §6）。
      const hash = hashBytes(loaded.raw);

      const key = await deriveKey(args.password, Buffer.from(loaded.file.kdf.saltB64, 'base64'), loaded.file.kdf);
      let plaintext: Buffer;
      try {
        plaintext = decryptBuffer(key, loaded.file.cipher.ivB64, loaded.file.cipher.tagB64, loaded.file.ciphertextB64);
      } catch {
        return err('DECRYPT_FAILED', decryptFailedMessage(loaded.file.hint), found.path);
      }

      // 【v3 M10a/M10b】.txtenc ヘッダの format を引き継ぐ（省略時は 'plain'、data-model.md §3）。
      // setSessionKey へ渡す値と同じ判定ロジックを CryptoOpenResult.format にも反映する
      // （2026-07-26追記・v3 M10b前提、docs/v3/milestones/M10b-markdown-live-preview.md §0.6）。
      const format: 'plain' | 'markdown' = loaded.file.format === 'markdown' ? 'markdown' : 'plain';
      setSessionKey(args.tabId, args.memoName, {
        key,
        saltB64: loaded.file.kdf.saltB64,
        kdf: { N: loaded.file.kdf.N, r: loaded.file.kdf.r, p: loaded.file.kdf.p, keyLen: loaded.file.kdf.keyLen },
        hint: loaded.file.hint,
        format
      });

      return ok<CryptoOpenResult>({ contentLF: plaintext.toString('utf-8'), eol: loaded.file.eol, hash, format });
    })
  );

  // --- crypto:saveEncrypted（開封中メモの保存。expectedHash 競合検出→新IVで再暗号化, PLAN §5.5） ---
  ipcMain.handle(
    IpcChannels.crypto.saveEncrypted,
    wrapHandler(async (_event: IpcMainInvokeEvent, args: CryptoSaveEncryptedArgs): Promise<Result<SaveResult>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      const folderPath = folder.value;

      const nameCheck = validateExistingMemoNameForPath(folderPath, args.memoName);
      if (!nameCheck.ok) return nameCheck;

      const session = getSessionKey(args.tabId, args.memoName);
      if (!session) {
        return err('DECRYPT_FAILED', 'このメモは開封されていません。再度パスワードを入力して開いてください。');
      }

      const targetPath = encPathOf(folderPath, args.memoName);

      // 競合チェック（平文 memo:save と対称、ハッシュ比較のみ, 00-core-principles.md §5）。
      if (args.expectedHash !== undefined) {
        const currentRaw = await fs.readFile(targetPath).catch(() => null);
        if (!currentRaw) {
          return err('CONFLICT', '保存前にメモが外部で削除されています。', targetPath);
        }
        if (hashBytes(currentRaw) !== args.expectedHash) {
          return err('CONFLICT', '保存前に外部でメモが変更されています。', targetPath);
        }
      }

      // 毎回新しい IV を生成する（IV 再利用禁止, DESIGN §2.9）。salt は流用。
      const iv = generateIv();
      const plaintext = Buffer.from(args.contentLF, 'utf-8');
      const { ivB64, tagB64, ciphertextB64 } = encryptBuffer(session.key, iv, plaintext);

      // 【v3 M10a】format はセッション鍵ストアに保持している値（crypto:open/crypto:encryptMemo
      // 時点で .txtenc ヘッダから引き継いだもの）をそのまま維持する（再暗号化のたびに落とさない）。
      const container = buildTxtEncFile({
        saltB64: session.saltB64,
        ivB64,
        tagB64,
        eol: args.eol,
        hint: session.hint,
        format: session.format,
        ciphertextB64,
        kdf: session.kdf
      });
      const data = serializeTxtEncFile(container);

      // atomicWrite（temp→fsync→.bak→rename）。.bak も暗号化済みデータ（平文は残らない, §2.6）。
      await atomicWrite(targetPath, data);
      const savedHash = hashBytes(data);

      return ok<SaveResult>({ savedHash });
    })
  );

  // --- crypto:changePassword（①旧PWで復号確認→②新PW→③新salt+新IVで再暗号化, PLAN §5.5） ---
  ipcMain.handle(
    IpcChannels.crypto.changePassword,
    wrapHandler(async (_event: IpcMainInvokeEvent, args: CryptoChangePasswordArgs): Promise<Result<void>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      const folderPath = folder.value;

      const nameCheck = validateExistingMemoNameForPath(folderPath, args.memoName);
      if (!nameCheck.ok) return nameCheck;

      const found = await findMemoFile(folderPath, args.memoName);
      if (!found) return err('NOT_FOUND', `メモが見つかりません: ${args.memoName}`, folderPath);
      if (!found.encrypted) return err('NAME_INVALID', 'このメモは暗号化されていません。', found.path);

      const loaded = await readTxtEncFile(found.path);
      if (!loaded) return err('DECRYPT_FAILED', 'ファイル形式が不正です（読み込めません）。', found.path);

      // 変更前に開封中（セッション鍵あり）だったかどうかを先に控えておく。閉じたまま（一度も
      // crypto:open していない）暗号化メモに対してパスワード変更のみ行った場合は、変更後も
      // セッションを新規作成しない（レビュー指摘対応: 「鍵の保持は開封中のみ」の方針に沿う）。
      const hadSessionBeforeChange = getSessionKey(args.tabId, args.memoName) !== undefined;

      const oldKey = await deriveKey(args.oldPassword, Buffer.from(loaded.file.kdf.saltB64, 'base64'), loaded.file.kdf);
      let plaintext: Buffer;
      try {
        plaintext = decryptBuffer(oldKey, loaded.file.cipher.ivB64, loaded.file.cipher.tagB64, loaded.file.ciphertextB64);
      } catch {
        return err('DECRYPT_FAILED', decryptFailedMessage(loaded.file.hint), found.path);
      }

      const newSalt = generateSalt();
      const newIv = generateIv();
      const newKey = await deriveKey(args.newPassword, newSalt, SCRYPT_DEFAULTS);
      const { ivB64, tagB64, ciphertextB64 } = encryptBuffer(newKey, newIv, plaintext);

      // 【v3 M10a】format は既存 .txtenc ヘッダの値をそのまま引き継ぐ（パスワード変更で
      // 落とさない、data-model.md §3）。
      const container = buildTxtEncFile({
        saltB64: newSalt.toString('base64'),
        ivB64,
        tagB64,
        eol: loaded.file.eol,
        hint: loaded.file.hint,
        format: loaded.file.format,
        ciphertextB64,
        kdf: SCRYPT_DEFAULTS
      });
      const data = serializeTxtEncFile(container);

      // ④temp書込+fsync ⑤アトミックrename（atomicWrite が内包, §2）。失敗時は rename しない
      // だけでロールバック不要（PLAN §5.5）。
      await atomicWrite(found.path, data);

      // 変更前に開封中だった場合のみ、新しい鍵でセッションを更新し継続編集できるようにする
      // （developer 判断: 変更直後にセッションを失効させると開いたまま編集中のユーザーが
      // 次の保存で DECRYPT_FAILED になってしまうため）。未開封のまま変更しただけの場合は
      // 新規にセッションを作らない（レビュー指摘対応）。
      if (hadSessionBeforeChange) {
        setSessionKey(args.tabId, args.memoName, {
          key: newKey,
          saltB64: container.kdf.saltB64,
          kdf: { N: container.kdf.N, r: container.kdf.r, p: container.kdf.p, keyLen: container.kdf.keyLen },
          hint: loaded.file.hint,
          format: loaded.file.format === 'markdown' ? 'markdown' : 'plain'
        });
      }

      return ok(undefined);
    })
  );

  // --- crypto:lock（セッション鍵破棄=再ロック。未保存データの自動保存はレンダラ側が
  // crypto:saveEncrypted を先に呼んでから本チャネルを呼ぶ運用とする, developer 判断:
  // 本チャネルの引数には本文が含まれないため、dirty チェック+自動保存はレンダラ側でしか
  // 判断できない。M4 の editor:reportActive と同様の設計判断, PLAN §5.5 step1-2） ---
  ipcMain.handle(
    IpcChannels.crypto.lock,
    wrapHandler((_event: IpcMainInvokeEvent, args: CryptoLockArgs): Result<void> => {
      deleteSessionKey(args.tabId, args.memoName);
      return ok(undefined);
    })
  );

  // --- v3 M8/M9a: crypto:lockNode（サブツリーをロック。lockContext指定時は入れ子ロック,
  // docs/v3/milestones/M8-node-lock-core.md / M9a-node-lock-session-ops.md） ---
  ipcMain.handle(
    IpcChannels.crypto.lockNode,
    wrapHandler(async (event: IpcMainInvokeEvent, args: CryptoLockNodeArgs): Promise<Result<void>> => {
      const result = await lockNode(args.tabId, args.memoName, args.password, args.hint, args.lockContext);
      if (result.ok) {
        // ロック対象配下の名前を全文検索インデックスから除去済み（nodeLock.ts 内）のため、
        // レンダラ側の検索結果表示を最新化させる（既存 M6 パターンと同様）。
        emitIndexUpdated(event, args.tabId);
      }
      return result;
    })
  );

  // --- v3 M8/M9a: crypto:unlockNode（ロック中サブツリーを復号しセッション開始。lockContext
  // 指定時は入れ子ロックの解除） ---
  ipcMain.handle(
    IpcChannels.crypto.unlockNode,
    wrapHandler(
      async (_event: IpcMainInvokeEvent, args: CryptoUnlockNodeArgs): Promise<Result<CryptoUnlockNodeResult>> =>
        unlockNode(args.tabId, args.memoName, args.password, args.lockContext)
    )
  );

  // --- v3 M8: crypto:relockNode（単一ロックセッションの明示的破棄。ファイル操作なし） ---
  ipcMain.handle(
    IpcChannels.crypto.relockNode,
    wrapHandler((_event: IpcMainInvokeEvent, args: CryptoRelockNodeArgs): Result<void> => relockNode(args.tabId, args.lockToken))
  );

  // --- v3 M9c: crypto:relockAllInTab（タブ切替時のセッション一括破棄。relockNode のループ相当、
  // ファイル操作なし。対象タブにセッションが1件も無い場合も何もせず成功扱い＝冪等,
  // docs/v3/milestones/M9c-node-lock-tab-switch.md） ---
  ipcMain.handle(
    IpcChannels.crypto.relockAllInTab,
    wrapHandler((_event: IpcMainInvokeEvent, args: CryptoRelockAllInTabArgs): Result<void> => relockAllInTab(args.tabId))
  );
}
