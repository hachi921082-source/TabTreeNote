# post-M7-changes.md — M7完成後のバグ修正・仕様変更ログ

> M0〜M7のマイルストーン完成後、実機での動作確認を通じてユーザーから報告されたバグ修正と、
> 追加で依頼された仕様変更・新機能をまとめた記録。正式なマイルストーン計画（PLAN.md/DESIGN.md）
> を経由せず、チャットでの対話を通じて都度実装したもの。個々の変更理由・判断根拠は該当ファイルの
> コード内コメント（「ユーザー要望」「developer 判断」等）にも残している。

## バグ修正

| 内容 | 対応箇所 |
|---|---|
| `window.prompt()` はElectronレンダラーで機能せず、「📂+フォルダ登録」「＋新規タブ作成」ボタンが無反応だった | ネイティブのフォルダ選択ダイアログ（`dialog:pickFolder`）に置換。[dialogHandlers.ts](../src/main/ipc/dialogHandlers.ts) |
| タブに登録したフォルダを外部（エクスプローラー等）から削除すると、次回起動時に例外が握りつぶされずアプリごと起動しなくなっていた | `scanTabFolder`がフォルダ不在時に例外を投げず空配列を返すよう修正。[memoFileService.ts](../src/main/fs/memoFileService.ts) |
| アプリ設定JSONが壊れて復旧/再生成された場合、ユーザーに一切通知されなかった（メタJSON復旧の通知は既にあったのに設定側だけ抜けていた） | `evt:metaRecovered`を流用して通知するよう[index.ts](../src/main/index.ts)の`bootstrap()`を修正 |
| テキスト選択時の背景色が「カーソル行ハイライト」と同じCSS変数を共有しており、選択範囲が見分けられなかった（ライト/ダーク両方） | 選択専用の`--color-selection`変数を新設。[theme.css](../src/renderer/theme/theme.css) |
| 「チェック」メニューで☐を追加しても、絵文字自体はただの文字でクリックしても状態が変わらなかった | 本文中の☐/☑を直接クリックでトグルする拡張を追加。[checkboxClick.ts](../src/renderer/editor/checkboxClick.ts) |
| ポータブル配布exeの起動が毎回遅い（自己展開形式が原因と判明。`win-unpacked`直接実行では高速） | 原因特定のみ。対処（zip/dir配布への変更）は保留中 |
| 複数コピー（フォルダA/B）を別プロファイルとして使おうとすると、設定共有＋多重起動ロックにより意図通り動かなかった | 「仕様変更・新機能」の「設定のポータブル化」で対応 |
| 前後に空白を含む名前の`.txt`/`.txtenc`（アプリ外で作成された等）が既に存在すると、開く/保存する/移動する/複製する/リンクから辿る等の操作が軒並み`NAME_INVALID`で失敗し、データを読み込めなかった。同様にフォルダ名の前後に空白がある既存フォルダはタブとして登録できなかった | `validateName`（新規命名時の厳格な検証。前後空白・末尾ピリオド禁止）とは別に、既存の実体を解決するためだけの緩い検証`validateExistingName`/`validateExistingMemoNameForPath`を新設。読込・保存・プロパティ取得・複製先名・移動先/コピー先・リンク解決・既存フォルダ登録はこちらを使うよう変更し、新規作成（`memo:create`/リネーム先/タブ新規作成）は従来通り厳格な検証のまま維持。[pathSafety.ts](../src/main/fs/pathSafety.ts) / [memoFileService.ts](../src/main/fs/memoFileService.ts) / [cryptoHandlers.ts](../src/main/ipc/cryptoHandlers.ts) / [linkHandlers.ts](../src/main/ipc/linkHandlers.ts) / [tabService.ts](../src/main/fs/tabService.ts) |
| ダークモードで右ペイン（エディタ）のカーソルが背景に埋もれて全く見えなかった（CodeMirror既定の黒カーソル色が未設定のまま） | カーソル色をテーマの文字色変数`--color-text`に連動させる`EditorView.theme`を追加（CSS変数参照のためテーマ切替時のJS再設定は不要）。[codeMirrorSetup.ts](../src/renderer/editor/codeMirrorSetup.ts) |
| 平文メモ編集後、保存前に別のメモへ切り替えようとして出る「未保存の変更があります。破棄して別のメモを開きますか？」の確認でキャンセルすると、以降しばらく右ペインに文字入力ができなくなることがあった | 原因はこの確認だけが唯一`window.confirm()`（OSネイティブのブロッキングモーダル）を使っており、表示中にレンダラーのJSスレッド/IME合成状態が同期停止し、キャンセル後にIME入力状態が宙に浮くこと（他の確認ダイアログは既に自作の非ブロッキング`ConfirmDialog`に統一済みだった）。`requestCloseCurrentMemo`をこの自作`ConfirmDialog`経由に変更し、表示中に切替要求が重ねて来ても二重に出さないガード（`pendingDiscardConfirmRef`）を追加。[App.tsx](../src/renderer/App.tsx) |

