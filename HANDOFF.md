# 引き継ぎメモ(HANDOFF.md)

> 新しいチャットを開始したら、まずこのファイルを読んで状況を把握してください。
> ワークフロー自体は [CLAUDE.md](CLAUDE.md) に記載済み(4エージェント体制: designer/developer/reviewer/tester)。

## プロジェクト概要

**TabTreeNote**: フリーソフト「CatMemoNote」(作者 Pyo / PapparaSoft, 2008-2014, Windows専用のタブ×ツリー型メモ管理ソフト)を参考に、個人用途で「より使いやすいCatMemoNote風タブエディタ」を新規実装するプロジェクト。UUID等は使わずファイル名=メモ名とするプレーンテキスト踏襲のデータモデルが特徴。技術スタックはElectron + TypeScript。

## 現在の状態(2026-07-23時点)

**設計・実装計画は確定済み。実装はM0〜M3が完了し、コミット済み(未プッシュ)。次はM4(ファイル監視)から。**

- [DESIGN.md](DESIGN.md): 確定済み設計ドキュメント(未確定・保留事項なし)
- [PLAN.md](PLAN.md): DESIGN.mdを土台にした実装計画。reviewer→Gemini→ChatGPT→ChatGPT(縁ケース2件追記)の**計4回のレビューサイクル**を経て精緻化済み
- `docs/`: developerがマイルストーンごとに参照するための派生ドキュメント群(下記「ドキュメント構成」参照)。DESIGN.md/PLAN.mdは正本のまま変更していない

### 実装進捗(4エージェント体制: developer→reviewer→tester)

| マイルストーン | 状態 | 備考 |
|---|---|---|
| M0 足場 | ✅完了(reviewer/tester合格) | electron-vite、TS strict、3プロセス雛形、CSP設定 |
| M1 ファイル層コア | ✅完了(reviewer 2ラウンド/tester合格) | atomicWrite、メタJSON、平文メモread/save |
| M2 ツリーUI+メタ同期 | ✅完了(reviewer 2ラウンド/tester合格) | 仮想化ツリー、DND、タブバー、サニタイズUX |
| M3①CodeMirror統合 | ✅完了(reviewer 1ラウンド/tester合格) | CodeMirror 6化、検索/置換/正規表現、改行コード保持 |
| M3②全文検索本体 | ✅完了(reviewer 1ラウンド/tester合格) | searchIndex.ts、経路①差分更新、検索パネル |
| M4 ファイル監視 | ⬜未着手 | 次のアクション |
| M5〜M7 | ⬜未着手 | リンク機能・暗号化・仕上げ |

M0〜M3の実装コード(54ファイル)は**役割記載付きで1ファイル1コミット済み**(commit-with-roleエージェント使用)。**リモートへのプッシュはまだ行っていない**。

### 次のチャットで最初にすべきこと
M4(ファイル監視)をdeveloperエージェントに依頼する。依頼テンプレートは下記「マイルストーン依頼の型」参照。M3までは順調にreviewer 1〜2ラウンドで収束しており、この調子で進めてよい。

## Git/リモート構成

- ローカルgit初期化済み、ブランチ`v2`
- GitHub上に**privateリモート**(`origin`)作成済み: `https://github.com/hachi921082-source/TabTreeNote`
- ライセンス: MIT(著作権者 `hachi921082-source`)
- `.gitignore`: `CatMemoNote/`(第三者フリーソフト本体一式、再配布懸念のため除外)、`node_modules/`、`dist/`等
- コミットは基本的にユーザーの明示指示があった時のみ行う(「役割を記載してコミットして」→commit-with-roleエージェント)

## ドキュメント構成(developer/reviewer/testerが参照する場所)

DESIGN.md/PLAN.mdを土台に、マイルストーンごとに必要な情報だけを参照できるよう`docs/`配下に派生ドキュメントを作成済み(正本はあくまでDESIGN.md/PLAN.md)。

- `docs/INDEX.md`: エントリポイント。マイルストーン一覧と使い方
- `docs/00-core-principles.md`: 横断的共通原則(Result型規約、アトミック書き込み、同期順序、selfWriteRegistry、競合判定2系統、エラー表全体、セキュリティ不変条件等)
- `docs/data-model.md`: 型定義(メタJSON/アプリ設定JSON/.txtencフォーマット/IPC共通型、コピペ可能な精度で転記済み)
- `docs/milestones/M0〜M7`: 各マイルストーンのゴール・依存関係・対象IPCチャネル・型・処理フロー・ディレクトリ構成

### マイルストーン依頼の型
新しいマイルストーンをdeveloperに依頼する際は、この型で(番号とファイル名だけ差し替え):

