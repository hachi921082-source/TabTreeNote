// src/renderer/editor/links.ts
// リンク装飾（URL/mail/path/`memo:` の検出）と CodeMirror 6 拡張（PLAN §5.8 / DESIGN §2.8）。
//
// 本文中のパターンを検出し CodeMirror デコレーション（下線+専用クラス）を付与する。
// 実際の外部起動/`memo:` 遷移（IPC 呼び出し・確認ダイアログ）はこのモジュールでは行わず、
// クリック検出時に `onLinkClick` コールバックへ委譲する（CodeMirrorEditor.tsx が
// onChange/onStats/onSave と同様に親コンポーネント（App.tsx）へ処理を渡すパターンに合わせる）。
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import type { AppSettings } from '@shared/models';

export type LinkKind = 'url' | 'mailto' | 'path' | 'memo';

export interface DetectedLink {
  kind: LinkKind;
  /** 検出された元テキスト（`memo:`/`mailto:` プレフィックスを含む。前後の空白等は含まない）。 */
  raw: string;
  from: number;
  to: number;
}

/**
 * 本文中のリンク候補を検出する正規表現。
 * 優先順位（左の代替が先に試される）: `memo:` 記法 → URL（スキーム明示/`www.`）→ `mailto:` 明示
 * → 素のメールアドレス → ファイルパス（ドライブレター/`.\`/`..\`/`file://`）。
 * 各代替は開始位置ごとに排他的（同じ開始位置で複数が同時マッチすることはない）。
 *
 * 【M10c-T1-01 バグ修正, developer判断】メールアドレス代替（`@`より前の部分）の量指定子は
 * 上限を設けている（ローカル部は RFC 5321 の実務上限である64文字、ドメインの各ラベルは DNS の
 * 上限である63文字、ラベル数は最大8つまでの寛容な上限）。理由: 無制限量指定子 `[...]*@...` は、
 * `@` を一切含まない巨大な連続文字列（例: Markdown画像貼り付け機能で挿入される
 * `<img src="data:image/...;base64,...">` の base64 データ本体, imagePaste.ts）に対して実行すると、
 * 「`@` が見つかるまで貪欲に伸ばしては1文字ずつバックトラックする」という失敗探索を文字列中の
 * ほぼ全開始位置（英数字なら常に開始位置になりうる）で繰り返すため O(文書長²) に爆発し、
 * 実測で長さ数十万〜100万文字級の1行に対して数分間レンダラプロセスが完全にビジーループする
 * 不具合（tester指摘 M10c-T1-01, Critical）の原因になっていた。量指定子に現実的な上限を設けることで
 * 各開始位置あたりの最悪計算量を定数（上限で頭打ち）に抑え、文書全体でも O(文書長) に収まる
 * （実測: 140万文字の非該当文字列に対し修正前は数分〜十数分規模だったのに対し修正後は約0.26ms）。
 * 実在するメールアドレス（ローカル部64文字・各ラベル63文字・ラベル数8個のいずれも現実的な
 * メールアドレスが超えることはまず無い）の検出結果は変化しない（サニティケースで確認済み）。
 */
const LINK_PATTERN =
  /(memo:\S+)|((?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'）」』]+)|(mailto:\S+)|([A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8})|((?:[A-Za-z]:\\|\.\\|\.\.\\|file:\/\/)[^\s<>"'）」』]*)/g;

/** リンク末尾に紛れ込みやすい文末記号・閉じ括弧類を取り除く（対応する開き括弧の有無までは見ない簡易実装）。 */
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}」』】、。]+$/;

function trimTrailingPunctuation(raw: string): string {
  return raw.replace(TRAILING_PUNCTUATION_RE, '');
}

/** 文書全文からリンク候補を検出する（小規模なプレーンテキストメモを想定, developer 判断）。 */
export function detectLinks(text: string): DetectedLink[] {
  const results: DetectedLink[] = [];
  LINK_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign -- global regex の逐次 exec 走査
  while ((m = LINK_PATTERN.exec(text))) {
    const [, memo, url, mailtoExplicit, email, path] = m;
    let kind: LinkKind;
    let raw: string;
    if (memo !== undefined) {
      kind = 'memo';
      raw = memo;
    } else if (url !== undefined) {
      kind = 'url';
      raw = url;
    } else if (mailtoExplicit !== undefined) {
      kind = 'mailto';
      raw = mailtoExplicit;
    } else if (email !== undefined) {
      kind = 'mailto';
      raw = email;
    } else if (path !== undefined) {
      kind = 'path';
      raw = path;
    } else {
      continue;
    }

    const trimmed = kind === 'memo' ? raw : trimTrailingPunctuation(raw);
    if (trimmed.length === 0) continue;
    results.push({ kind, raw: trimmed, from: m.index, to: m.index + trimmed.length });
  }
  return results;
}

const linkMarkDecoration = Decoration.mark({ class: 'cm-link' });

function buildDecorations(links: readonly DetectedLink[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const link of links) {
    builder.add(link.from, link.to, linkMarkDecoration);
  }
  return builder.finish();
}

class LinkDecorationPluginValue implements PluginValue {
  links: DetectedLink[];
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.links = detectLinks(view.state.doc.toString());
    this.decorations = buildDecorations(this.links);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.links = detectLinks(update.state.doc.toString());
      this.decorations = buildDecorations(this.links);
    }
  }
}

const linkDecorationPlugin = ViewPlugin.fromClass(LinkDecorationPluginValue, {
  decorations: (v) => v.decorations
});

export interface LinkExtensionOptions {
  /** クリック判定時点の最新の操作方式を返す（設定変更を Compartment 無しで反映するため）。 */
  getOpenTrigger: () => AppSettings['links']['openTrigger'];
  onLinkClick: (link: DetectedLink) => void;
}

function isTriggerMatch(
  trigger: AppSettings['links']['openTrigger'],
  eventType: 'click' | 'dblclick',
  event: MouseEvent
): boolean {
  if (trigger === 'ctrlClick') return eventType === 'click' && event.ctrlKey;
  if (trigger === 'singleClick') return eventType === 'click';
  return eventType === 'dblclick'; // 'doubleClick'
}

function handlePointerEvent(event: MouseEvent, view: EditorView, eventType: 'click' | 'dblclick', options: LinkExtensionOptions): boolean {
  if (!isTriggerMatch(options.getOpenTrigger(), eventType, event)) return false;

  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return false;

  const plugin = view.plugin(linkDecorationPlugin);
  const link = plugin?.links.find((l) => pos >= l.from && pos <= l.to);
  if (!link) return false;

  event.preventDefault();
  options.onLinkClick(link);
  return true;
}

/**
 * リンク装飾+クリックハンドリングの CodeMirror 拡張一式を構築する。
 * `onLinkClick`/`getOpenTrigger` は呼び出し側（CodeMirrorEditor.tsx）が ref 経由で
 * 常に最新のコールバック/設定を返すようにラップして渡すこと（onChange 等と同じパターン）。
 */
export function buildLinkExtension(options: LinkExtensionOptions) {
  return [
    linkDecorationPlugin,
    EditorView.domEventHandlers({
      click: (event, view) => handlePointerEvent(event, view, 'click', options),
      dblclick: (event, view) => handlePointerEvent(event, view, 'dblclick', options)
    })
  ];
}