## 仕様変更・新機能

### ポータブル性関連
- 新規タブ作成時のデフォルト保存先を、ダイアログでの手動選択から**exe直下の`data`フォルダ自動作成**に変更（`parentDir`省略可に）。[appDataRoot.ts](../src/main/fs/appDataRoot.ts) / [tabService.ts](../src/main/fs/tabService.ts)
- **アプリ設定（`app-settings.json`）の保存先もexe直下の`config`フォルダへ変更**。exeコピーごとに設定・タブ登録・多重起動ロックが完全に独立したプロファイルになる。旧`%APPDATA%\tabtreenote`に既存設定があれば初回のみ自動移行（コピー、削除はしない）。[index.ts](../src/main/index.ts)の`migrateLegacySettingsIfNeeded()`
- ビルド後の起動が速い`dev.bat`をリポジトリ直下に追加（`ELECTRON_RUN_AS_NODE`環境変数の影響を回避）

### 多重起動防止
- `app.requestSingleInstanceLock()`を追加。2つ目の起動は既存ウィンドウをフォーカスするだけにし、同一設定ファイルへの同時書き込み事故を防止。[index.ts](../src/main/index.ts)

### 起動の高速化（Windowsログイン時自動起動）
- ポータブル版exeの起動が毎回遅い問題（自己展開が原因）への実用的な回避策として、**Windowsログイン時にトレイへ隠れた状態で自動起動**する設定を追加（設定画面「起動」セクション）。ログイン時に1回だけ裏で起動しておき、以降はトレイアイコンから即座に開く運用。`app.setLoginItemSettings()`使用。ポータブル版は`process.execPath`が毎回`%TEMP%`の使い捨て展開先を指すため、electron-builderが設定する`PORTABLE_EXECUTABLE_FILE`（実体の元exeパス）を優先して登録する。[appDataRoot.ts](../src/main/fs/appDataRoot.ts)の`loginItemExecPath()` / [windowHandlers.ts](../src/main/ipc/windowHandlers.ts)

### ツリー（左ペイン）
- **F2キーでリネーム**（単一選択時）。[Tree.tsx](../src/renderer/components/Tree/Tree.tsx)
- **↑/↓キーでスクロールではなく前後のメモへ移動**（選択+オープンまで実施）。仮想化リストのため、選択位置が表示範囲外に出る場合は自動でスクロール位置を補正する
- **編集ロック**機能を追加（本文編集のみ禁止。リネーム/削除等ファイル操作は対象外）。`MetaTreeNode.locked`フィールド新設、ツリーに🔏アイコン表示。`App.tsx`の`handleRequestToggleLock`
- 右クリックメニューを整理: 「前に追加/後に追加/子として追加」→「メモを作成」（常に後ろに追加）に統一、「ラベル」5項目→「アイコン」サブメニューに統合、「複製」を削除
- ファイルアイコンを絵文字（📄/🔒）からインラインSVGへ変更し、ラベル色をアイコン自体に反映できるように（`ContextMenu`にフライアウトサブメニュー機能も追加）。[FileIcon.tsx](../src/renderer/components/Tree/FileIcon.tsx)
- 「プロパティ」を追加（ファイル情報+文字数カウント。暗号化メモはファイル情報のみ）。[PropertiesDialog.tsx](../src/renderer/components/dialogs/PropertiesDialog.tsx)
- **AutoReName（本文1行目を自動でメモ名にする機能）を廃止**（常にONで無効化する手段が無かったため, ユーザー要望）。`editor/autoRename.ts`を削除し、`App.tsx`内の関連コードも全て除去
- 新規メモ作成時の名前入力ダイアログを廃止し、**「新しいメモ」「新しいメモ(1)」…の形で即作成**、作成後そのメモを自動的に開く（リネームしなければそのままの名前を維持）。`generateDefaultMemoName()`
- ツリー下部の**「先頭に追加」「末尾に追加」ボタンを廃止**。新規メモ作成は左ペインの右クリックのみに統一（行の無い空白部分を右クリックした場合も「メモを作成」を出し、空タブでも作成できるようにした）
- **ツリーが空（メモが1件も無い）時のみ**、中央に「メモを作成」ボタンを表示（1件でもあれば非表示に戻る）
- 開いているメモが変わったとき（起動時の前回メモ復元・`memo:`リンク遷移など）、**ツリー側の選択状態とスクロール位置も自動的に追従**するように統一
- **↑/↓キーでの連続移動中、フォーカスが右ペイン（エディタ）へ奪われないように修正**（ユーザー報告バグ）。従来は移動のたびにエディタが自動フォーカスされ、続けて↑/↓を押すには毎回ツリーをクリックし直す必要があった。クリックでの通常オープン時は従来通りエディタへフォーカスするが、矢印キーでの移動時のみフォーカスをツリー側に残す。`onOpenMemo`に省略可能な`focusEditor`引数を追加し、`App.tsx`の`editorAutoFocus` stateで`CodeMirrorEditor`の`autoFocus`propを都度制御（1回限りの指示のため、消費後は既定値trueへ自動的に戻す）。[Tree.tsx](../src/renderer/components/Tree/Tree.tsx) / [App.tsx](../src/renderer/App.tsx)

