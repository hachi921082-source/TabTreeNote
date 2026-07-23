// src/main/fs/tempNaming.ts
// 一時ファイルプレフィックス規則（docs/00-core-principles.md §2 / DESIGN §3.3）。
// chokidar の `ignored`（M4）でこのプレフィックスのパターンごと監視除外するため、
// 生成ロジックは `@shared/constants` の TEMP_FILE_PREFIX を唯一の正本として使う。
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { TEMP_FILE_PREFIX } from '@shared/constants';

/** target と同じディレクトリに、衝突しにくいランダムサフィックス付きの一時ファイルパスを作る。 */
export function makeTempFilePath(targetPath: string): string {
  const dir = dirname(targetPath);
  const base = basename(targetPath);
  const rand = randomBytes(8).toString('hex');
  return join(dir, `${TEMP_FILE_PREFIX}${rand}~${base}`);
}
