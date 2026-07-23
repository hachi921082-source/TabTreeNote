// src/main/fs/encoding.ts
// UTF-8/BOM 検出→Shift_JIS フォールバック（docs/00-core-principles.md §2 該当 / DESIGN §2.3）。
// 読み込み: 「UTF-8（BOM 有無検出）としてまず読む → 不正バイト列を検出したら Shift_JIS で再試行」の
// 2 段フォールバック。手動指定の開き直しは memo:readWithEncoding が decodeBufferAs を使う。
// Shift_JIS の decode/encode は iconv-lite を使う（Node 標準 TextEncoder は UTF-8 のみ対応のため、
// Shift_JIS で開いたメモを同エンコーディングのまま編集・再保存できるよう round-trip 変換が必要）。
import iconv from 'iconv-lite';
import type { MemoReadResult } from '@shared/models';

export type DetectedEncoding = MemoReadResult['encoding'];

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function hasUtf8Bom(buf: Buffer): boolean {
  return buf.length >= 3 && buf.subarray(0, 3).equals(UTF8_BOM);
}

/** UTF-8 として厳密にデコードできるか検証する。不正バイト列があれば null を返す。 */
function tryDecodeUtf8Strict(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

export interface DecodeResult {
  text: string;
  encoding: DetectedEncoding;
}

/** 2 段フォールバックでバイト列をデコードする（DESIGN §2.3）。 */
export function decodeBuffer(buf: Buffer): DecodeResult {
  const bom = hasUtf8Bom(buf);
  const body = bom ? buf.subarray(3) : buf;
  const utf8 = tryDecodeUtf8Strict(body);
  if (utf8 !== null) {
    return { text: utf8, encoding: bom ? 'utf-8-bom' : 'utf-8' };
  }
  return { text: iconv.decode(buf, 'shift_jis'), encoding: 'shift_jis' };
}

/** エンコーディングを明示指定してデコードする（`memo:readWithEncoding` 用）。 */
export function decodeBufferAs(buf: Buffer, encoding: DetectedEncoding): string {
  if (encoding === 'shift_jis') {
    return iconv.decode(buf, 'shift_jis');
  }
  const bom = hasUtf8Bom(buf);
  const body = encoding === 'utf-8-bom' && bom ? buf.subarray(3) : buf;
  return new TextDecoder('utf-8').decode(body);
}

/** 指定エンコーディングでバイト列化する（保存用）。既定保存は 'utf-8'（BOM 無し, AppSettings.encoding.defaultSave）。 */
export function encodeText(text: string, encoding: DetectedEncoding): Buffer {
  switch (encoding) {
    case 'utf-8':
      return Buffer.from(text, 'utf-8');
    case 'utf-8-bom':
      return Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf-8')]);
    case 'shift_jis':
      return iconv.encode(text, 'shift_jis');
  }
}
