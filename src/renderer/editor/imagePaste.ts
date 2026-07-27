// src/renderer/editor/imagePaste.ts
// v3 M10c: クリップボード/ドロップの画像貼り付け（DESIGNv3 §2.5/§2.6、PLANv3 §5.7、
// docs/v3/milestones/M10c-markdown-toolbar-ui.md「画像貼り付けフロー」）。
//
// 【設計判断（designer確認済み・2026-07-26）】挿入するテキストの形式は Markdown リンク記法
// `![](data:image/...)` ではなく HTML の `<img src="data:image/...">` タグとする。理由:
// M10b で既に実装・レビュー/テスト済みのライブプレビュー描画エンジン
// （editor/markdownDecorations.ts の `IMG_PATTERN`）は `<img ...>` タグのみを検出する設計であり、
// `src/shared/constants.ts` の `MARKDOWN_ALLOWED_TAGS`/`MARKDOWN_ALLOWED_IMG_ATTRS`/
// `MARKDOWN_IMAGE_SRC_PATTERN` も HTML `<img>` タグの属性（src/width/height）を前提に定義されている
// （Markdown `![]()` 記法には width/height の概念自体が無い）。DESIGNv3 §2.5/PLANv3 §5.7 に残る
// `![]()` という表記は旧稿の表記揺れであり、DESIGNv3 §2.5 は本判断を反映して更新済み。
//
// 画像データは貼り付け/ドロップ時点で既にレンダラのメモリ上にあるため、追加の I/O・IPC は不要
// （全てレンダラ内で完結する, DESIGNv3 §2.6）。
import { EditorView } from '@codemirror/view';
import { MARKDOWN_IMAGE_SIZE_WARN_BYTES, MARKDOWN_IMAGE_SRC_PATTERN } from '@shared/constants';

/**
 * サイズ警告閾値を超えた画像の挿入待ち要求。呼び出し側（App.tsx）が実際のサイズを含む確認
 * ダイアログ（既存 `ConfirmDialog`）を表示し、続行が選ばれた場合にのみ `insert()` を呼ぶ想定
 * （DESIGNv3 §2.6「警告メッセージには実際に検出した画像サイズを明記する」）。
 */
export interface PendingImageInsert {
  /** 画像データそのものの実バイト数（Base64化前, Blob.size）。警告メッセージのサイズ表示に使う。 */
  sizeBytes: number;
  /** 確認後（または警告不要な場合は直ちに）呼び出すとカーソル/ドロップ位置へ実際に挿入する。 */
  insert: () => void;
}

export interface ImagePasteExtensionOptions {
  /**
   * 画像を検出し Base64 化が完了した時点で呼ばれる。`sizeBytes` が
   * `MARKDOWN_IMAGE_SIZE_WARN_BYTES` 以下の場合はこのコールバックを呼ばずに直接 `insert()` 相当の
   * 処理を行う（呼び出し側で警告要否を毎回判定させない）。
   */
  onImageReady: (request: PendingImageInsert) => void;
  /**
   * 【reviewer指摘 M10c-R1-01 対応】`image/*` ではあるがライブプレビュー描画時のサニタイズ許可
   * リスト（`MARKDOWN_IMAGE_SRC_PATTERN` = png/jpeg/jpg/gif/webpのみ）に含まれない形式
   * （bmp/svg/tiff等）が検出された場合に呼ばれる。挿入自体を行わないため呼ばれなければ何も
   * 起きない（呼び出し側が任意でステータス表示等を行う）。
   */
  onUnsupportedImage?: () => void;
}

/**
 * 【reviewer指摘 M10c-R1-01 対応】貼り付け/ドロップ時点で、描画時のサニタイズ許可リストと
 * 同一基準（`MARKDOWN_IMAGE_SRC_PATTERN`）でサポート対象形式かどうかを判定する。以前は
 * `file.type.startsWith('image/')` という緩い判定のみだったため、`.bmp`/`.svg`等の非対応形式が
 * Base64化されて本文に埋め込まれた後、描画時にサニタイズで `src` 属性ごと除去され「無警告のまま
 * 壊れた画像ウィジェットが残る」問題があった。許可リストを`constants.ts`側と二重管理せず、
 * サニタイズと全く同じ正規表現で判定することで基準のズレを構造的に防ぐ。
 */
