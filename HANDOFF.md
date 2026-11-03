# 引き継ぎメモ(HANDOFF.md)

> **2026-07-29時点: M10c完了以降の最新状況は [docs/v3/HANDOFFv3.md](docs/v3/HANDOFFv3.md) を参照してください。**
> 本ファイル(HANDOFF.md)はM10c完了時点(2026-07-25/26)で更新が止まっており、それ以降の作業
> (ノードロック設計追加検討・Markdown装飾バグ修正・ブランチ`v4`への移行・専用エージェント名の変更等)
> は反映されていません。プロジェクト概要・v1(M0〜M7)の経緯・ドキュメント構成など背景情報は
> 引き続き本ファイルが正本ですが、「現在の状態」「次にすべきこと」は[docs/v3/HANDOFFv3.md](docs/v3/HANDOFFv3.md)を優先してください。
>
> 新しいチャットを開始したら、まずこのファイルを読んで状況を把握してください。
> ワークフロー自体は [CLAUDE.md](CLAUDE.md) に記載済み(4エージェント体制: designer/developer/reviewer/tester)。
> **ただし2026-07-28/29時点でdesigner/developer/reviewer/tester専用エージェントは利用不可になっており、
> 代わりにdesigner-lite/developer-lite/reviewer-liteを使う必要があります。詳細は[docs/v3/HANDOFFv3.md](docs/v3/HANDOFFv3.md)参照。**

## プロジェクト概要

**TabTreeNote**: フリーソフト「CatMemoNote」(作者 Pyo / PapparaSoft, 2008-2014, Windows専用のタブ×ツリー型メモ管理ソフト)を参考に、個人用途で「より使いやすいCatMemoNote風タブエディタ」を新規実装するプロジェクト。UUID等は使わずファイル名=メモ名とするプレーンテキスト踏襲のデータモデルが特徴。技術スタックはElectron + TypeScript。

## 現在の状態(2026-07-25時点)

**設計・実装計画は確定済み。実装はM0〜M7の全マイルストーンが完了し、コミット済み(未プッシュ)。v1スコープの実装は完了。**

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
| M4 ファイル監視 | ✅完了(reviewer 1ラウンド+非ブロッキング指摘1件修正/tester合格) | chokidar監視、selfWriteRegistry期待値機構、競合解決ダイアログ |
| M5 リンク機能 | ✅完了(reviewer 2ラウンド/tester 2ラウンド合格) | URL/mailto/パス/memo:リンク検出・外部起動、tester発見のshell.openPathハング対策修正込み |
| M6 パスワード暗号化 | ✅完了(reviewer 2ラウンド/tester合格) | AES-256-GCM+scrypt、.txtenc、reviewer指摘2件(外部変更時の暗号メモ静か上書き・未開封メモのパスワード変更でのセッション鍵常駐)を修正済み |
| M7 仕上げ | ✅完了(reviewer 2ラウンド/tester合格) | タスクトレイ常駐、AutoReName、設定画面、平文自動保存、設定可能ショートカット、スキーマ移行土台。reviewer指摘1件(旧形式設定ファイル読込時のshortcuts未補完)を修正済み。ユーザー判断でsessionRememberPassword設定は未実装のままUIから削除 |

M0〜M7の実装コード(合計約118ファイル)は**役割記載付きで1ファイル1コミット済み**(commit-with-roleエージェント使用)。**リモートへのプッシュはまだ行っていない**。

### 次のチャットで最初にすべきこと
v1スコープの全マイルストーン(M0〜M7)は完了済み。v3のノード単位パスワードロックはM8/M9a/M9b/M9cまで完了済み。Markdown＋ライブプレビュー(M10、実行コストが大きいためM10a/M10b/M10cへ3分割済み)は**M10a・M10bが完了済みで、残るはM10cのみ**（設計・実装計画は`DESIGNv3.md`/`PLANv3.md`とも確定済み、下記「v3追加機能」参照）。次のアクションはユーザー次第（M10c着手指示、リモートへのプッシュ、その他の要望・バグ報告への対応等）。

