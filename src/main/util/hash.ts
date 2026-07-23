// src/main/util/hash.ts
// コンテンツハッシュ（docs/00-core-principles.md §6）。
// 対象は常に「ディスク上の実ファイル全体のバイト列」（平文本文のみ・.txtenc の暗号文部分のみは対象外）。
import { createHash } from 'node:crypto';

/** 実ファイル全体のバイト列に対する SHA-256 16進ハッシュを計算する。 */
export function hashBytes(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
