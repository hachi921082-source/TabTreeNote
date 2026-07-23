// src/main/crypto/cipher.ts
// scrypt（非同期）+ AES-256-GCM の純粋な暗号プリミティブ（docs/milestones/M6-crypto.md /
// data-model.md §3 / DESIGN §2.9）。
//
// - 鍵導出は必ず非同期 `crypto.scrypt`（コールバック API）を `util.promisify` して `await` する。
//   `crypto.scryptSync` は使用しない（同期版はメインのイベントループをブロックし
//   UI/IPC/トレイをフリーズさせる, data-model.md §3）。
// - `maxmem` を明示的に十分な値へ引き上げる（既定 N=32768/r=8 では既定の maxmem=32MB が
//   不足し得るため, data-model.md §3）。
// - IV は書き込み毎に必ず新規生成する（DESIGN §2.9 IV 再利用禁止）。salt はパスワード維持中は
//   不変（呼び出し側が `.txtenc` のファイル内 salt を使い回す）。
import { randomBytes, createCipheriv, createDecipheriv, scrypt as scryptCallback } from 'node:crypto';
import { GCM_IV_LENGTH, SCRYPT_SALT_MIN_LENGTH } from '@shared/constants';

/** scrypt のメモリ上限（data-model.md §3「例 64MB」）。N=32768/r=8/p=1 に対して十分な値。 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export interface KdfParams {
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

/**
 * パスワード+salt+コストパラメータから鍵を導出する（非同期、イベントループ非ブロッキング）。
 * `util.promisify(crypto.scrypt)` はオーバーロード（options 有り/無し）の型推論が曖昧になる
 * ため、Promise でコールバック API を直接ラップする（developer 判断）。
 */
export function deriveKey(password: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      params.keyLen,
      { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(derivedKey);
      }
    );
  });
}

/** 新規 salt を生成する（初回暗号化・パスワード変更時のみ呼ぶこと。通常保存時は既存 salt を流用）。 */
export function generateSalt(): Buffer {
  return randomBytes(SCRYPT_SALT_MIN_LENGTH);
}

/** 新規 IV を生成する（書き込み毎に必ず呼ぶこと。IV 再利用禁止, DESIGN §2.9）。 */
export function generateIv(): Buffer {
  return randomBytes(GCM_IV_LENGTH);
}

export interface EncryptedPayload {
  ivB64: string;
  tagB64: string;
  ciphertextB64: string;
}

/** AES-256-GCM で暗号化する。`iv` は毎回 `generateIv()` で新規生成したものを渡すこと。 */
export function encryptBuffer(key: Buffer, iv: Buffer, plaintext: Buffer): EncryptedPayload {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ivB64: iv.toString('base64'),
    tagB64: tag.toString('base64'),
    ciphertextB64: ciphertext.toString('base64')
  };
}

/**
 * AES-256-GCM で復号する。認証タグ検証に失敗した場合（誤パスワード/改ざん）は例外を投げる。
 * 呼び出し側で捕捉して `DECRYPT_FAILED` へマッピングすること（00-core-principles.md §8）。
 */
export function decryptBuffer(key: Buffer, ivB64: string, tagB64: string, ciphertextB64: string): Buffer {
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
