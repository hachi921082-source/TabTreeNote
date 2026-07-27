// src/main/crypto/encFormat.ts
// `.txtenc` フォーマット定義とバージョニング（data-model.md §3 / PLAN §4.3 / DESIGN §2.9）。
// 自己記述的な JSON コンテナ（バイナリ最適化は将来検討）。
import { TXTENC_FORMAT_VERSION, TXTENC_MAGIC } from '@shared/constants';
import type { Eol } from '@shared/models';
import type { KdfParams } from './cipher';

/** `.txtenc` ファイルの内容（JSON ヘッダ全体, data-model.md §3）。 */
export interface TxtEncFile {
  magic: string;
  formatVersion: number;
  kdf: KdfParams & { algo: 'scrypt'; saltB64: string };
  cipher: { algo: 'aes-256-gcm'; ivB64: string; tagB64: string };
  /** 復号後に復元する改行コード種別（§2.3）。 */
  eol: Eol;
  /** 任意のパスワードヒント。平文保存（UI 側で警告表示すること）。 */
  hint?: string;
  /**
   * 【v3 M10a】元ファイルの保存形式（DESIGNv3 §2.5 Q8、docs/data-model.md §3）。
   * 省略時は 'plain'（後方互換。v1/M6 で作成された既存 `.txtenc` は本フィールドを持たない）。
   */
  format?: 'plain' | 'markdown';
  ciphertextB64: string;
}

export interface BuildTxtEncFileParams {
  saltB64: string;
  ivB64: string;
  tagB64: string;
  eol: Eol;
  hint?: string;
  /** 【v3 M10a】省略時/'plain' 指定時はヘッダへ書き出さない（後方互換の既定値と同じ表現に揃える）。 */
  format?: 'plain' | 'markdown';
  ciphertextB64: string;
  kdf: KdfParams;
}

/** `.txtenc` の JSON ヘッダオブジェクトを組み立てる。 */
export function buildTxtEncFile(params: BuildTxtEncFileParams): TxtEncFile {
  const file: TxtEncFile = {
    magic: TXTENC_MAGIC,
    formatVersion: TXTENC_FORMAT_VERSION,
    kdf: { algo: 'scrypt', N: params.kdf.N, r: params.kdf.r, p: params.kdf.p, keyLen: params.kdf.keyLen, saltB64: params.saltB64 },
    cipher: { algo: 'aes-256-gcm', ivB64: params.ivB64, tagB64: params.tagB64 },
    eol: params.eol,
    ciphertextB64: params.ciphertextB64
  };
  // hint はキー自体を省略可能にする（undefined を明示的に持たせて JSON へ "hint": undefined を
  // 出力しないため。JSON.stringify は undefined 値のプロパティを自動的に落とすので実質等価だが、
  // 型上も optional であることを明確にする）。
  if (params.hint !== undefined && params.hint.length > 0) {
    file.hint = params.hint;
  }
  // 【v3 M10a】'markdown' のときのみ書き出す（'plain'/省略は既定値のため省略, hint と同じ流儀）。
  if (params.format === 'markdown') {
    file.format = 'markdown';
  }
  return file;
}

/** `.txtenc` ヘッダを UTF-8 JSON バイト列へシリアライズする。 */
export function serializeTxtEncFile(file: TxtEncFile): Buffer {
  return Buffer.from(JSON.stringify(file), 'utf-8');
}

/**
 * バイト列を `.txtenc` としてパースする。`magic`/必須フィールド不備は破損/非対応形式として
 * `null` を返す（呼び出し側で `DECRYPT_FAILED` 等へマッピングする）。
 */
export function parseTxtEncFile(buf: Buffer): TxtEncFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf-8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (v.magic !== TXTENC_MAGIC) return null;
  if (typeof v.formatVersion !== 'number') return null;
  const kdf = v.kdf as Record<string, unknown> | undefined;
  const cipher = v.cipher as Record<string, unknown> | undefined;
  if (!kdf || typeof kdf.N !== 'number' || typeof kdf.r !== 'number' || typeof kdf.p !== 'number' ||
    typeof kdf.keyLen !== 'number' || typeof kdf.saltB64 !== 'string') {
    return null;
  }
  if (!cipher || typeof cipher.ivB64 !== 'string' || typeof cipher.tagB64 !== 'string') {
    return null;
  }
  if (typeof v.ciphertextB64 !== 'string') return null;
  if (v.eol !== 'crlf' && v.eol !== 'lf' && v.eol !== 'cr') return null;
  // 【v3 M10a】未知の値は破損/非対応形式として扱う（省略=undefinedのみ後方互換で許容, §2.5 Q8）。
  if (v.format !== undefined && v.format !== 'plain' && v.format !== 'markdown') return null;

  return {
    magic: v.magic,
    formatVersion: v.formatVersion,
    kdf: { algo: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, keyLen: kdf.keyLen, saltB64: kdf.saltB64 },
    cipher: { algo: 'aes-256-gcm', ivB64: cipher.ivB64, tagB64: cipher.tagB64 },
    eol: v.eol,
    hint: typeof v.hint === 'string' ? v.hint : undefined,
    format: v.format === 'markdown' ? 'markdown' : undefined,
    ciphertextB64: v.ciphertextB64
  };
}
