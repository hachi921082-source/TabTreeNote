// src/renderer/editor/markdownSanitize.ts
// v3 M10b: Markdown装飾のサニタイズ（DESIGNv3 §2.3、PLANv3 §0、
// docs/v3/milestones/M10b-markdown-live-preview.md「サニタイズ実装上の注意」）。
//
// 許可リストを「文字装飾系（<span>）」と「画像挿入（<img>）」のみに絞った許可リスト方式で
// 無害化する。DOMPurify の ALLOWED_TAGS/ALLOWED_ATTR ではタグ/属性単位までしか絞れないため、
// style 属性の CSS プロパティ単位の絞り込み（color/font-size/font-weight のみ許可）は
// uponSanitizeAttribute フックで追加実装する。
//
// セキュリティ不変条件（DESIGNv3 §2.3、docs/00-core-principles.md §10 に準ずる形で明記）:
// <script>/on*イベント属性/javascript:スキーム/許可外CSSプロパティは、例外を投げず常に黙って
// 除去する。装飾はあくまで見た目の変換であり、実行可能なコードを本文から生成させない。
import DOMPurify from 'dompurify';
import {
  MARKDOWN_ALLOWED_IMG_ATTRS,
  MARKDOWN_ALLOWED_SPAN_STYLE_PROPS,
  MARKDOWN_ALLOWED_TAGS,
  MARKDOWN_IMAGE_SRC_PATTERN
} from '@shared/constants';

const ALLOWED_ATTR: string[] = ['style', ...MARKDOWN_ALLOWED_IMG_ATTRS];
const ALLOWED_STYLE_PROPS = new Set<string>(MARKDOWN_ALLOWED_SPAN_STYLE_PROPS);

/**
 * `style` 属性値からプロパティ単位で許可外CSSを除去する（DOMPurify標準機能だけでは
 * プロパティ単位の絞り込みができないための追加実装, milestone doc「サニタイズ実装上の注意」）。
 * `url(...)`/`expression(...)`/`javascript:` を含む値は、許可プロパティであっても安全側で
 * 除去する（`color`/`font-size`/`font-weight` の正当な値には本来これらの構文は現れないため、
 * 混入していれば不正な入力とみなしてよい）。
 */
export function filterStyleValue(raw: string): string {
  const kept: string[] = [];
  for (const decl of raw.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (!prop || !value) continue;
    if (!ALLOWED_STYLE_PROPS.has(prop)) continue;
    if (/url\s*\(|expression\s*\(|javascript:/i.test(value)) continue;
    kept.push(`${prop}: ${value}`);
  }
  return kept.join('; ');
}

let hooksRegistered = false;

function ensureHooks(): void {
  if (hooksRegistered) return;
  hooksRegistered = true;
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'style') {
      data.attrValue = filterStyleValue(data.attrValue);
      if (!data.attrValue) data.keepAttr = false;
      return;
    }
    if (node.nodeName.toLowerCase() === 'img' && data.attrName === 'src') {
      // ALLOWED_URI_REGEXP でも data:image を許可しているが、二重防御として個別にも検証する
      // （外部URL・javascript:等のスキームを黙って除去する, DESIGNv3 §2.3/§2.5）。
      if (!MARKDOWN_IMAGE_SRC_PATTERN.test(data.attrValue)) {
        data.keepAttr = false;
      }
      return;
    }
    if (node.nodeName.toLowerCase() === 'img' && (data.attrName === 'width' || data.attrName === 'height')) {
      // 数値（+任意で%）以外は除去する（CSS/URL等の混入を防ぐ安全側の追加チェック）。
      if (!/^\d+%?$/.test(data.attrValue)) {
        data.keepAttr = false;
      }
    }
  });
}

/**
 * Markdown本文の一部（`<span style="...">`/`<img>`タグ込みのプレーンテキスト断片）を、ライブ
 * プレビュー表示用の無害化済みHTML文字列へ変換する（DESIGNv3 §2.3、milestone doc「ゴール」）。
 * 許可リスト外のタグ・属性・CSSプロパティ・`<script>`・`on*`イベント属性・`javascript:`スキームは
 * 黙って除去する（例外を投げない）。戻り値は `innerHTML` へそのまま設定してよい安全な文字列。
 */
export function sanitizeMarkdownFragment(html: string): string {
  ensureHooks();
  return String(
    DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [...MARKDOWN_ALLOWED_TAGS],
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      // data: image URI を許可する（既定の ALLOWED_URI_REGEXP は data: を含まないため明示指定）。
      // 実際の検証は MARKDOWN_IMAGE_SRC_PATTERN と一致するもののみに絞る（上記フックでも二重検証）。
      ALLOWED_URI_REGEXP: MARKDOWN_IMAGE_SRC_PATTERN,
      RETURN_TRUSTED_TYPE: false
    })
  );
}