**M10c着手を指示された場合**: 下記「v3マイルストーン依頼の型」のM10c行の通り依頼文を組み立ててdeveloperを起動すればよい（`docs/v3/milestones/M10c-markdown-toolbar-ui.md`が自己完結しており、DESIGNv3.md/PLANv3.mdの全文再読込は不要）。tester依頼時は、上記「現在のステータス」に記載のM10b tester事故の教訓（ネイティブ右クリックコンテキストメニューのCDP合成クリックはハングするため、DOM直接操作で代替すること）を明記すること。

**重要**: ユーザーの明示的な指示なしにdeveloper等のサブエージェントを自発的に起動しないこと。この「次にすべきこと」欄は引き継ぎメモであり指示ではない。ユーザーから明示的な指示を受けてから動くこと(詳細は[[feedback_agent_delegation]]、下記「運用方針」参照)。

**トークン節約の方向性(2026-07-26、複数回にわたりユーザーから念押しされた重要方針)**: 節約は**「不要になった/関係の無い長大なファイルを読み込ませない」方向**で行う。**「レビュー/テストの往復回数を減らす」方向では行わない**(回数はこれまで通り目安2回で運用し、2回で収束しなければユーザーに報告)。この2つを混同しないこと。詳細・具体的な運用ルールは下記「v3作業時の参照範囲ルール」「運用方針」セクション、および[[feedback_agent_delegation]]参照。M10着手時も、v1専用ドキュメント(DESIGN.md/PLAN.md/docs/milestones/M0〜M7等)やM8/M9系の資料は不要なので読み込まないこと。

## v3作業時の参照範囲ルール（トークン節約・重要・必読）

2026-07-26、v3 M8〜M9b実装中にユーザーから「トークン消費が激しい」との指摘を受け整理した方針。**方向性は「レビュー/テストの往復回数を減らす」ことではなく（回数はこれまで通り目安2回で運用する）、「不要になった/関係の無い大きいファイルを読み込ませない」こと**。混同しないこと。

- **v3作業(M8以降)で読めば足りるもの**: `docs/INDEX.md`、着手する`docs/v3/milestones/M{N}-*.md`、`docs/00-core-principles.md`、`docs/data-model.md`、`AGENT_LOG.md`（v3部分のみ。末尾を見れば直近の経緯が分かる）。
- **v3作業では原則参照不要なもの（v1専用。明示的にv1固有の挙動を確認する必要が生じた場合のみ個別に開く）**: `DESIGN.md`、`PLAN.md`、`docs/milestones/M0〜M7*.md`、`docs/post-M7-changes.md`、`AGENT_LOG-v1-archive.md`。developer/reviewer/testerへの依頼文で「これらは参照不要」と明記すること（下記「マイルストーン依頼の型」参照）。
- サブエージェントへの依頼文自体も、AGENT_LOG.mdに書いてある経緯・修正内容を再度長文で要約・転記せず「AGENT_LOG.md末尾を読むこと」で済ませる（過去の指摘内容を毎回コピペしない）。
- ドキュメントや作業記録が今後また肥大化した場合は、都度この方針に沿って不要になった部分をアーカイブへ分離すること（`AGENT_LOG.md`→`AGENT_LOG-v1-archive.md`分離が実例。同じ手法を横展開する）。

## v3追加機能: ノード単位パスワードロック・Markdown＋ライブプレビュー（設計・実装計画確定。ノードロックはM8〜M9c、Markdownの一部(M10a/M10b)まで実装完了、残るはM10cのみ）

**正本は[docs/v3/DESIGNv3.md](docs/v3/DESIGNv3.md)**（設計）**・[docs/v3/PLANv3.md](docs/v3/PLANv3.md)**（実装計画）（`DESIGN.md`/`PLAN.md`はv1スコープのまま変更していない。この2機能に限りDESIGNv3.md/PLANv3.mdが正本）。本欄はこのファイルの要約と経緯のみを記す。詳細は各ファイルを参照し、ここに再掲はしない。

