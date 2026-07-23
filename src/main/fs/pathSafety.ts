// src/main/fs/pathSafety.ts
// サニタイズ・予約名・長パス検出・パス閉じ込め（docs/00-core-principles.md §11 / DESIGN §3.1）。
// リアルタイム置換候補提示 UI は M2（ここではメイン側の検証ロジックのみ）。
import { resolve, sep } from 'node:path';
import { err, ok } from '../util/result';
import type { Result } from '@shared/models';
import { LONG_PATH_THRESHOLD } from '@shared/constants';

/** Windows 禁止文字（バックスラッシュ・スラッシュ・コロン・アスタリスク・疑問符・二重引用符・不等号・パイプ）と制御文字。 */
// eslint-disable-next-line no-control-regex -- 制御文字（U+0000-U+001F）の明示的な検出が目的
const FORBIDDEN_CHARS_RE = /[\x00-\x1f"*/:<>?\\|]/;

/** Windows 予約名（拡張子を除いた部分がこれらと一致すると使用不可）。 */
const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
]);

/**
 * メモ名/タブ名として使う「拡張子を除いた表示名」を検証する。
 * NG の場合はファイル操作前に呼び出し元でブロックし、実ファイルには一切触れないこと
 * （docs/00-core-principles.md §8「名前重複/禁止文字」行）。
 */
export function validateName(name: string): Result<void> {
  if (name.length === 0) {
    return err('NAME_INVALID', '名前を入力してください。');
  }
  if (name !== name.trim()) {
    return err('NAME_INVALID', '前後に空白を含めることはできません。');
  }
  if (name.endsWith('.')) {
    return err('NAME_INVALID', '末尾にピリオドを含めることはできません。');
  }
  if (FORBIDDEN_CHARS_RE.test(name)) {
    return err('NAME_INVALID', '使用できない文字が含まれています（\\ / : * ? " < > | および制御文字）。');
  }
  const upper = name.toUpperCase();
  const baseBeforeDot = upper.split('.')[0] ?? upper;
  if (RESERVED_NAMES.has(upper) || RESERVED_NAMES.has(baseBeforeDot)) {
    return err('NAME_INVALID', `予約名は使用できません: ${name}`);
  }
  return ok(undefined);
}

/** 絶対パスの長さが Windows 長パス閾値（既定 260 文字）を超えているか（v1 は正式対応外, DESIGN §4）。 */
export function isLongPath(absolutePath: string): boolean {
  return absolutePath.length > LONG_PATH_THRESHOLD;
}

/** `target` が `baseDir` 配下（`baseDir` 自身を含む）に閉じ込められているかを検証する。 */
export function isPathContained(baseDir: string, target: string): boolean {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + sep);
}

/** 名前の重複比較用に正規化する（NTFS の大文字小文字非区別に合わせ大文字化, Unicode 正規化）。 */
export function normalizeForCompare(name: string): string {
  return name.normalize('NFC').toUpperCase();
}
