// src/main/fs/atomicWrite.ts
// アトミック書き込み（docs/00-core-principles.md §2）。
// 対象範囲: メモ本文 .txt / 暗号化メモ .txtenc / タブ単位メタ JSON / アプリ設定 JSON。
//
// 順序: 1. temp（プレフィックス付き）へ書込 → 2. fsync → 3.（世代スワップを末尾に集約）
// 旧 target を .bak へ rename → 4. temp を target へ rename。各操作に retry を適用する。
//
// 順序の意図（クラッシュ耐性）: 世代スワップを末尾に集約することで、temp 書込中（メモが
// 大きいほど長い）にクラッシュしても live な target は無傷。target 不在の窓は 2 つの
// rename の間の一瞬に限定され、そこでクラッシュしても target か .bak のいずれかが必ず存在する。
//
// ディレクトリ fsync は v1（NTFS 前提）では行わない（Fix6）。
//
// 自己書き込み予約は本関数内で一元的に登録する（呼び出し側任せにしない, §4）。target・.bak
// 両方のパスを登録してから rename する。temp はプレフィックス除外でイベントが出ないため
// 登録不要。
import { promises as fs } from 'node:fs';
import { BACKUP_SUFFIX } from '@shared/constants';
import { makeTempFilePath } from './tempNaming';
import { withRetry } from './retry';
import { hashBytes } from '../util/hash';
import { consumeSelfWrite, refineSelfWriteExpectation, registerSelfWrite } from '../watch/selfWriteRegistry';

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `data` を `targetPath` へアトミックに書き込む。target が既に存在する場合は直近 1 世代分の
 * `.bak`（次回保存時に上書き）を残す。`targetPath` の親ディレクトリは呼び出し側が事前に
 * 存在を保証すること。
 */
export async function atomicWrite(targetPath: string, data: Buffer): Promise<void> {
  const tempPath = makeTempFilePath(targetPath);
  const bakPath = `${targetPath}${BACKUP_SUFFIX}`;

  await withRetry(async () => {
    const handle = await fs.open(tempPath, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  });

  // 世代スワップ対象パス（target・.bak）を自己書き込みとして事前登録（fs 層での一元化, §4）。
  registerSelfWrite(targetPath);
  registerSelfWrite(bakPath);

  let renamedToBak = false;
  try {
    if (await pathExists(targetPath)) {
      await withRetry(() => fs.rename(targetPath, bakPath));
      renamedToBak = true;
    }
    await withRetry(() => fs.rename(tempPath, targetPath));
  } catch (e) {
    // 世代スワップ失敗時のベストエフォート後始末（reviewer 指摘 M1-R1-02）。
    // 旧 target→.bak のリネームまで成功した状態で temp→target が全リトライ失敗すると、
    // target が不在のまま新データ（temp）も反映されない窓ができる。これはクラッシュではなく
    // 通常の I/O 失敗経路のため、.bak→target への復元を試みて live target を無傷側へ戻す。
    // 復元自体が失敗しても（既存 .bak はそのまま残るので）これ以上のデータ喪失は生じない。
    if (renamedToBak) {
      await fs.rename(bakPath, targetPath).catch(() => undefined);
    }
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    // 世代スワップが完遂しなかったため、事前登録した自己書き込み予約（期待値未確定のまま）を
    // 解放する（M4）。解放しないと以後 TTL が切れるまで、当該パスへの真の外部変更を誤って
    // 自己発火扱いしてしまう（watch/conflict.ts の「期待値未確定 = 自己発火扱い」フォールバック）。
    consumeSelfWrite(targetPath);
    consumeSelfWrite(bakPath);
    throw e;
  }

  // 世代スワップ成功。target の最終内容は `data` そのもの（再読込不要, M4）。
  refineSelfWriteExpectation(targetPath, { kind: 'upsert', size: data.length, hash: hashBytes(data) });
}