### 経緯（設計確定→実装計画→マイルストーン分割の順で進行）
1. **設計相談**（このチャット内、対話形式）: 「メモ単位の編集ロックをタブ単位に流用できないか」という相談から出発し、タブ単位案は規模過大で不採用、「ツリーのノード（サブツリー）単位」案へ着地。Markdown対応も並行して相談し、方向性を固めた
2. **designer起動**: `docs/v3/DESIGNv3.md`を新規作成させ、上記の相談内容を正式なドキュメント形式に整理。判断が必要な論点11件をQA形式（推奨案付き）で提示させ、ユーザーが全件「推奨案を採用」で確定
3. **外部AIレビュー（DESIGNv3.md、計2回）**: ユーザーがDESIGNv3.mdをChatGPTにレビューさせ16件の指摘を受領・反映。さらにユーザー自身による追加指摘4件（「ロック境界をまたぐ移動はドラッグ事故のリスクがあるのでは」「セッション寿命はタブ切替で破棄した方が安全では」等）も反映し、**当初案「移動は双方向許可」を撤回して「一方通行の金庫」方式（外→中は許可、中→外は禁止・削除のみ可）へ変更**するなど安全側への実質的な設計変更も発生。その後さらにChatGPT第4回レビュー（3件）を反映し`DESIGNv3.md`確定
4. **PLANv3.md作成**（オーケストレーター＝Claude Codeが直接作成。designer起動せず）: `DESIGNv3.md`を実装可能な粒度（IPC設計・ファイル構成・データモデル・処理フロー）へ具体化。この過程で**`claimedTokens`（ロック中の子孫ファイルがツリーに孤児ノードとして露出するのを防ぐための必須フィールド。DESIGNv3.mdに記載が無かった実装補完）等7件の実装補完事項**を発見し、いずれもユーザーに選択肢提示の上で推奨案を確定（PLANv3.md §7参照）
5. **PLANv3.mdの外部AIレビュー（ChatGPT）**: 10件のフィードバック（claimedTokensを前面に出す、移動ルールの表形式化、§7の見出し構造化等）を受け全て反映
6. **マイルストーン分割**: `docs/v3/milestones/`配下にM8〜M10として3分割で作成（下記参照）

