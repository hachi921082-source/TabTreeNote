// src/main/crypto/obfuscatedNaming.ts
// v3 M8: ノードロックの難読化ファイル名生成（docs/v3/DESIGNv3.md §1.4、docs/v3/PLANv3.md §3）。
// `crypto.randomBytes(16).toString('hex')`（128bit）。同一フォルダ内で衝突した場合は
// 呼び出し側（src/main/crypto/nodeLock.ts）が既存トークン集合を見て再生成する。
import { randomBytes } from 'node:crypto';
import { OBFUSCATED_NAME_BYTES } from '@shared/constants';

/** 128bit のランダム16進文字列を生成する（DESIGNv3 §1.4「衝突耐性を上げるため最初から128bit」）。 */
export function generateObfuscatedName(): string {
  return randomBytes(OBFUSCATED_NAME_BYTES).toString('hex');
}

/** `taken` に含まれない名前が出るまで再生成する（同一フォルダ内での衝突回避）。 */
export function generateUniqueObfuscatedName(taken: ReadonlySet<string>): string {
  let candidate = generateObfuscatedName();
  while (taken.has(candidate)) {
    candidate = generateObfuscatedName();
  }
  return candidate;
}
