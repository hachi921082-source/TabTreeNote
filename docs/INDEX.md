# docs/INDEX.md — developer 向けドキュメント索引

**TabTreeNote** は、ローカルのテキストメモを「タブ × ツリー構造」で階層管理する個人用メモエディタ（Electron + TypeScript, Windows 11 優先）。

## 正本と派生ドキュメントの関係

- **正本（確定済み・上書き禁止）**: [DESIGN.md](../DESIGN.md)（設計判断の正本）/ [PLAN.md](../PLAN.md)（実装計画の初版。reviewer/Gemini/ChatGPT 計 4 回のレビューで精緻化済み）。
- **本 `docs/` 配下は、DESIGN.md/PLAN.md から抽出・要約して再構成した派生ドキュメント**。各記述は元の該当セクション番号（例「DESIGN §2.9」「PLAN §5.4」）を明記している。詳細な理由・トレードオフの背景が必要なときのみ、記載の節番号で正本を参照すること。
- 派生ドキュメントと正本に齟齬が生じた場合、**正本（DESIGN.md / PLAN.md）が優先**。

## developer への使い方

> 着手するマイルストーンの `docs/milestones/M{N}-*.md` と [`docs/00-core-principles.md`](00-core-principles.md) を読めば基本的に着手可能。
> 詳細な設計判断の背景・トレードオフの理由が必要な場合のみ、各ドキュメントに記載された DESIGN.md/PLAN.md の節番号を参照すること。
> 型定義が必要なときは [`docs/data-model.md`](data-model.md) を参照（実装時にそのままコピー&ペースト可能な精度で転記済み）。

## 横断的な共通原則

- [00-core-principles.md](00-core-principles.md) — 複数マイルストーンで繰り返し参照する横断ルール（`Result<T>`/エラーコード、アトミック書き込み、同期順序、自己書き込み予約テーブル、競合判定 2 系統、hash 対象、Windows リトライ、エラーハンドリング表全体、メタ復旧カスケード、セキュリティ不変条件、名前サニタイズ）。

## 型定義リファレンス

- [data-model.md](data-model.md) — PLAN §4 全体（メタ JSON / アプリ設定 JSON / `.txtenc` フォーマット / IPC 共通型の TypeScript 定義）を集約・転記。

## マイルストーン別ドキュメント一覧（PLAN §7）

| M | ドキュメント | 一行概要 |
|---|-------------|----------|
| M0 | [M0-scaffold.md](milestones/M0-scaffold.md) | 足場: electron-vite 初期化、TS strict、3 プロセス雛形、セキュリティ設定、`Result` 型、空の 3 ペイン UI + テーマ切替 |
| M1 | [M1-file-core.md](milestones/M1-file-core.md) | ファイル層コア（平文）: atomicWrite+`.bak`/encoding/eol/memoFileService/tabService/metaStore、平文メモの開く・編集・保存が一通り動く |
| M2 | [M2-tree-ui.md](milestones/M2-tree-ui.md) | ツリー UI + メタ同期: 仮想化ツリー、開閉/複数選択、追加位置、リネーム/削除/複製/移動・コピー、DND、同期順序、サニタイズ UX |
| M3 | [M3-search.md](milestones/M3-search.md) | 検索: 現在メモ内検索・置換・正規表現、全文検索メモリ内インデックス（起動時構築+経路① 差分更新）、検索履歴、結果ジャンプ |
| M4 | [M4-watch.md](milestones/M4-watch.md) | ファイル監視: chokidar + `ignored` 除外 + 自己発火除外 + デバウンス + 競合判定 + 解決ダイアログ/ロック + 経路② インデックス更新 |
| M5 | [M5-links.md](milestones/M5-links.md) | リンク機能: 装飾（URL/mail/path/`memo:`）、外部起動（確認+`path.resolve`+OS API）、`memo:` 解決・遷移 |
| M6 | [M6-crypto.md](milestones/M6-crypto.md) | パスワード暗号化: cipher/encFormat/sessionKeyStore、暗号化変換、開封/保存（新 IV）/PW 変更/ロック、検索・AutoReName 除外・低頻度保存・厳格履歴破棄 |
| M7 | [M7-polish.md](milestones/M7-polish.md) | 仕上げ: ステータスバー、エディタ各種トグル、ショートカット、トレイ常駐、AutoReName、設定画面、マイグレーション土台、ポータブル配布 |

**依存関係（PLAN §7）**: M1 は全ての土台。M4 は M1/M2 完了後。M6 は M1（atomicWrite/eol）と M3（インデックス除外）に依存。M5 は M1/M2 後ならいつでも可。