### 現在のステータス（2026-07-26 時点）
- `docs/v3/DESIGNv3.md`・`docs/v3/PLANv3.md`とも**確定状態**（未確定事項なし）
- `docs/v3/milestones/`配下、M9はさらに実行コスト削減のためM9a/M9b/M9cへ3分割済み（分割の経緯は`M9-node-lock-session-ops.md`冒頭注記参照）:
  - `M8-node-lock-core.md` — ノードロック基盤（単発のロック/解除/再ロック）。v1 M1/M2/M6に依存。**✅実装完了**（developer→reviewer 2ラウンド→tester、tester自身が発見した回帰1件の再修正込みで合格）
  - `M9a-node-lock-session-ops.md` — セッション中の構造変更・入れ子ロック。M8必須。**✅実装完了**（バックエンド+レンダラ側`lockContext`配線とも、developer→reviewer→tester全工程合格。tester実UI検証で「レンダラ配線漏れ」の追加実装が1往復発生）
  - `M9b-node-lock-boundary-move.md` — 境界を跨ぐ移動・コピー（一方通行の金庫）。M9a必須。**✅実装完了**（developer→reviewer(指摘3件: R1-01/R2-01/R2-02すべて解消)→tester(データ消失バグT1-01を新規発見)→修正→reviewer→tester再検証、全工程合格）
  - `M9c-node-lock-tab-switch.md` — タブ切替時のセッション一括破棄。M8必須（M9a/M9bとは独立）。**✅実装完了**（developer→reviewer(指摘なし)→tester(実UI検証、コア要件すべてOK)全工程合格。tester発見のLow・非ブロッキング事項1件: ロック解除セッション配下のdirty編集でタブ切替時に確認ダイアログが出ず無条件自動保存される。M9a由来の既存挙動でM9c差分外だが、DESIGNv3.md §1.11の文言との乖離があった件は2026-07-27ユーザー判断で解決済み — データ損失は無く安全なためコード変更はせず、DESIGNv3.md §1.11の記述を実装（暗号化メモM6と同じ「自動保存優先・確認ダイアログなし」方式）に合わせて訂正済み）
  - `M10-markdown-preview.md` — Markdown＋ライブプレビュー。v1 M1/M3/M6に依存、M8/M9とは独立。**未着手。2026-07-26、M9同様に実行コストが大きいためオーケストレーターがM10a/M10b/M10cへ3分割**（依存順: M10a→M10b→M10c必須の直列）:
    - `M10a-markdown-format-core.md` — 保存形式基盤・全文検索反映（`.md`拡張子対応、`memo:convertFormat`、暗号化`format`フィールド）。v1 M1/M3/M6依存、M8/M9とは独立。**✅実装完了**（developer→reviewer(1ラウンド、指摘なし)→tester(実UI検証、コア要件・重点確認項目すべてOK)全工程1ラウンドで合格。tester発見の非ブロッキング事項1件(findMemoFileの`.txt`優先によるconvertFormatの極めて狭い無言成功ケース)は2026-07-26ユーザー判断で「対応不要」と確定、上記「未実装のまま合意で見送った論点」参照）
    - `M10b-markdown-live-preview.md` — 装飾ライブプレビュー描画・サニタイズ・右クリック装飾コマンド。M10a必須。**✅実装完了**。
      - **2026-07-26、designerがノードロック×Markdownのformat伝播設計を確定**（`DESIGNv3.md` §1.13、`PLANv3.md` §7.8、`M10b-markdown-live-preview.md`「0. 前提」節に反映済み）。`NodeLockBlob`/`NodeLockSessionEntry`へ`formatMap`（`nameMap`と対のマップ）を新設する方式、および調査過程で発見した関連ギャップ（M6個別暗号化`crypto:open`のレスポンスにも`format`が無く、暗号化`.md`メモの個別開封時も同様の問題が起きる）も合わせて本前提作業で修正する方針を、designerが提示した推奨案どおりユーザーが確定（AskUserQuestionで2点とも「designer推奨」を選択）。
      - developer→reviewer(1ラウンド、指摘なし。サニタイズ・装飾コマンド・Undo単位・§0のformat伝播すべて記載通りと確認)→tester、全工程合格。
      - **tester1回目(`a2f3382af7a317939`)がスタックし約1時間無応答となる事故が発生**（原因: ネイティブ右クリックコンテキストメニューのCDP合成クリック自動化。副作用として`GetForegroundWindow`/`AppActivate`によるOSデスクトップ全体のフォーカス確認がユーザーの実際のChromeウィンドウタイトルを拾ってしまう事象も発生し、ユーザーへ状況説明・対応方針確認を実施）。developerが原因を特定し、ネイティブ右クリックメニュー自動化を避けCodeMirror DOMへの直接操作(`document.execCommand('insertText', ...)`)に切り替えたtester2回目(`aa125e74e514c806d`)を再起動し完走・合格。**今後、右クリックメニューを伴うUI自動検証を依頼する際は「ネイティブコンテキストメニューのCDP合成クリックは使わずDOM直接操作で代替すること」を明記するのが望ましい**。
      - 重点確認項目(サニタイズ: `<script>`/`onerror`/`onclick`/許可外CSSプロパティすべて除去、ノードロック往復でのformat維持、`crypto:open`のformat、`.txt`誤判定なし)すべてOK。
    - `M10c-markdown-toolbar-ui.md` — ツールバー・ソース/プレビュー切替・画像貼り付け・`.txt`⇔`.md`変換UI。M10a/M10b必須。**未着手**
- **重要な運用上の発見**: このアプリは`--user-data-dir`によるElectron検証環境の隔離が効かない（ポータブル化対応のため）。詳細・回避策はauto memory（`project_tabtreenote_tester_isolation.md`相当）参照。今後tester依頼時は必ず「隔離コピー+位置引数起動」方式を明記すること
- **重要な運用上の発見(2026-07-26追加)**: tester等がネイティブ右クリックコンテキストメニューをCDP合成クリックで自動化しようとすると、Windowsのネイティブメニューがモーダル的に動作しCDPイベントループがブロックされてハングする(M10b tester1回目で発生、約1時間無応答)。右クリックメニュー操作の自動検証は、CodeMirror等のDOM直接操作(`document.execCommand`等)で代替するよう依頼文に明記すること。
- `AGENT_LOG.md`が肥大化したため、v1(PLAN.mdレビュー〜M0〜M7)分を`AGENT_LOG-v1-archive.md`へ分離済み（2026-07-26）。v3作業では`AGENT_LOG.md`のみ参照すれば良い
- 次のアクション: M8/M9a/M9b/M9c/M10a/M10bとも完了済み。M10c(ツールバー・ソース/プレビュー切替・画像貼り付け・変換UI)着手 or コミット等、ユーザーの明示指示を待つ
- **着手時の注意**: `docs/INDEX.md`の「v3マイルストーン別ドキュメント一覧」から該当M{N}のファイルのみを辿り、DESIGNv3.md/PLANv3.mdの全文を読み直すような無駄な読み込みを避けること