### タブバー
- 検索ボタン左に**「最前面に固定」ボタン**（📌）を追加。セッション内のみ（設定への永続化なし）。[windowHandlers.ts](../src/main/ipc/windowHandlers.ts)
- 上部タブの右クリックメニューに**「タブの場所を開く」**を追加。登録フォルダをエクスプローラで開く（`tab:openFolder`, `shell.openPath`）。[tabHandlers.ts](../src/main/ipc/tabHandlers.ts) / [TabBar.tsx](../src/renderer/components/TabBar/TabBar.tsx)

### エディタ（右ペイン）右クリックメニュー
- 標準編集の残り（元に戻す/やり直し/削除）をCodeMirrorのUndo履歴/選択範囲API経由で追加（ネイティブroleは使わず、CodeMirror内部状態と同期させる）
- 「変換」サブメニュー: 大文字/小文字の反転・大文字化・小文字化・ひらがな化・カタカナ化・半角化・全角化（英数字記号のみ）・タブ⇄スペース変換
- 「チェック」: 行頭への☐/☑巡回挿入（なし→☐→☑→なし）
- 「書式」サブメニュー: 折り返し3種の直接切替・行番号表示切替・空白/改行表示切替・フォントサイズ拡大/縮小/リセット（既存設定と連動）
- 「Google で検索」（選択テキスト）
- 「プロパティ」（ツリー右クリックと共通）
- 実装は[textCommands.ts](../src/renderer/editor/textCommands.ts) + `evt:editorMenuCommand`（main→レンダラ一方向通知）

### 起動時の挙動
- **前回開いていたメモを起動時に自動で開く**（`AppSettings.lastOpened`）。タブ/メモが削除済みなら何もしない
- リンクの既定クリック方式を`ctrlClick`→`singleClick`、確認ダイアログを既定OFFに変更（ユーザー要望）

### UI全般
- **UI文字サイズ設定**（`uiFontScale`, 80〜150%）を追加。エディタ本文以外（タブ・ツリー・ボタン・設定画面等）の文字サイズを一括調整。設定画面「外観」セクション
- ダイアログ（名前入力/確認/パスワード/設定画面等）を**Escキーでキャンセル**できるように（`Modal.tsx`に集約）。「外部変更との競合」ダイアログのみ意図的にEsc無効のまま
- 設定画面の項目名に残っていた内部向けの「（DESIGN §2.7）」「（DESIGN §2.8）」表記を削除（ユーザー向け画面に開発用の参照番号が出ていたため）

## 未対応・見送りとした項目
- 起動時にIME日本語入力を自動で有効にする: Chromium/Electron標準では不可能。Windows IMM32/TSFを叩くネイティブアドオンが必要でポータブル配布と相性が悪いため見送り
- ポータブルexeの起動の遅さ（自己展開が原因と判明）: zip/dir配布への変更で解決可能だが、配布サイズ増（72MB→約108MB）とのトレードオフで結論保留
- チェック文字数カウントの半角/全角内訳・文字コード別バイト数表示（プロパティ画面）: 実装コスト優先で見送り、ファイル属性表示も同様に見送り