## M7完成後の変更ログ

- [post-M7-changes.md](post-M7-changes.md) — M0〜M7完成後、実機確認を通じて行ったバグ修正・仕様変更・新機能追加のまとめ（正式なマイルストーン計画を経ずチャットで都度実装したもの）。ポータブル化（設定/データのexe基準保存）、多重起動防止、ツリー右クリックメニュー整理、エディタ右クリックメニュー拡充、編集ロック、UI文字サイズ設定等。

## v3 追加機能（設計・実装計画確定、マイルストーン分割済み・実装未着手）

- [v3/DESIGNv3.md](v3/DESIGNv3.md) — ノード（サブツリー）単位のパスワードロック、Markdown＋ライブプレビューの2機能に関する設計ドキュメント（`DESIGN.md`/`PLAN.md`はv1スコープの正本のまま変更せず、この2機能に限りDESIGNv3.mdが正本）。設計内容はユーザー確認済み。
- [v3/PLANv3.md](v3/PLANv3.md) — 上記2機能の実装計画（DESIGNv3.mdを実装可能な粒度へ具体化。IPC設計・ファイル構成・データモデル・処理フロー・実装補完事項§7を含む）。ユーザー確認済み。

### v3マイルストーン別ドキュメント一覧

| M | ドキュメント | 一行概要 | 依存 |
|---|-------------|----------|------|
| M8 | [v3/milestones/M8-node-lock-core.md](v3/milestones/M8-node-lock-core.md) | ノードロック基盤: 単発のロック/解除/再ロック、難読化ファイル名、ブロブ暗号化、`claimedTokens`による孤児ファイル対策 | v1 M1/M2/M6 |
| M9a | [v3/milestones/M9a-node-lock-session-ops.md](v3/milestones/M9a-node-lock-session-ops.md) | ノードロック応用①: セッション中の構造変更（作成/リネーム/削除/複製）、入れ子ロック | M8必須 |
| M9b | [v3/milestones/M9b-node-lock-boundary-move.md](v3/milestones/M9b-node-lock-boundary-move.md) | ノードロック応用②: 境界を跨ぐ移動・コピー（一方通行の金庫） | M9a必須 |
| M9c | [v3/milestones/M9c-node-lock-tab-switch.md](v3/milestones/M9c-node-lock-tab-switch.md) | ノードロック応用③: タブ切替時のセッション一括破棄 | M8必須（M9a/M9bとは独立、M9a後推奨） |

> 元は単一の[M9-node-lock-session-ops.md](v3/milestones/M9-node-lock-session-ops.md)だったが、実行コストが大きいためユーザー判断でM9a/M9b/M9cへ3分割（経緯・全体像は元ファイル参照）。
| M10a | [v3/milestones/M10a-markdown-format-core.md](v3/milestones/M10a-markdown-format-core.md) | Markdown①: 保存形式基盤・全文検索反映（`.md`拡張子対応、`memo:convertFormat`、暗号化`format`フィールド） | v1 M1/M3/M6（M8/M9とは独立） |
| M10b | [v3/milestones/M10b-markdown-live-preview.md](v3/milestones/M10b-markdown-live-preview.md) | Markdown②: 装飾ライブプレビュー描画・サニタイズ・右クリック装飾コマンド | M10a必須 |
| M10c | [v3/milestones/M10c-markdown-toolbar-ui.md](v3/milestones/M10c-markdown-toolbar-ui.md) | Markdown③: ツールバー・ソース/プレビュー切替・画像貼り付け・`.txt`⇔`.md`変換UI | M10a/M10b必須 |

> 元は単一の[M10-markdown-preview.md](v3/milestones/M10-markdown-preview.md)だったが、実行コストが大きいためユーザー判断でM10a/M10b/M10cへ3分割（経緯・全体像は元ファイル参照）。

## M10完成後の変更ログ

- [post-M10-changes.md](post-M10-changes.md) — M10c（v3スコープ全体）完成後、実機での動作確認を通じてユーザーから報告されたバグ調査結果と、追加で依頼された仕様変更（ノードロックの恒久解除機能・ロック中ノードの削除制限等）のまとめ。[post-M7-changes.md](post-M7-changes.md)と同種の位置づけ（正式なマイルストーン計画を経由せずチャットで都度合意した変更の記録）だが、英語で記述している（ユーザー指示）。

developerへの実装依頼はまだ行っていない。ユーザーからの明示的な着手指示を待つ。