## Git/リモート構成

- ローカルgit初期化済み、ブランチ`v3`(v3追加機能の設計・実装計画作業をこのブランチで実施)
- GitHub上に**privateリモート**(`origin`)作成済み: `https://github.com/hachi921082-source/TabTreeNote`
- ライセンス: MIT(著作権者 `hachi921082-source`)
- `.gitignore`: `CatMemoNote/`(第三者フリーソフト本体一式、再配布懸念のため除外)、`node_modules/`、`dist/`等
- コミットは基本的にユーザーの明示指示があった時のみ行う(「役割を記載してコミットして」→commit-with-roleエージェント)
- **2026-07-26時点、未コミットの変更あり**(`git status --short`で確認可能): `AGENT_LOG.md`・`HANDOFF.md`・`docs/INDEX.md`(修正)、`docs/v3/`(新規、`DESIGNv3.md`/`PLANv3.md`/`milestones/M8〜M10c`一式)、`AGENT_LOG-v1-archive.md`(新規)、M8〜M10b実装コード一式(`src/main/crypto/nodeLock.ts`・`nodeLockSessionStore.ts`・`obfuscatedNaming.ts`、`src/renderer/editor/markdownDecorations.ts`・`markdownSanitize.ts`・`decorationCommands.ts`が新規、既存多数ファイルが修正)、`package.json`/`package-lock.json`(M10bで`dompurify`依存を追加)。コミットの要否・粒度はユーザーの明示指示を待つこと

## ドキュメント構成(developer/reviewer/testerが参照する場所)

DESIGN.md/PLAN.mdを土台に、マイルストーンごとに必要な情報だけを参照できるよう`docs/`配下に派生ドキュメントを作成済み(正本はあくまでDESIGN.md/PLAN.md)。

- `docs/INDEX.md`: エントリポイント。マイルストーン一覧と使い方（v1/v3共通で参照）
- `docs/00-core-principles.md`: 横断的共通原則(Result型規約、アトミック書き込み、同期順序、selfWriteRegistry、競合判定2系統、エラー表全体、セキュリティ不変条件等)（v1/v3共通で参照。v3でも必要）
- `docs/data-model.md`: 型定義(メタJSON/アプリ設定JSON/.txtencフォーマット/IPC共通型、コピペ可能な精度で転記済み)（v1/v3共通で参照。v3でも必要）
- `docs/milestones/M0〜M7`: 各マイルストーンのゴール・依存関係・対象IPCチャネル・型・処理フロー・ディレクトリ構成（**v1専用。v3作業では参照不要**）

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

### v3マイルストーン依頼の型(M8〜M10)

v1と同じ型だが、参照先がv3専用ドキュメント(`docs/v3/`配下)になる点が異なる。M8を例に示す(M9/M10は下表の通り差し替え):

```
このリポジトリでのプロジェクトでマイルストーンM8 — (ノードロック基盤)の実装に着手してください
v1のM0〜M7は完了済みの前提です(M8にM9以降のような直接の先行マイルストーンはありません)

【まず読むもの】
1. docs/INDEX.md
2. docs/v3/milestones/M8-node-lock-core.md
3. docs/00-core-principles.md
4. docs/data-model.md

DESIGNv3.md・PLANv3.mdはこの2機能(ノード単位パスワードロック/Markdown＋ライブ
プレビュー)に関する確定済みの正本ですが、上記4ファイルで基本的に着手可能な
構成になっています。全文を読み直す必要はありません。
DESIGN.md・PLAN.md(v1正本)は変更しないでください。また、DESIGN.md・PLAN.md・
docs/milestones/M0〜M7・docs/post-M7-changes.md・AGENT_LOG-v1-archive.mdは
本マイルストーンでは参照不要です(トークン節約のため開かないでください)。
AGENT_LOG.mdに既存の経緯・レビュー指摘が記録されている場合は、それを再度
要約せず「AGENT_LOG.md末尾を読む」ことで経緯を把握してください。

M8完了後は静的レビュー(reviewer)に回せる状態にしてください。
```

