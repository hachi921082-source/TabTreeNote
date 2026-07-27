// src/renderer/editor/markdownDecorations.ts
// v3 M10b: Markdown装飾のライブプレビュー描画（DESIGNv3 §2.1/§2.2、PLANv3 §5.6、
// docs/v3/milestones/M10b-markdown-live-preview.md）。
//
// CodeMirror の ViewPlugin が文書変更を検知し、markdownSanitize.ts の許可リストでサニタイズした
// HTML を見た目として描画する。実データは常に Markdown テキスト（<span style="..."> タグ込みの
// プレーンテキスト）のままであり、装飾はあくまで見た目の変換である（実 doc は一切書き換えない）。
//
// 実装方針: 独自の完全な HTML パーサは実装せず、本アプリの装飾コマンド（decorationCommands.ts）が
// 生成する既知のタグ形（`<span style="...">...</span>` / `<img ...>`）のみを正規表現で検出する。
// 一致した範囲は Decoration.replace + WidgetType で「生のタグ markup を隠し、サニタイズ済み
// HTML を描画するウィジェットに置き換える」形にする（M10c で追加予定のソース/プレビュー切替が
// この ON/OFF を担う想定, milestone doc「依存関係」）。一致しないテキストは一切手を加えない。
import { type Extension, RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { sanitizeMarkdownFragment } from './markdownSanitize';

/** `<span style="...">...</span>`（改行を含む内容も許容、非貪欲マッチで最初の `</span>` まで）。 */
const SPAN_PATTERN = /<span\s+style="[^"<>]*">[\s\S]*?<\/span>/g;
/** `<img ...>` または `<img .../>`（自己終了・非終了どちらの記法も許容, M10c 画像貼り付け機能向け）。 */
const IMG_PATTERN = /<img\s+[^<>]*\/?>/g;

class SanitizedMarkdownWidget extends WidgetType {
  constructor(private readonly sanitizedHtml: string) {
    super();
  }

  eq(other: SanitizedMarkdownWidget): boolean {
    return other.sanitizedHtml === this.sanitizedHtml;
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'md-decoration';
    // sanitizeMarkdownFragment が DOMPurify で無害化済みのため innerHTML 設定は安全
    // （許可リスト外のタグ・属性・CSSプロパティ・<script>・on*イベント属性・javascript:スキームは
    // 生成時点で既に除去されている, セキュリティ不変条件, DESIGNv3 §2.3）。
    container.innerHTML = this.sanitizedHtml;
    return container;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

interface RawMatch {
  from: number;
  to: number;
  raw: string;
}

function collectRawMatches(text: string): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const re of [SPAN_PATTERN, IMG_PATTERN]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      matches.push({ from: m.index, to: m.index + m[0].length, raw: m[0] });
      if (m.index === re.lastIndex) re.lastIndex++; // 空マッチ無限ループの防御（理論上は起きない）。
    }
  }
  matches.sort((a, b) => a.from - b.from);
  return matches;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();

  let lastEnd = -1;
  for (const match of collectRawMatches(text)) {
    // span/img の検出が重なった場合（例: img パターンが span 内容の一部に誤って部分一致した等）は
    // 先勝ちの単純規則で除外する（developer 判断。通常の装飾コマンド生成物では重複自体起きない）。
    if (match.from < lastEnd) continue;
    const sanitized = sanitizeMarkdownFragment(match.raw);
    if (!sanitized) continue; // 許可リストで全除去された場合は装飾なし（プレーンテキストのまま表示）。
    builder.add(match.from, match.to, Decoration.replace({ widget: new SanitizedMarkdownWidget(sanitized) }));
    lastEnd = match.to;
  }

  return builder.finish();
}

/**
 * Markdownライブプレビュー描画の ViewPlugin（`.md`メモを開いた場合のみ CodeMirrorEditor.tsx が
 * 組み込む）。文書変更のたびに全文書を再スキャンする（対象は個人用メモ想定で数百KB程度に収まる
 * ため viewport 分割等の最適化は行わない, developer 判断）。
 */
export function buildMarkdownDecorationExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations
    }
  );
}
