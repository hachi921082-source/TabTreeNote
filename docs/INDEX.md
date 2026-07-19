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