M9/M10は「前提行」と「読むもの2.」だけ差し替える:

| M | 前提行 | 読むもの2. |
|---|---|---|
| M9c | 「**M8は完了済みの前提です**(M9a/M9bとは独立)」 | `docs/v3/milestones/M9c-node-lock-tab-switch.md` |
| M10a | 「v1のM0〜M7は完了済みの前提です(M8/M9とは独立のため両方の完了を待つ必要はありません)」 | `docs/v3/milestones/M10a-markdown-format-core.md` |
| M10b | 「**M10aは完了済みの前提です**(M8/M9とは独立)」 | `docs/v3/milestones/M10b-markdown-live-preview.md` |
| M10c | 「**M10a・M10bとも完了済みの前提です**(M8/M9とは独立)」 | `docs/v3/milestones/M10c-markdown-toolbar-ui.md` |

M8→M9a→M9bは依存があるため順序厳守(いずれも完了済み)。M9cはM8のみに依存し独立のため、M9a/M9bと並行してどちらから着手してもよい。M10a→M10b→M10cは依存があるため順序厳守(3件とも未着手)。
コミット・プッシュは行わない旨をv1同様に毎回明記すること。

## 運用方針(利用量節約 — 重要)

ユーザーから明示的な依頼あり。詳細はauto memory([feedback_agent_delegation.md](%USERPROFILE%\.claude\projects\<project-slug>\memory\feedback_agent_delegation.md)相当)にも記録済み:

- **簡単な作業は直接対応**: ファイル1つの軽微な修正・確認・簡単な調査はサブエージェントに投げずオーケストレーター自身が行う
- **レビューサイクルは目安2回で打ち切り**: 2回で収束しない(3回目に入りそうな)場合は自律的にループを継続せず、その時点でユーザーに報告し指示を仰ぐ。強制的にパスさせない
- **トークン節約は「読み込む範囲を絞る」方向で行い、「レビュー/テストの回数を減らす」方向では行わない**（2026-07-26にユーザーから明確化。上記「v3作業時の参照範囲ルール」参照）。実際にM8〜M9bでは複数回の追加ラウンドで重大なセキュリティ上の不具合(データ消失・境界防御の穴等)を発見できており、回数を削ること自体は品質とのトレードオフが大きい。削減対象は依頼文の冗長な転記・不要な文書の読み込みであって、検証の深さではない
- developer/reviewer/testerセッションによっては**Agentツールが使えない**ことがある(実際にM3①②で発生)。その場合developerは自分でreviewer→testerを呼べないため、オーケストレーターが代わりに橋渡しする
- 週間トークン制限が厳しい時期があった(2026-07-23時点で解消傾向)。制限に達すると该当エージェントはAPIエラーで強制終了するが、それまでの成果は残るので、リセット後にSendMessageで再開すればよい(同一agentIdへ送るとtranscriptから再開できる)
- CronCreateによる自動再開スケジュールは**セッション内でのみ有効**(ディスク非保存、セッション終了で消える)。長時間(10時間超)の予約は当てにしすぎないこと
- 「〇時に指示を実行して」等のローカルリポジトリでの時刻指定実行には**CronCreate**を使うこと。**/scheduleスキル(RemoteTrigger)はクラウド上で独立したgit checkoutを使うクラウドエージェント専用**であり、未プッシュの作業ツリーやローカルのdeveloper/reviewer/testerエージェント体制とは噛み合わない(2026-07-23に一度誤って/scheduleを使いかけ、ユーザー確認前に気づいて撤回した経緯あり)
- **ユーザーの明示的な指示なしにサブエージェントを自発的に起動しない**。本ファイルの「次のチャットで最初にすべきこと」は引き継ぎメモであって指示ではない。2026-07-23の3回目のチャットで、この記載を見てM4着手をdeveloperに勝手に依頼してしまい、ユーザーから「指示していないことを勝手に行うのはクーポン節約という目的からもそれている」と指摘され、起動済みエージェントを停止する事態になった(詳細は[[feedback_agent_delegation]]参照)

## 確定した主要設計判断(抜粋。詳細はDESIGN.md §0・§7参照)

