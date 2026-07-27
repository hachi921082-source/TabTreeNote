// src/main/watch/activeMemoState.ts
// レンダラの「現在開いている（かつ未保存の変更があるか）」メモの状態を追跡する（M4）。
//
// DESIGN §3.3「外部編集との競合」は、編集中（未保存の変更がある）メモに外部変更を検知した
// 場合のみ `evt:conflict` を発火し、そうでなければ `evt:externalChange` で静かに反映すると
// 規定する。この「未保存の変更（dirty）」はレンダラの CodeMirror バッファ由来の情報であり
// メインプロセスは本来関知しないため、レンダラが変化のたびに `editor:reportActive`
// （PLAN/DESIGN の IPC チャネル一覧には明記が無い、本 M4 実装で追加した最小限の一方向通知。
// developer 判断、reviewer 確認事項）で通知し、ここへ保持する。
//
// 本アプリは単一ウィンドウ・単一エディタペイン構成（同時に開けるメモは常に高々 1 件,
// PLAN §1.3/src/renderer/App.tsx）のため、タブ横断のグローバル単一状態で足りる。
export interface ActiveMemoState {
  tabId: string;
  memoName: string;
  dirty: boolean;
  /**
   * 【2026-07-26追記・v3 M10b】現在開いているメモがMarkdown（`.md`由来）かどうか
   * （main/index.ts の `context-menu` ハンドラが「文字色/太字/文字サイズ」メニュー項目を
   * `.md`メモ編集時のみ追加するために使う）。`undefined`=不明。
   */
  format?: 'plain' | 'markdown';
}

let current: ActiveMemoState | null = null;

/** レンダラから報告された最新の状態に置き換える（`null` はメモを閉じた/未選択を表す）。 */
export function setActiveMemoState(state: ActiveMemoState | null): void {
  current = state;
}

/** 現在の状態を取得する（watch/watcher.ts が競合判定に使用）。 */
export function getActiveMemoState(): ActiveMemoState | null {
  return current;
}