```
このリポジトリでのプロジェクトでマイルストーンM{N} — ({名称})の実装に着手してください
M{N-1}は完了済みの前提です
【まず読むもの】
1. docs/INDEX.md
2. docs/milestones/M{N}-{name}.md
3. docs/00-core-principles.md
4. docs/data-model.md
DESIGN.md・PLAN.mdは確定済みの正本ですが、上記4ファイルで基本的に
着手可能な構成になっています。全文を読み直す必要はありません。
M{N}完了後は静的レビュー(reviewer)に回せる状態にしてください。
```

コミット・プッシュは作業ツリーへの変更のみとし、ユーザーの明示指示があるまで行わないよう毎回明記すること。

## 運用方針(利用量節約 — 重要)

ユーザーから明示的な依頼あり。詳細はauto memory([feedback_agent_delegation.md](C:\Users\m9112\.claude\projects\c--Users-m9112-vscode2-TabTreeNote\memory\feedback_agent_delegation.md)相当)にも記録済み:

- **簡単な作業は直接対応**: ファイル1つの軽微な修正・確認・簡単な調査はサブエージェントに投げずオーケストレーター自身が行う
- **レビューサイクルは目安2回で打ち切り**: 2回で収束しない(3回目に入りそうな)場合は自律的にループを継続せず、その時点でユーザーに報告し指示を仰ぐ。強制的にパスさせない
- developer/reviewer/testerセッションによっては**Agentツールが使えない**ことがある(実際にM3①②で発生)。その場合developerは自分でreviewer→testerを呼べないため、オーケストレーターが代わりに橋渡しする
- 週間トークン制限が厳しい時期があった(2026-07-23時点で解消傾向)。制限に達すると该当エージェントはAPIエラーで強制終了するが、それまでの成果は残るので、リセット後にSendMessageで再開すればよい(同一agentIdへ送るとtranscriptから再開できる)
- CronCreateによる自動再開スケジュールは**セッション内でのみ有効**(ディスク非保存、セッション終了で消える)。長時間(10時間超)の予約は当てにしすぎないこと

## 確定した主要設計判断(抜粋。詳細はDESIGN.md §0・§7参照)

- 技術スタック: Electron + TypeScript
- データ形式: メモ=`.txt`(UTF-8)、タブ=フォルダ、メモ識別=ファイル名(UUID不採用)
- v1コア機能: ツリー型タブ管理/編集/検索置換(正規表現・全文検索)/ライト・ダークテーマ/**リンク機能**(URL・メール・ファイル自動認識+`memo:`リンク)/**パスワード暗号化**(AES-256-GCM+scrypt、専用拡張子`.txtenc`)
- 全文検索: メモリ内軽量インデックス(起動時構築、アプリ内変更は直接反映・外部変更のみファイル監視経由) — **M3で実装済み**
- バックアップ: 保存時に直近1世代の`.bak`を保持(本文/暗号化メモ/メタJSON/アプリ設定すべて対象) — **M1で実装済み**
- タブ名の重複禁止、ファイル名サニタイズ(Windows禁止文字を入力時にブロック) — **M2で実装済み**
- ファイル監視の自己発火除外: 一時ファイルは固定プレフィックスでchokidarの`ignored`により監視除外、アプリ発の操作は予約テーブルで自己発火除外 — **M4で実装予定(selfWriteRegistry自体はM1で登録APIのみ作成済み、消費はM4)**
- 既知の制限としてWindows長パス(260文字超)は v1 非対応
- 暗号化状態の真実源は拡張子`.txtenc`(メタJSONには暗号フラグを冗長に持たせない。PLAN.md精緻化時にDESIGN.md §2.9の字面もこれに合わせて修正済み)

## 未実装のまま合意で見送った論点

- メタJSONが「正常だが1件だけ参照ファイルが無い」場合の部分修復(現状は復旧カスケードで全体をフラット再生成する仕様のまま。ユーザーの判断で「しない」と確定 — 対応不要)
- PLAN.md §8に、リネーム中/暗号化変換中の外部変更競合を「受容済みリスク」として記録(項目6・7。v1では追加の検出機構を実装しない)

## ファイル構成

- [spec.md](spec.md): 空(CatMemoNote紹介記事URLが入っていたためユーザーが削除)
- [CLAUDE.md](CLAUDE.md): 4エージェント体制のワークフロー定義
- [DESIGN.md](DESIGN.md): 確定済み設計ドキュメント(本体)
- [PLAN.md](PLAN.md): 実装計画(4回のレビューで精緻化済み、正本)
- `docs/`: マイルストーン別参照ドキュメント(上記参照)
- `src/`: 実装コード(M0〜M3完了分)
- `CatMemoNote/`: 実際に配布されているCatMemoNote本体一式(調査済み、readme.txtはShift-JIS。**gitignore対象、リモートに上げない**)
- `AGENT_LOG.md`: 各エージェントの作業ログ(コミット対象外)
- 本ファイル([HANDOFF.md](HANDOFF.md)): 引き継ぎメモ