- 技術スタック: Electron + TypeScript
- データ形式: メモ=`.txt`(UTF-8)、タブ=フォルダ、メモ識別=ファイル名(UUID不採用)
- v1コア機能: ツリー型タブ管理/編集/検索置換(正規表現・全文検索)/ライト・ダークテーマ/**リンク機能**(URL・メール・ファイル自動認識+`memo:`リンク)/**パスワード暗号化**(AES-256-GCM+scrypt、専用拡張子`.txtenc`) — **M6で実装済み**
- 全文検索: メモリ内軽量インデックス(起動時構築、アプリ内変更は直接反映・外部変更のみファイル監視経由) — **M3で実装済み**
- バックアップ: 保存時に直近1世代の`.bak`を保持(本文/暗号化メモ/メタJSON/アプリ設定すべて対象) — **M1で実装済み**
- タブ名の重複禁止、ファイル名サニタイズ(Windows禁止文字を入力時にブロック) — **M2で実装済み**
- ファイル監視の自己発火除外: 一時ファイルは固定プレフィックスでchokidarの`ignored`により監視除外、アプリ発の操作は予約テーブルで自己発火除外 — **M4で実装済み**
- タスクトレイ常駐・AutoReName(1行目からの自動リネーム)・設定画面・スキーマ移行の足場 — **M7で実装済み**
- 既知の制限としてWindows長パス(260文字超)は v1 非対応
- 暗号化状態の真実源は拡張子`.txtenc`(メタJSONには暗号フラグを冗長に持たせない。PLAN.md精緻化時にDESIGN.md §2.9の字面もこれに合わせて修正済み)
- `AppSettings.sessionRememberPassword`(パスワードのセッション記憶)は設計上の項目としては存在したが、実装が「開いている間だけ鍵をメモリ保持」というM6のセキュリティ方針と衝突するため、M7完了時にユーザー判断でUI・型定義から削除(実装しない方針で確定)

## 未実装のまま合意で見送った論点

- メタJSONが「正常だが1件だけ参照ファイルが無い」場合の部分修復(現状は復旧カスケードで全体をフラット再生成する仕様のまま。ユーザーの判断で「しない」と確定 — 対応不要)
- PLAN.md §8に、リネーム中/暗号化変換中の外部変更競合を「受容済みリスク」として記録(項目6・7。v1では追加の検出機構を実装しない)
- M10a tester発見: `findMemoFile`(`src/main/fs/memoFileService.ts`)が同名`.txt`/`.md`共存時に`.txt`を優先するため、アプリ外で意図的にX.txt/X.mdを共存させた場合に限り`memo:convertFormat`が無言で成功扱い(実際は無変換)になる。2026-07-26、ユーザー判断で「対応不要」と確定(アプリ操作のみでは構造的に到達不能な外部改変シナリオのため、他の外部変更競合系の見送り論点と同種のリスクとして受容)

## ファイル構成

- [spec.md](spec.md): 空(CatMemoNote紹介記事URLが入っていたためユーザーが削除)
- [CLAUDE.md](CLAUDE.md): 4エージェント体制のワークフロー定義
- [DESIGN.md](DESIGN.md): 確定済み設計ドキュメント(本体)。**v1専用、v3作業では参照不要**
- [PLAN.md](PLAN.md): 実装計画(4回のレビューで精緻化済み、正本)。**v1専用、v3作業では参照不要**
- `docs/`: マイルストーン別参照ドキュメント(上記参照)。`docs/v3/`にv3(ノードロック/Markdown)専用の`DESIGNv3.md`/`PLANv3.md`/`milestones/M8〜M10`一式
- `src/`: 実装コード(M0〜M7、全マイルストーン完了分。v3はM8/M9a/M9b/M9c/M10a/M10bまで実装済み、M10cは未着手)
- `CatMemoNote/`: 実際に配布されているCatMemoNote本体一式(調査済み、readme.txtはShift-JIS。**gitignore対象、リモートに上げない**)
- `AGENT_LOG.md`: 各エージェントの作業ログ(コミット対象外)。v3(M8以降)のみ。v1(PLAN.mdレビュー〜M0〜M7)分は`AGENT_LOG-v1-archive.md`へ分離済み(2026-07-26、肥大化対策)
- 本ファイル([HANDOFF.md](HANDOFF.md)): 引き継ぎメモ