function isSupportedImageFile(file: File | null): file is File {
  return !!file && MARKDOWN_IMAGE_SRC_PATTERN.test(`data:${file.type};base64,`);
}

/**
 * Blob を `data:<mime>;base64,...` の Data URI へ変換する（`FileReader.readAsDataURL` は
 * ブラウザ標準APIでブロブの MIME タイプを自動的に埋め込むため、手動での Base64 エンコードや
 * MIME 判定の実装より確実, developer 判断）。
 */
function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('image read failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 画像 Blob を検出してから実際に挿入するまでの共通処理。`insertPos` は検出時点（ペースト/ドロップ
 * イベント発火時）のカーソル/ドロップ位置を呼び出し元が確定させて渡す（Base64化は非同期のため、
 * 完了時点で選択範囲がずれている可能性がある。挿入時に doc 長でクランプする防御も行う）。
 * 【developer判断】`<img>` に `width`/`height` 属性は付与しない（`MARKDOWN_ALLOWED_IMG_ATTRS` は
 * これらを許可リストに含むが必須にはしていない, DESIGNv3 §2.3）。画像は CSS 側
 * （`.md-decoration img { max-width: 100% }`）でエディタ幅に収まるよう表示時に縮小するため、
 * 固定の width/height 属性を付与すると縦横比が崩れる懸念があり、実装を単純に保つ。
 */
function handleImageBlob(view: EditorView, blob: Blob, insertPos: number, options: ImagePasteExtensionOptions): void {
  const sizeBytes = blob.size;
  void readAsDataUrl(blob)
    .then((dataUrl) => {
      const markup = `<img src="${dataUrl}">`;
      const insert = (): void => {
        // EditorView が既に破棄されている（メモ切替等, 非同期完了までのタイムラグ中）場合は何もしない。
        if (!view.dom.isConnected) return;
        const pos = Math.max(0, Math.min(insertPos, view.state.doc.length));
        view.dispatch({
          changes: { from: pos, to: pos, insert: markup },
          selection: { anchor: pos + markup.length }
        });
        view.focus();
      };
      if (sizeBytes > MARKDOWN_IMAGE_SIZE_WARN_BYTES) {
        options.onImageReady({ sizeBytes, insert });
      } else {
        insert();
      }
    })
    .catch((e: unknown) => console.error('image paste failed', e));
}

/**
 * 画像貼り付け/ドロップの CodeMirror 拡張一式を構築する（`.md`メモのみ組み込む想定,
 * CodeMirrorEditor.tsx の `markdown` prop 参照）。内部ツリー DND（メモの並べ替え）は
 * `dataTransfer.files` を使わない別形式（`MEMO_DND_MIME`）のため、本拡張のドロップ判定
 * （`files` の有無）とは競合しない。
 */
export function buildImagePasteExtension(options: ImagePasteExtensionOptions) {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      const items = event.clipboardData?.items;
      if (!items) return false;
      for (const item of items) {
        if (!item || item.kind !== 'file' || !item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (!file) continue;
        // ここに到達した時点で「画像として貼り付けようとしている」ことは確定しているため、
        // 対応形式外でも preventDefault してユーザーへ明示的に知らせる（サポート外形式の生バイト列が
        // ブラウザ既定動作で意図せず別の形で挿入されるのを防ぐ, M10c-R1-01対応）。
        event.preventDefault();
        if (!isSupportedImageFile(file)) {
          options.onUnsupportedImage?.();
          return true;
        }
        handleImageBlob(view, file, view.state.selection.main.from, options);
        return true;
      }
      return false;
    },
    drop: (event, view) => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return false;
      let imageFile: File | null = null;
      for (const candidate of files) {
        if (candidate.type.startsWith('image/')) {
          imageFile = candidate;
          break;
        }
      }
      if (!imageFile) return false;
      event.preventDefault();
      if (!isSupportedImageFile(imageFile)) {
        options.onUnsupportedImage?.();
        return true;
      }
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from;
      handleImageBlob(view, imageFile, pos, options);
      return true;
    }
  });
}
