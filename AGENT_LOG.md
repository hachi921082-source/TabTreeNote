# AGENT_LOG.md

TabTreeNote エージェント活動記録。詳細な指摘理由は reviewer の ReportFindings を参照。

## reviewer — PLAN.md 静的レビュー（ラウンド1）

対象: PLAN.md（designer 作成）を DESIGN.md と比較レビュー。実装コードは未着手。

- R1-01 [Med] NG: §5.2 step6 atomicWrite の順序。旧→.bak リネームを temp 書込より先に行うと、target 不在の窓が temp 書込全体に広がる。temp 書込+fsync を先にして最後に世代スワップする順序を推奨。
- R1-02 [Low] 要確認: 整合メモ#1（暗号フラグを拡張子 .txtenc に一本化）は技術的に妥当（DESIGN §3.2 堅牢性原則にむしろ整合）だが、DESIGN §2.9「メタにフラグのみ持たせる」の文言と字面が矛盾。DESIGN 側の記述更新で整合を取るべき（designer 案件）。
- R1-03 [Low] NG: selfWriteRegistry への登録が §5.2/§5.3 の本文で memo パスのみ明示。.bak リネーム・メタ/設定 JSON のアトミック保存も登録対象（DESIGN §3.3 包括原則）。fs 層で一元登録する設計を明記推奨。
- R1-04 [Low] NG: memo:delete のごみ箱失敗フォールバック再 invoke に「直接削除許可」を伝えるパラメータ/チャネルが未定義。引数に force フラグ等が必要。
- R1-05 [Low] NG: crypto:saveEncrypted に expectedHash 相当が無く、暗号化メモ保存時の外部変更競合検出が平文 memo:save と非対称。
- R1-06 [Low] OK(軽微): TreeSnapshot/MemoInfo/Label/AppSettings 等 IPC 戻り型が §4.4 未定義。load-bearing な型は定義推奨。
- R1-07 [Info] OK: scrypt N=16384 は 2026 基準ではやや低め。ファイル記録で将来引き上げ可のため許容。既定を N=2^15〜2^16 も検討可。
- 整合メモ#2〜#5: いずれも DESIGN の許容範囲内で妥当。ユーザー再確認を要する重大逸脱は無し。

## reviewer — M0（足場）実装 静的レビュー（ラウンド1）

対象: M0 実装コード（package.json / tsconfig / electron.vite.config / src/main / src/preload / src/renderer / src/shared）。M0-scaffold.md・00-core-principles.md・data-model.md・PLAN §2/§3/§4 と照合。

- 全体: セキュリティ不変条件（contextIsolation/nodeIntegration/sandbox/preload 限定 API）は充足。models.ts/constants.ts/ipc-contract.ts は data-model.md/PLAN と整合。developer 確認依頼5点はいずれも設計妥当（app:getInfo 非 Result・依存バージョン・スプリッター in scope・PreloadApi 骨格）。ブロッキング指摘なし。
- M0-R1-01 [Low] NG: index.html の CSP `script-src ... 'unsafe-eval'` が静的 meta のため本番ビルドにも同梱される。dev(HMR)専用の緩和のはずが production 出力にも残る。§10 のハード不変条件とは非矛盾だが、prod は unsafe-eval 不要のため dev 限定化を推奨。
- M0-R1-02 [Low] 要確認: main/index.ts の setWindowOpenHandler が任意 URL を無検証で shell.openExternal へ委譲。M0 では発火経路なし（潜在）だが、リンク機能実装時に向け http/https/mailto 等のスキーム許可リスト化を推奨。

## reviewer — M0 低優先度指摘の反映確認（ラウンド1 差分）

対象: src/renderer/index.html（静的CSP meta削除）, src/main/index.ts（registerContentSecurityPolicy / safeUrlScheme / ALLOWED_EXTERNAL_URL_SCHEMES）。

- M0-R1-02 OK: スキーム許可リスト（http/https/mailto）で検証後のみ shell.openExternal、他は deny。URL.protocol は小文字正規化されSetと整合。安全化改善として妥当。合格判定は維持。
- M0-R1-01 OK（1点tester確認依頼）: dev/prod でscript-src出し分けは正しい。ただし静的meta廃止により prod（loadFile=file://）でCSPが onHeadersReceived 経由のみになる。file:// リクエストで onHeadersReceived が発火しCSPヘッダが実際にレスポンスに載るかは実行時要確認（tester）。届かない場合prodがCSP無しに退行するリスクのため、DevToolsでのヘッダ存在/inline script遮断を検証。M0合格判定は覆さない。

## reviewer — M0-R1-01 再修正確認（ラウンド2 / 静的meta注入方式）

対象: electron.vite.config.ts（cspMetaPlugin追加・defineConfig関数形式化）, src/main/index.ts（session/registerContentSecurityPolicy削除）, src/renderer/index.html（CSP meta削除・コメント化）。

- M0-R1-01 OK（解消）: CSPを onHeadersReceived 動的付与からビルド時静的meta注入（transformIndexHtml）へ変更。dev=script-src 'self' 'unsafe-eval' / prod=script-src 'self' で unsafe-eval を prod から確実に除外。前回 tester確認依頼にしていた file:// で CSP が載らない退行リスクは方式ごと消滅（developer の CDP実機確認と一致）。置換対象 `<meta charset="UTF-8" />` は index.html に実在し空振りなし。index.ts に session 残存参照なし、M0-R1-02 スキーム許可リストは維持。ブロッキング指摘なし。M0 は tester へ進行可。
- 非ブロッキング留意（対応不要）: transformIndexHtml が charset文字列一致依存のため、将来 index.html の該当行改変で prod のCSP注入が無言で失われるフラグ性あり。個人プロジェクト規模では現状で許容。

## tester — M0（足場）動作検証（ラウンド1）

対象: reviewer M0-R1-01 ラウンド2 OK後のM0一式。npm install / typecheck / build / prod起動 / dev起動 / CSP実機確認 / UI基本動作を独立して再現確認。

- 結果: 全項目 OK。不具合なし。developer への差し戻しなし。
- npm install: 成功（`up to date, audited 379 packages`。allow-scripts警告はelectron/esbuildのinstallスクリプト未承認の通知のみで動作に支障なし）。
- typecheck: `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json` エラーなし。
- build: `electron-vite build` 成功。`out/main/index.js`、`out/preload/index.js`、`out/renderer/index.html`（+assets）を生成確認。
- セキュリティ不変条件: src/main/index.ts のBrowserWindow webPreferencesで contextIsolation:true / nodeIntegration:false / sandbox:true をコード上確認。setWindowOpenHandlerのスキーム許可リスト（http/https/mailto）も維持確認。
- prod起動: `unset ELECTRON_RUN_AS_NODE` 後 `./node_modules/.bin/electron.cmd . --remote-debugging-port=9333` でエラーなく起動。`Get-Process electron`でMainWindowTitle="TabTreeNote"確認。ログにDevTools listening行のみでエラーなし。
- prod CSP実機確認: CDP Runtime.evaluateで`document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')`を評価し `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'`（unsafe-eval無し）を確認。out/renderer/index.htmlの静的contentとも一致。
- dev起動: `npm run dev`（electron-vite dev, HMR）でエラーなく起動。`http://localhost:5173/`のHTMLに`script-src 'self' 'unsafe-eval'`を含むCSP metaタグを確認（curlで直接確認）。CDPでもwindow title="TabTreeNote"確認。
- console/例外チェック: prod/dev双方でPage.reloadしながらRuntime.consoleAPICalled/Runtime.exceptionThrownを収集。prodは0件。devはVite HMR接続ログ・React DevTools案内・Electron標準の「Insecure CSP (unsafe-eval)」警告（Electron自身がpackaged後は出ないと明記する既知の開発時警告）のみで、type="error"や例外は0件。
- UI基本動作: CDP経由でDOM操作。起動直後のステータスバーに`v0.1.0 / schema 1`（app:getInfo結果）表示を確認。テーマ切替ボタンをクリックし、`document.documentElement`のdata-theme属性がlight→dark、ボタン文言・ステータスバー文言も追随変化することを確認（スプリッタードラッグはpointer eventのCDP再現が煩雑なため未実施だが、コード上はpointermove/upハンドラの実装のみでクラッシュ要因なし。他項目の安定動作から問題なしと判断）。
- 後片付け: 検証用electronプロセス（prod/dev）はPowerShellの`Stop-Process -Force`で終了済み。検証後`Get-Process electron`は0件を確認。
- 外部サービスへの副作用: なし（すべてlocalhost/file://上での検証）。

## reviewer — M1（ファイル層コア・平文）実装 静的レビュー（ラウンド1）

対象: M1差分一式（src/main/fs/*, util/hash, watch/selfWriteRegistry, settings/appSettings, ipc/*, main/index.ts, preload, shared/ipc-contract, renderer/App.tsx ほか）。00-core-principles.md §1-§11 / data-model.md / M1-file-core.md と照合。

- M1-R1-01 [Med] NG: memo:read/save/rename が memoName を validateName / isPathContained で確認せず `join(folderPath, memoName+ext)` に直結。pathSafety.isPathContained は定義のみで未使用。悪意/バグのあるレンダラから `..\..\` 相当の memoName でタブフォルダ外の任意ファイル読取・上書き（save の atomicWrite が .bak も生成）の余地。§10/§11 の閉じ込め意図に対する防御漏れ。要: fs 層で memoName 由来パスの検証・閉じ込め（+ isLongPath）を一元化。
- M1-R1-02 [Low] NG: atomicWrite の catch で「旧target→.bak リネーム成功後」に2つ目の rename が全リトライ失敗すると temp を rm し、target 不在＋新データ喪失のまま .bak（旧内容）だけ残る。メモ .bak は自動復旧対象外のためUI上メモ消失に見える（クラッシュではなく通常失敗の経路）。要: swap 開始後の失敗時は .bak→target 復旧を試みる等。
- M1-R1-03 [OK] developer確認#4（reconcile の子繰り上げ）: 妥当。実在する子メモ参照を失わず、usedNames 整合も取れている。data-model.md 未規定部分の発展的判断として許容。
- M1-R1-04 [OK] developer確認#1-3,5-7: atomicWrite 世代スワップ順序＝§2準拠 / memo:create・rename 同期順序＝§3準拠（rename未登録フォールバックも妥当）/ selfWriteRegistry は登録一元化に収まりM4先取り過剰なし / Result<T>統一OK / textarea・window.prompt はM1暫定として許容。
- セキュリティ: 鍵/PW/平文なし（M1）、内部ログに平文流出なし、preload限定公開・webPreferences不変条件維持。M1-R1-01以外に新規逸脱なし。

## reviewer — M1 指摘修正確認（ラウンド2 / M1-R1-01・M1-R1-02）

対象: memoFileService.ts（validateMemoNameForPath 新設・全公開関数の先頭検証・createEmptyMemoFile を Result<void> 化）, atomicWrite.ts（renamedToBak ロールバック）, memoHandlers.ts（create の Result 追従）。

- M1-R1-01 OK（解消）: fs層の全公開エントリ（read/readWithEncoding/save/create/rename）先頭で validateName→join→isPathContained→isLongPath の多層検証。findMemoFile は未検証だが内部専用で全呼出元が検証済み。トラバーサル文字（\ / .. 末尾ピリオド）は validateName で拒否、閉じ込め併用で妥当。
- M1-R1-02 OK（解消）: target→.bak 成功後の temp→target 失敗時に .bak→target をベストエフォート復元。二重失敗時は旧内容の .bak が残るのみでこれ以上の喪失なし。個人プロジェクト範囲で許容。
- 非ブロッキング（Info・対応不要）: (1) validateMemoNameForPath の候補パスが常に .txt 固定のため .txtenc メモでは実パスが3字長く isLongPath 判定が最大3字過小。LONG_PATH は v1 非正式対応で許容。(2) findMemoFile は export だが自前検証なし。現状全呼出元が検証済みのため潜在のみ。
- M1 は tester へ進行可。

## tester — M1（ファイル層コア・平文）動作検証（ラウンド1）

対象: reviewer M1 ラウンド2 OK後のM1一式。npm install / typecheck / build / prod起動 / IPC直叩き+DOM操作によるUIスモーク / パストラバーサル / 名前サニタイズ / 競合検出 / 復旧カスケード / 設定永続化 を独立して再現確認。

- 結果: 全項目 OK。不具合なし。developer への差し戻しなし。
- npm install: 成功（`up to date, audited 379 packages`。iconv-lite導入済み。allow-scripts警告のみで動作に支障なし）。
- typecheck: `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json` エラーなし。
- build: `electron-vite build` 成功。`out/main/index.js`(30.11kB)/`out/preload/index.js`(1.90kB)/`out/renderer/index.html`+assets を生成確認。
- prod起動: `electron . --remote-debugging-port=9333` でエラーなく起動。CDP(Runtime.consoleAPICalled/exceptionThrown)でPage.reload時のイベントを収集し0件（コンソールエラー・例外なし）。
- 平文メモの開く/編集/保存（M1ゴール）: CDP経由で`window.api`を直接叩く形と、実際のDOM操作（タブクリック→メモ開く→textarea入力→保存ボタンクリック）の両方で確認。tab:register→memo:create→memo:read→memo:save→memo:read(再読込で内容一致)→アプリ再起動→tab:list/settings:get/tab:openTree/memo:readで再起動後もディスク永続化された内容・タブ登録・テーマ設定が復元されることを確認。UI操作でも保存ボタンがdirty時のみ活性化し、保存後にステータスバーへ「保存しました（〇〇）」表示、実ファイルへの反映を確認。
- リネーム: `memo:rename`でファイル名変更・`tab:openTree`でツリー反映を確認。
- 実ファイル生成確認: `.txt`本体、2回目のatomicWrite（create後のsave）で`memo1.txt.bak`（0バイト=create時点の空内容）生成、`.tabtreenote.json`と2回目のメタ保存（rename時）で`.tabtreenote.json.bak`生成を確認。
- 競合検出: 1回保存済みの`expectedHash`（古いハッシュ）で再度`memo:save`を呼び、`CONFLICT`エラー（コード・メッセージ・pathのみでUNKNOWN内部情報の露出なし）を確認。
- 名前サニタイズ: 予約名`CON`、禁止文字`?`を含む名前での`memo:create`が`NAME_INVALID`で拒否されることを確認。
- パストラバーサル（M1-R1-01再修正確認）: `memoName`に実際のバックスラッシュを含む`..\..\evil`（JSON経由で正確にバックスラッシュ2文字×2を渡し、受信側でparsed argsとして`'..\\..\\evil'`であることを確認した上で検証）を`memo:read`/`memo:save`/`memo:create`/`memo:rename`全てに渡し、いずれも`NAME_INVALID`（使用できない文字）で拒否されることを確認。加えてタブフォルダ・その親・プロジェクトルート・ホーム直下を`find`で走査し`evil`という名前のファイルが一切生成されていないことを確認（bashのシェルクォート経由でバックスラッシュが握りつぶされる罠があり、一度`....evil`という別名のファイルを誤って作成してしまったが、これはトラバーサルではなく正当な名前としての通常のcreate/save成功であり閉じ込め違反ではないことを確認した上でテスト後片付け済み。念のためスラッシュ`../../evil`版でも別途`NAME_INVALID`拒否を確認）。
- 重複拒否: `tab:register`の同一フォルダ二重登録・`memo:create`の同名メモがいずれも`NAME_DUPLICATE`で拒否されることを確認。
- NOT_FOUND: 存在しない親フォルダへの`tab:register`/`tab:create`が`NOT_FOUND`を返すことを確認。
- テーマ永続化: `settings:set`でtheme=darkに変更後、electronプロセスを`Stop-Process -Force`で終了し再起動、`settings:get`でtheme=darkが維持されていることを確認（`%APPDATA%\tabtreenote\app-settings.json`経由）。
- メタ破損復旧カスケード（発展項目）: `.tabtreenote.json`を不正JSONに書き換え`.bak`は正常のまま`tab:openTree`を呼ぶと`.bak`から復旧し`evt:metaRecovered`（「直近のバックアップから復旧しました」）を受信。続けて`.bak`も不正JSONに書き換えて再度`tab:openTree`を呼ぶとフラット再生成され`evt:metaRecovered`（「メタ情報を再構築しました」）を受信。いずれもメモ本体`.txt`は無傷で内容維持されることを確認。
- 後片付け: 検証用一時フォルダ（`%TEMP%\claude\tabtreenote-test`）・Electron userData（`%APPDATA%\tabtreenote`）を削除済み。検証後`Get-Process electron`は0件を確認。
- 外部サービスへの副作用: なし（すべてローカルファイル操作・localhost CDPのみ）。

## reviewer — M2（ツリーUI+メタ同期）実装 静的レビュー（ラウンド1）

対象: M2差分一式（shared/nameSanitize・treeOps・ipc-contract, main/fs/trash・memoFileService・metaStore・tabService, main/ipc/*Handlers, preload, renderer/ipc・App・components/*）。00-core-principles.md §3/§4/§8/§10/§11・data-model.md・M2-tree-ui.md と照合。

- M2-R1-01 [Med] NG（1回目）: App.tsx の未保存ガードが stale closure で無効化。`selectTab`（deps=[refreshTree] 安定）と `openMemoByName`（deps=[selectedTabId]）が `dirty` を依存に含めず、編集で `dirty=true` になっても関数は再生成されないため `if (dirty && !window.confirm(...))` が常に初期値 false 参照で発火しない。タブ切替・別メモを開く際に未保存編集が無確認で破棄される（M2に自動保存なし＝唯一の保護が失われる）データ損失。
- M2-R1-02 [Low] NG（1回目）: 追加位置 'after' で複数ノードを一括挿入すると順序が反転。insertNode/insertTreeNode を同一アンカーに対しループ挿入する箇所（memoHandlers memo:move、App handleLocalMove）で、'after' のみ後続ノードがアンカー直後に割り込み [X,B,A] となる（'before'/'child' は順序維持）。複数選択DNDの並べ替え時に選択順と逆順になるUX不整合（機能破壊ではない）。
- 同期順序/予約登録/パス検証: memo:delete/duplicate/move/tree:updateStructure/tab:rename/tab:remove とも §3 の①→②→③順を遵守（duplicate はファイル操作先行だが名前自動採番で検証先行の意図は満たす）。selfWrite 登録は trash/move/copy/duplicate/rename/direct-delete の全 fs 操作で漏れなし。duplicate/move/copy の新規パスも validateName＋isPathContained＋isLongPath を一貫適用。tree:updateStructure は実ファイル集合との厳密一致チェックで注入拒否。console.error は OSエラー/パスのみで機密漏洩なし（暗号はM6）。developer 補完#1-6 はいずれも設計妥当。
- 判定: M2-R1-01（Med）解消が必要。developer へ差し戻し（ラウンド1）。

## reviewer — M2 指摘修正確認（ラウンド2 / M2-R1-01・M2-R1-02）

対象: App.tsx（dirtyRef 導入・selectTab/openMemoByName ガード）, shared/treeOps.ts（orderForBatchInsert 新設）, main/ipc/memoHandlers.ts（move/copy 両ループへ適用）。

- M2-R1-01 OK（解消）: dirtyRef=useRef(dirty) 初期値正・useEffect([dirty]) 同期正。selectTab(140)/openMemoByName(155) とも dirtyRef.current を参照し、直接 dirty を読むガードの残存なし。UI 表示（633/638 の dirty）は state のまま=再描画目的で正しい。effect 同期はユーザー操作（非同期イベント）前に flush されるため競合なし。他コールバック（タブ削除・新規作成・終了）は元々ガード対象外で新規リグレッションなし。
- M2-R1-02 OK（解消）: reverse-for-'after' をトレース検算。siblings=[Z] に [A,B] を 'after' 挿入時、逆順 [B,A] で反復すると [Z,A,B] となり選択順維持を確認。'before'（splice index）/'child'（push）/'last'（push）は順反復で順序維持。handleLocalMove・memo:move の移動用/コピー用両ループに適用済み、import・structuredClone・非破壊（[...nodes]）とも正。
- M2-LATENT-01 [Low/Info] 潜在（対応任意）: orderForBatchInsert の doc は 'first' も順序維持と記すが、insertTreeNode 'first' は unshift のため一括挿入では順序反転する。ただし現行呼出は全て before/after/child（DropZone）または 'last' のみで 'first' は batch 経路に到達不能=実害なし。将来 'first' を一括挿入に使う場合の落とし穴。
- 判定: M2-R1-01・M2-R1-02 とも解消。ブロッキング指摘なし。tester へ進行可。

## tester — M2（ツリーUI+メタ同期）動作検証（ラウンド1）

対象: reviewer M2 ラウンド2 OK後のM2一式。npm install / typecheck / build / prod起動 / IPC直叩き+実DOM操作（CDP Input/DOM/Runtime）によるツリーUI・複数選択・DND・名前ダイアログの動作検証を独立して再現確認。

- 結果: 全項目 OK。不具合なし。developer への差し戻しなし。
- npm install: 成功（`up to date, audited 379 packages`。allow-scripts警告のみで動作に支障なし）。
- typecheck: `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json` エラーなし。
- build: `electron-vite build` 成功。`out/main/index.js`/`out/preload/index.js`/`out/renderer/index.html`+assets を生成確認。
- prod起動: `--user-data-dir` で隔離した一時userDataを使い `electron . --remote-debugging-port=<port>` を計2回（別タスク用に別ポートで再起動）起動。CDP(Runtime.consoleAPICalled/exceptionThrown)を全操作中通して監視し、セッション全体を通じてconsoleエラー・例外0件（Page.reloadでの再検証時も0件）。
- タブ操作: `tab:register`（既存フォルダ2件）、`tab:create`（新規フォルダ作成+登録、および親フォルダ不在での`NOT_FOUND`）、`tab:rename`（フォルダ実体も`TabB-renamed`へリネームされることをディスクで確認）、`tab:remove`（`deleteFolder:false`でフォルダ温存/`deleteFolder:true`でごみ箱送りされフォルダ消失をディスクで確認）、`tab:reorder`（`AppSettings.tabs`配列順の入れ替えを`tab:list`とディスク上`app-settings.json`の両方で確認）を全て確認。
- ツリー表示・開閉・永続化: `tab:openTree`でメタ+実ファイル突合結果を確認。`tree:updateStructure`でノード開閉状態を変更し`.tabtreenote.json`へ反映、Electronプロセスを完全終了→`--user-data-dir`を維持して再起動後も`tab:list`の並び順・タブ名・ツリー開閉状態(`expanded:false`)が復元されることを確認。`tree:updateStructure`への実ファイル集合と不一致なツリー構造送信は`NOT_FOUND`で拒否されることも確認。
- 複数選択（実DOM操作）: CDPの`Input.dispatchMouseEvent`でmodifiers(ctrl/shift)付きの本物のマウスイベントをツリー行に発火。通常クリックで単一選択→置換、Ctrl+クリックでトグル追加/除去、Shift+クリックでアンカーから対象までの範囲選択（8行全選択を確認）が正しく機能することをDOMの`.tree-row--selected`クラスで確認。
- 追加位置（`memo:create`）: first/last/before/after/childの5パターンをIPC直叩きで実行し、`tab:openTree`のツリー順序が意図通り（子ネスト含む）であることを確認。
- リネーム: `memo:rename`で実ファイル名変更+ツリー反映を確認。名前サニタイズ（予約名`CON`、禁止文字`?`）は`NAME_INVALID`で拒否。
- 削除: `memo:delete`既定（ごみ箱送り）でファイル消失+メタ反映を確認。`forceDirect:true`再invoke経路（直接`fs.unlink`相当）もIPC直叩きで確認（ファイル消失+メタ反映）。
- 複製: `memo:duplicate`を同一メモに対して2回実行し「〇〇のコピー」「〇〇のコピー (2)」と自動採番されること、元の直後（同階層）へ挿入されることを確認。
- 移動・コピー: 同一タブ内移動（メタのみ変更・実ファイル不動をディスクで確認）、タブ間移動（実ファイルがフォルダ間で移動しメタも両タブぶん更新、宛先に同名衝突がある場合は`NAME_DUPLICATE`でバッチ全体拒否）、タブ間コピー（元は残り、名前衝突時は「〇〇のコピー」で自動改名）、同一タブ内コピー（衝突が無くても常に改名）を全てIPC直叩き+ディスク確認。複数ノード一括`after`移動でreviewer指摘M2-R1-02の選択順維持（反転しない）ことも実測で確認。
- DND（実DOM操作）: ページ内で`DragEvent`+`DataTransfer`を構築し、対象行への`dragstart`→`dragover`→`drop`→`dragend`を実際に発火（`draggable`属性の存在も確認）。同一タブ内ドラッグ移動（`tree:updateStructure`経由、順序変更をDOM上で確認）、Ctrl+ドラッグでのコピー（`memo:move copy:true`経由、新規「のコピー」ファイル生成をDOM上で確認）を確認。TabBarへのドロップハンドラも同一タブ宛のケースで例外なく動作することを確認（複数タブでのクロスタブDND本体はIPC`memo:move`側で既に検証済みのため、UIハンドラの例外安全性の確認として実施）。
- 名前サニタイズUX（`NameInputDialog`、実DOM操作）: 入力欄へのネイティブinputイベント発火で即時バリデーションメッセージ（禁止文字/予約名/前後空白/末尾ピリオドの4パターン）表示、置換候補ボタン「「bad-name」に修正する」のワンクリックでの値置換と送信ボタン活性化、を実DOM操作で確認。
- 同期順序・世代管理: `.txt`本体、`.tabtreenote.json`とその`.bak`が各操作を通じて正しく生成/更新されることをディスク走査で確認。一時ファイル(prefix付き)の残留なしを確認。
- 後片付け: 検証用一時フォルダ2件（scratchpad配下、リポジトリ外）・Electron userData（`--user-data-dir`で隔離、リポジトリ外）を削除済み。検証後`Get-Process electron`は0件を確認（2回の起動セッションとも終了確認済み）。
- 外部サービスへの副作用: なし（すべてローカルファイル操作・localhost CDPのみ。実運用のAPIキー/Webhook等は使用していない）。

## reviewer — M3-①（CodeMirror 6 統合）実装 静的レビュー（ラウンド1）

対象: src/renderer/editor/codeMirrorSetup.ts（新規）, src/renderer/components/Editor/CodeMirrorEditor.tsx（新規）, src/renderer/App.tsx（textarea→CodeMirrorEditor置換ほか）, src/renderer/App.css, src/renderer/editor/eolKeeper.ts（コメントのみ）, package.json（CodeMirror個別パッケージ追加）。DESIGN §2.3/§2.4/§2.9/§6・PLAN §1.4/§4.4/§5.2 と照合。ブロッキング指摘なし。

- 判定: **ブロッキング指摘なし。developer への差し戻し不要。**
- M3R1-01 [Info] developer報告のスコープ判断4（行単位カット/コピー未実装）は事実誤認の可能性: node_modules 内 `@codemirror/view` の `handlers.copy = handlers.cut`（copiedRange関数）はコア組み込み動作で、選択範囲が空の場合は自動的にカーソル行を対象とする line-wise コピー/カットを行う（basicSetup非依存、常時有効）。追加実装なしで DESIGN §2.3「行単位の切り取り/コピー」を満たしている可能性が高い。tester に Ctrl+C/Ctrl+X（選択無し）でカーソル行がコピー/カットされることの実機確認を依頼し、確認できれば「未実装」ではなく「対応済み」として記録を訂正することを推奨（コード修正は不要、記録訂正のみ）。
- M3R1-02 [Low/Info] 対応不要・M6向け留意: `key={tabId:memoName}` によるアンマウント/再マウント方式はメモ切替時のUndo履歴破棄（DESIGN §2.3）を正しく満たす。ただし M6 の「(再)ロック時もUndo履歴を厳格破棄」（DESIGN §2.9, PLAN §5.5）は同一メモのまま鍵のみ破棄するケースがあり得るため、ロック時に `openMemo` をnull化して一旦アンマウントする、またはkeyに世代番号を含める等の追加対応がM6実装時に必要になる。現時点のM3-①設計を壊すものではなく、M6着手時にdeveloperが意識すればよい。
- スコープ判断1〜3・5（DEFAULT_WRAP_CHARS固定値／空白可視化Compartment・永続化フィールド無し／メモ毎editor設定の未配線／Ctrl+S配線漏れ解消）はいずれも妥当。PLAN/DESIGNのデータモデルに対応フィールドが無い範囲の合理的な既定値・縮小であり、設計原則（改行コード保持・Undo履歴スコープ・鍵管理境界）を壊すものではない。
- DESIGN §2.3 必須注意（CM6のLF正規化対策）: `handleEditorChange` が `update.state.doc.toString()`（LF区切り）をそのまま `contentLF` として保持し、`memo:save`/`crypto:saveEncrypted` へ渡す経路（main側 `eol.restore` は今回未変更）と整合。eolKeeper.ts はロジック変更なし、コメント更新のみで実害なし。
- セキュリティ: 本マイルストーンは平文メモのみ扱い、秘密情報のログ出力・ハードコードなし。`readOnly`/`autoFocus` props と `EditorView.editable`/`EditorState.readOnly` の組み合わせは将来のM6ロック表示・M4監視競合ロックに配線しやすい形になっている。
- Reactの実装品質: uncontrolled設計（`initialContentLF`はマウント時のみ使用、以後は`onChange`通知のみ）、コールバックはref経由で最新版を参照（stale closure回避）、`view.destroy()`によるアンマウント時クリーンアップ、ネイティブwheelリスナーはcallback ref経由で張り替え+cleanup関数保持と問題なし。設定変更はCompartment経由のreconfigureで不要な再マウントを避けている。

## developer — M3-①（CodeMirror 6 統合）実装

対象: M3 を「① CodeMirror 6 統合」「② 全文検索本体（searchIndex/IPC/検索履歴/検索パネルUI）」に分割し、今回は①のみ実装。②は未着手（別セッション予定）。M0〜M2 のコードは作業ツリーに存在するが未コミット（ユーザー指示待ち）。

- 新規: `src/renderer/editor/codeMirrorSetup.ts`（拡張構成一式。Compartment化=wrap/indent(tabWidth+softTab)/lineNumbers/whitespace/font、静的拡張=history/drawSelection/dropCursor/rectangularSelection/highlightActiveLine/search({top:true})+searchKeymap/defaultKeymap/historyKeymap/Mod-s保存/Enterオートインデント(insertNewlineKeepIndent, Prec.highest)/Tab(insertTab)・Shift-Tab(indentLess)、`computeEditorStats`（文字数/行数/カーソル行列/選択文字数））、`src/renderer/components/Editor/CodeMirrorEditor.tsx`（非制御Reactラッパ。`initialContentLF`はマウント時のみ使用、`onChange`/`onStats`はref経由で最新コールバックを呼ぶ、設定変更はCompartment経由でreconfigure、readOnly/autoFocus props用意（現状未使用=将来のM4ロック/M6暗号化表示向け））。
- 変更: `src/renderer/App.tsx`（textarea→`CodeMirrorEditor`。key=`${tabId}:${memoName}`でメモ切替時に再マウント=Undo履歴リセット（DESIGN §2.3方針）。`editorSettings`state追加（初期値`DEFAULT_EDITOR_SETTINGS`、`settings:get`のeditorDefaultsで上書き）。`editorStats`stateとステータスバー表示追加。Ctrl+ホイールでのフォントサイズ変更（10-32px、`{passive:false}`ネイティブwheelリスナーをcallback ref経由でエディタ枠に張り、`editor__wrap`のmount/unmountに追従、500msデバウンスで`settings:set`永続化）。`handleSave`にdirtyガード追加（Ctrl+S誤爆防止）。メモ close/削除/タブ削除の各箇所へ`setEditorStats(null)`を追加）、`src/renderer/App.css`（`.cm-editor-host`とCodeMirror既定クラスをCSS変数テーマに合わせてオーバーライド、旧`.app__editor-textarea`削除）、`src/renderer/editor/eolKeeper.ts`（コメント更新のみ、ロジック変更なし）。
- 依存追加: `@codemirror/state` `@codemirror/view` `@codemirror/commands` `@codemirror/language` `@codemirror/search`（`codemirror`メタパッケージ=basicSetupは使わず個別導入。コード補完/foldGutter等プレーンテキストに不要な機能を持ち込まないため）。
- スコープ外/developer判断の既定値扱い（reviewer確認事項）:
  1. 折り返し「文字数指定」はAppSettings/MemoEditorSettingsに文字数フィールドが無いため`DEFAULT_WRAP_CHARS=80`固定（`.cm-content{max-width:80ch}`近似）。M7で数値設定UIを追加する際にフィールド拡張が必要。
  2. 空白/改行可視化トグルは永続フィールドが無いため`EditorSettings.showWhitespace`はコンポーネント内既定falseのみ（M7でUI配線予定、CodeMirror側は`highlightWhitespace`/`highlightTrailingWhitespace`のCompartmentとして実装済み）。
  3. メモ毎`MemoEditorSettings`（wrap/font個別上書き）は今回未配線。`AppSettings.editorDefaults`（アプリ全体既定）のみ反映。
  4. 行単位の切り取り/コピー（選択無しでのCtrl+X/Cが現在行を対象にする挙動）は未実装（選択ベースの通常のCut/Copyのみ）。DESIGN §2.3に列挙されているが今回のCodeMirror統合の主目的（検索/置換/正規表現/EOL維持/折返し/インデント/行番号/フォント）には含まれないと判断。
  5. Ctrl+S保存ショートカットはDESIGN §2.6に既定として明記されていたがM1/M2のtextarea版には未配線だったため、今回エディタkeymap整備のついでに追加（スコープ拡張ではなく既存設計の配線漏れ解消）。
- 確認: `npm install`後 `tsc --noEmit`（renderer/node両方）エラーなし、`electron-vite build`成功（`out/renderer/assets/index-*.js` 923KB、CodeMirror追加分の増分。chunk分割等の最適化はM7以降の課題として未対応）。`electron . --remote-debugging-port --user-data-dir=<隔離tmp>`起動時のログにエラーなし（起動可否のみの軽い確認。実際のCodeMirror動作検証はtester範囲）。検証用一時フォルダ・electronプロセスは後片付け済み。
- reviewer/testerへの依頼時に上記5点（既定値扱い/未配線範囲）を明記し、設計逸脱ではなくM3を2分割した際の①スコープ内判断であることを伝える。

## tester — M3-①（CodeMirror 6 統合）動作検証（ラウンド1）

対象: reviewer M3-① ラウンド1（ブロッキング指摘なし）後の一式。npm install / typecheck / build / prod起動 / CDP実機操作（Input.dispatchKeyEvent・dispatchMouseEvent, Runtime.evaluate）による改行コード保持・検索置換・Undo履歴破棄・行単位カット/コピー・折返し/行番号/タブ幅/現在行ハイライト/フォントサイズ/ステータスバーを独立して再現確認。

- 判定: **軽微な不具合1件（Medに近いLow）を記録のみで報告（差し戻しは行わない）。それ以外は全項目OK。developer への差し戻しは行わない。**
- npm install: 成功（`up to date, audited 391 packages`。allow-scripts警告のみ）。
- typecheck: `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json` エラーなし。
- build: `electron-vite build` 成功。`out/main/index.js`(45.39kB)/`out/preload/index.js`(3.03kB)/`out/renderer/assets/index-*.js`(923.15kB, CodeMirror込み)/css を生成確認。
- prod起動: `--user-data-dir`で隔離したuserDataを使い`electron . --remote-debugging-port=9333`起動。ログは`DevTools listening`のみでエラーなし。CDP `Runtime.consoleAPICalled`/`Runtime.exceptionThrown`を全操作を通して監視（計約3分、2回に分けて監視）し、セッション全体でコンソールエラー・例外0件。
- **改行コード保持（最重要, 実ファイルバイト列確認）**: CRLF/LF/CR各1件のメモ（`\r\n`/`\n`/`\r`混在なしで生成）をUIから開き（ステータスバーで`eol: crlf`/`eol: lf`/`eol: cr`検出を確認）、CDP実キー入力（`Input.dispatchKeyEvent`、windowsVirtualKeyCode付与でCM6のcontentEditableへ実際に文字挿入）で編集後Ctrl+S保存し、保存後ファイルを`xxd`で実バイト確認。3種とも元の改行コードが完全に維持（CRLFは`0d0a`、LFは`0a`のみ、CRは`0d`のみ、いずれも他方式への混入なし）されることを確認。CM6のLF正規化の影響を受けていないことを実ファイルレベルで確認。
- 検索/置換パネル（Ctrl+F）: パネル自体の表示（next/previous/all/match case/regexp/by word/replace/replace all）、通常検索（3件マッチのハイライト`.cm-searchMatch`）、next移動での選択反映（ステータスバーの選択文字数・カーソル位置に反映、`.cm-searchMatch-selected`付与）、単一置換（`replace`ボタンで1件のみ置換）、全置換（`replaceAll`ボタンで残り全件置換）、正規表現検索（`re`チェックボックスON後`LI\w+\d`で3件正しくマッチ）を実機確認。
- メモ切替時のUndo履歴破棄（DESIGN §2.3）: メモA（crlf-memo）で編集→保存→別メモへ切替→メモAへ戻り、Ctrl+Zを3回押しても内容が変化しないことを確認（新規EditorViewインスタンスとしてUndo履歴が空であることを確認）。同一メモ内でのCtrl+Zは正常に動作すること（直前入力の取り消し）も別途確認。
- **行単位カット/コピー（reviewer情報提供M3R1-01の実機確認）**: `document.addEventListener('copy'/'cut', ..., false)`（bubbleフェーズ）でclipboardDataを捕捉した上で、選択なし（カーソルのみ）状態でCDP実キー入力によるCtrl+C/Ctrl+Xを実行。Ctrl+Cではカーソル行（`line2`）全文がclipboardDataにコピーされること、Ctrl+Xでは同様にカーソル行（`line3`）がカットされ実際にドキュメントから当該行が削除されることを確認。**「行単位の切り取り/コピー」はCodeMirror 6のコア機能により追加実装なしで対応済み**（developer報告の「未実装」は誤りと訂正。reviewerのM3R1-01推測どおり）。
- 折返し/行番号/タブ幅/現在行ハイライト/フォントサイズ: 行番号ガター表示・`.cm-activeLine`（現在行ハイライト）付与・`.cm-content`の`white-space: break-spaces`（既定wrap='window'）を確認。Ctrl+ホイール（`wheel`イベント、`ctrlKey:true`、`{passive:false}`ネイティブリスナー経由）でフォントサイズが14px→15pxに変化し、`.cm-editor`の`computedStyle.fontSize`にも反映、500msデバウンス後`settings:get`の`editorDefaults.fontSize`へ永続化されることを確認。空白可視化（既定OFF）が実際に非表示（`.cm-highlightSpace`等0件）であることも確認。
- ステータスバー: 文字数/行数/カーソル行:列/選択文字数/フォントサイズが編集・カーソル移動・選択操作のたびに追従更新されることを一連の操作を通して確認。
- **[Low/中程度寄り] NG（記録のみ, 差し戻し不要と判断）: ソフトタブ設定（`softTab: true`既定）がカーソルのみ（選択なし）でのTabキー押下では効かない。** `codeMirrorSetup.ts`の`tabKeymap`は`{ key: 'Tab', run: insertTab }`（`@codemirror/commands`）を使用しているが、`insertTab`の実装（`node_modules/@codemirror/commands/dist/index.cjs` 1655行目）は選択範囲がある場合のみ`indentMore`（`indentUnit`＝スペース設定を尊重）を呼び、選択なしの場合は常にリテラルな`"\t"`文字を挿入する（`indentUnit`を無視）。実機確認: 選択なしでTab→ドキュメントに文字通りのタブ文字が挿入（softTab設定を無視）。行全体選択後にTab→期待通り4スペースへ正しくインデント（`indentMore`経由でindentUnit尊重）。**通常のカーソルのみでのTab入力（最も一般的な単一行インデント操作）でsoftTab設定が無効化される**ため、softTab=trueでもファイルに実タブ文字が混入し得る。CM6標準コマンドの仕様（indentUnit対応のソフトタブ挿入には`insertTab`ではなくカスタムコマンド or `indentUnit`参照の独自関数が必要）に起因。過去のreviewer合格判定（ブロッキング指摘なし）はこの挙動まで検証していなかった可能性が高い。**深刻度判断: EOL保持・データ破損等の致命的問題ではなく、タブ文字混入自体はプレーンテキストとして不正ではない（あくまでsoftTab設定が期待通り動かないUX上の不整合）ため、致命的とは判断せず差し戻しは行わない。記録として残し、developer/designerの今後の判断に委ねる。**
- **[Info] 記録のみ（M3スコープ外・pre-existing、M3の回帰ではない）: 自動保存が未実装。** `AppSettings.editorDefaults`/`autosave`（`plainDebounceMs: 1500`等）は`src/main/settings/appSettings.ts`・`src/shared/models.ts`に定義済みだが、`src/renderer`側に自動保存のデバウンス保存ロジックは一切実装されていない（grep で該当実装なしを確認）。ただしAGENT_LOG既存記録（M2-R1-01, reviewer）で「M2に自動保存なし＝唯一の保護が失われる」と既に言及されており、M3-①以前から意図的に未実装（確認ダイアログによる保護が代替）として扱われてきた経緯があるため、**M3-①によるリグレッションではない**。今回の検証依頼文に「Ctrl+S、および自動保存が動くこと」とあったため確認したが、自動保存自体はM3-①のスコープ外（DESIGN §2.6の要件だが実装時期は未定）と判断し、差し戻しの対象にはしない。
- 後片付け: 検証用一時フォルダ（scratchpad配下、リポジトリ外）・Electron userData（`--user-data-dir`で隔離、リポジトリ外）を削除済み。検証後`Get-Process electron`は0件を確認。
- 外部サービスへの副作用: なし（すべてローカルファイル操作・localhost CDPのみ。実運用のAPIキー/Webhook等は使用していない）。

## developer — M3-②（全文検索本体）実装

対象: M3-①（CodeMirror 6統合、reviewer/tester合格済み・未コミット）に続き、全文検索本体（メモリ内インデックス・IPC・検索履歴・全文検索パネルUI・結果ジャンプ）を実装。

- 新規: `src/main/search/searchIndex.ts`（tabId→memoName→{encrypted,contentLF|null}のMap。`buildIndex`=起動時全タブ走査、`indexTab`=1タブ(再)走査（tab:register/create用）、`updateMemo`/`removeMemo`/`renameMemoInIndex`/`moveMemoInIndex`(copy/moveの両方に対応)/`removeTabFromIndex`=経路①差分更新、`search`=name/body両対象・大小文字/正規表現オプション・MAX_HITS=1000上限）。暗号化メモは`contentLF:null`固定で本文を一切保持しない（DESIGN §2.4）。
- 新規: `src/main/ipc/searchHandlers.ts`（`search:global`=indexのsearchを呼びtabNameを`listTabs()`で解決して返却、`search:history:get`/`search:history:add`=メインプロセスのメモリ内配列、上限20件、重複は先頭へ移動）。検索履歴はAppSettingsスキーマに定義が無く「メモリ内軽量・永続DBなし」方針に沿ってセッション内メモリ保持のみとした（developer判断、非永続）。
- 新規: `src/renderer/components/Search/SearchPanel.tsx`（モーダル風オーバーレイ。scope=all/currentTab切替、大文字小文字区別/正規表現オプション、検索履歴クリックで再検索、結果一覧クリックで`onJump`、`evt:indexUpdated`購読で表示中クエリを自動再検索）。
- 変更: `src/main/index.ts`（bootstrapに`searchIndex.buildIndex(listTabs())`を追加。ウィンドウ表示前にブロッキング構築、Fix11の想定規模内として許容。構築処理自体は`buildIndex`に分離済みで将来のバックグラウンド化に対応しやすい形）。
- 変更: `src/main/ipc/registerIpc.ts`（`registerSearchHandlers`登録）、`src/main/ipc/memoHandlers.ts`（save/create/rename/delete/duplicate/moveの各成功箇所に経路①のインデックス更新+`evt:indexUpdated`発火を配線。同一タブ内move（ツリー位置のみ変更）はインデックス無変更なので発火しない）、`src/main/ipc/tabHandlers.ts`（register/createはフォルダ(再)走査で`indexTab`、removeは`removeTabFromIndex`。renameはtabId/メモ名とも不変のためインデックス更新不要と判断）。
- 変更: `src/shared/models.ts`（`SearchHit`型追加）、`src/shared/ipc-contract.ts`（`SearchScope`/`SearchOptions`/`SearchGlobalArgs`/`SearchHistoryAddArgs`/`IndexUpdatedPayload`型、`PreloadApi.search`/`events.onIndexUpdated`追加）、`src/preload/index.ts`・`src/renderer/ipc.ts`（対応するAPI/イベント購読の配線）。
- 変更: `src/renderer/components/Editor/CodeMirrorEditor.tsx`（`RevealTarget`prop追加。`token`をクリック毎にインクリメントし、同一位置への再クリックでも確実に選択・`EditorView.scrollIntoView`する設計。マウント用effectより後に宣言し同一コミット内でviewRef.current確定後に参照）、`src/renderer/App.tsx`（`showSearchPanel`/`revealTarget`state、`handleJumpToHit`=タブ切替→メモを開く→本文一致ならrevealTarget発行、Ctrl+Shift+Fショートカット（CodeMirror内蔵のCtrl+F現在メモ内検索とは非衝突）、`SearchPanel`のレンダリング）、`src/renderer/components/TabBar/TabBar.tsx`（「🔍 検索」ボタン追加）、`src/renderer/App.css`（`.search-panel*`スタイル追加）。
- 設計判断（reviewer確認事項）:
  1. `SearchHit.matchStart`/`matchEnd`は本文一致時のみ、readMemo/memo:save/memo:readWithEncodingと同じLF正規化済み`contentLF`基準のオフセット。ジャンプ時にCodeMirrorへそのまま渡せば選択位置が一致する設計（`memo:read`後のcontentLFと index内contentLFが同一パイプライン由来のため整合）。
  2. 正規表現が不正な場合は`search:global`をエラー(Result NG)にせず「ヒットなし」として空配列を返す（インクリメンタル入力中の頻繁なエラー表示を避けるUX判断、00-core-principles.md §8「検索は基本的に読み取り操作」を踏まえた判断）。
  3. `evt:indexUpdated`はtabId単位で発火（複数タブに跨るmemo:move/duplicateは影響する各タブ分だけ個別発火）。レンダラのSearchPanelは発火のたびに「表示中の直前クエリ」を単純に再実行する設計（tabId一致判定はしていない。scope=allなら常に有効、scope=currentTabでも対象タブ固定のため無害）。
  4. 検索履歴はメインプロセスのメモリ内のみ保持し、アプリ設定JSONへは永続化しない（§5.2参照）。
  5. `handleJumpToHit`はタブ切替（`selectTab`）後に`openMemoByName`（`selectedTabId`stateをクロージャで読む）へ委譲せず、`hit.tabId`/`hit.memoName`を直接引数に`ipc.readMemo`する自己完結実装にした（自己レビューで発見: `selectTab`のawait中に束縛済みの古い`openMemoByName`クロージャを呼ぶとタブ切替前の`selectedTabId`を参照するstale closureバグになるため）。タブ切替が未保存確認キャンセルで中断された場合は`selectedTabIdRef`（`dirtyRef`と同型のref）で検知しジャンプを中断する。
- 確認: `npm run typecheck`（renderer/node両方）エラーなし、`npm run build`（electron-vite build）成功（`out/renderer/assets/index-*.js` 933.80kB）。実機起動・全文検索の動作確認はtester範囲のため未実施。

## reviewer — M3-②（全文検索本体）実装 静的レビュー（ラウンド1）

対象: searchIndex.ts / searchHandlers.ts / SearchPanel.tsx（新規）、memoHandlers.ts / tabHandlers.ts / main/index.ts / registerIpc.ts / models.ts / ipc-contract.ts / preload・renderer/ipc.ts / CodeMirrorEditor.tsx / App.tsx / TabBar.tsx（変更）。DESIGN §2.4・M3-search.md と照合。

- 判定: **ブロッキング指摘なし。developer への差し戻し不要。**
- 暗号化メモの本文除外（DESIGN §2.4最重要原則）: OK。`updateMemo`/`indexTab`/`moveMemoInIndex`いずれも`encrypted`時は`contentLF:null`固定。`search()`の`searchInTab`は`contentLF===null`をbody一致対象から確実にスキップ。name一致のみ許容（意図通り）。SearchHit/SearchPanelとも暗号化メモのbody内容（lineText等）を返す経路なし。検索履歴もユーザー入力クエリ文字列のみでメモ本文非経由。漏洩経路なし。
- 経路①配線（DESIGN §2.4/§3.3）: memoHandlers.ts の save/create/rename/delete/duplicate/move、tabHandlers.ts の register/create/remove すべてで、実ファイル操作・メタ保存の「成功確認後」にインデックス更新関数を呼ぶ順序を確認（順序ミスなし）。同一タブ内move（実体不変）はインデックス更新・`evt:indexUpdated`とも発火しない判断も妥当。tab:renameがtabId不変（UUID、tabService.renameTab確認）なのでインデックス更新不要という判断も正しい。main/index.tsのbootstrapで`buildIndex`がウィンドウ生成前に呼ばれることも確認。
- `handleJumpToHit`自己完結実装: stale closure回避の設計判断は妥当。`selectTab`のawait後に`selectedTabIdRef`で実際に切り替わったか確認してからジャンプする実装も正しい。`openMemoByName`との重複はあるが（意図的なclosure回避のため）実害なし。
- 検索履歴の非永続化: AppSettingsスキーマに対応フィールドが無い状況での妥当なdeveloper判断。個人プロジェクト規模で許容範囲。
- コード品質: 型安全性・エラーハンドリングとも問題なし。不正な正規表現を「ヒットなしの空配列」で丸める判断も00-core-principles.md §8に沿う。MAX_HITS=1000の安全弁も妥当。
- 非ブロッキング留意（対応不要、M6着手時の参考）: `memoHandlers.ts`の`memo:save`は`updateMemoIndex(..., false, ...)`と`encrypted`を固定`false`で呼んでいるが、現時点で`crypto:*`ハンドラ（registerIpc.tsコメントに「以降のMで追加」と明記）が未登録のため`memo:save`は平文メモ専用であり実害なし。M6でのcrypto:saveEncrypted実装時にそちらから`updateMemoIndex(..., true, null)`を呼ぶ配線を忘れないよう留意。

## tester — M3-②（全文検索本体）動作検証（ラウンド1）

対象: reviewer M3-② ラウンド1（ブロッキング指摘なし）後の一式。npm install / typecheck / build / prod起動 / IPC直叩き+実DOM操作（CDP Runtime.evaluate・Input.dispatchKeyEvent）による全文検索・差分更新（経路①）・正規表現/大文字小文字オプション・検索履歴・暗号化メモ除外・結果ジャンプ・M3①回帰を独立して再現確認。

- 判定: **全項目 OK。不具合なし。developer への差し戻しなし。**
- npm install: 成功（`up to date, audited 391 packages`。allow-scripts警告のみで動作に支障なし）。
- typecheck: `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json` エラーなし。
- build: `electron-vite build` 成功。`out/main/index.js`(52.15kB)/`out/preload/index.js`(3.72kB)/`out/renderer/assets/index-*.js`(934.55kB)+css を生成確認。
- prod起動: `--user-data-dir`で隔離したuserDataを使い`electron . --remote-debugging-port=9333`起動（`.txtenc`確認のため計2回起動）。ログは`DevTools listening`のみでエラーなし。
- **全文検索の基本動作（最重要）**: `tab.register`で2タブ（tabA/tabB）登録、`memo.create`+`memo.save`で3メモ作成（メモ名・本文ともユニーク文字列を含む）。`search:global`でメモ名一致・本文一致の双方がヒットすること、scope='all'（全タブ横断）とscope='currentTab'（対象タブのみ・他タブ不干渉）の両方が正しく機能することをIPC直叩きで確認。実DOM操作でも「🔍検索」ボタンでSearchPanel起動→入力→送信→結果一覧描画→ヒットクリックでタブ切替+該当メモオープン+`document.getSelection().toString()`が一致箇所と完全一致（`zzz123`）することを確認（`revealTarget`によるジャンプ機能、`EditorView.scrollIntoView`込み）。
- **インデックス差分更新（経路①）の実際の反映確認（重要）**: 保存（内容変更）→直後の全文検索で旧文字列が消え新文字列がヒットすることを確認（`before`→`save`→`afterOld`（空）→`afterNew`（ヒット）の順でIPC直叩き確認）。リネーム（旧名ヒット消失・新名ヒット出現、本文ヒットは維持）、複製（複製元・複製先の両方が本文ヒット）、削除（削除対象のみ消失・複製先は残存）、タブ間移動（移動元タブでヒット消失・移動先タブでヒット出現）を全てIPC直叩きで確認。加えてSearchPanelを開いた状態でIPC経由の`memo.save`を実行し、`evt:indexUpdated`購読による自動再検索（表示中クエリの再実行）が実際に発火し結果一覧が即座に更新される（文字列除去後「一致する結果はありません。」表示に切替）ことを実DOM操作で確認。
- **正規表現検索・大文字小文字オプション**: 正規表現（`C[hH]erry\w*`でメモ名+本文ヒット）、大文字小文字区別なし（既定, 'cherry'で'CherryLog'名・本文双方ヒット）、大文字小文字区別あり（'cherry'では本文のみヒットしメモ名'CherryLog'は不一致、'CherryLog'では逆にメモ名のみヒット）を意図通り確認。不正な正規表現（`(unterminated`）はエラーではなく空配列（ヒットなし）として安全に丸められることも確認（設計判断どおり）。
- **検索履歴**: `search:history:add`後に`search:history:get`へ反映、同一クエリの重複追加が先頭へ移動し重複エントリを作らないことを確認。
- **暗号化メモの扱い**: タブフォルダへ`.txtenc`拡張子のダミーファイルを直接配置した状態でElectronプロセスを再起動（`buildIndex`による起動時走査を実際に経由）し、`search:global`でメモ名のみヒット・本文（ダミー内容の文字列）は一切ヒットしないことを実機で確認。`tab.list`でタブ構成にも影響がないことを確認。`searchIndex.ts`コードレベルでも`encrypted`時`contentLF:null`固定の経路を確認。
- **M3①（CodeMirror統合）の回帰確認**: 実DOM+CDPキー入力でCtrl+Fを送信し、CodeMirror内蔵検索パネル（`.cm-search`）が正しく開くことを確認。エディタツールバーの`encoding`/`eol`表示、文字数/行数/カーソル位置/選択文字数のステータス表示も編集・選択操作に追従することを確認。深刻な回帰は検出せず。
- 後片付け: 検証用一時フォルダ（scratchpad配下、リポジトリ外）・Electron userData（`--user-data-dir`で隔離、リポジトリ外）を削除済み。検証後`Get-Process electron`は0件を確認（2回の起動セッションとも終了確認済み）。
- 外部サービスへの副作用: なし（すべてローカルファイル操作・localhost CDPのみ。実運用のAPIキー/Webhook等は使用していない）。

## reviewer — M4（ファイル監視）実装 静的レビュー（ラウンド1）

対象: watch/watcher.ts・conflict.ts・activeMemoState.ts（新規）、ipc/editorHandlers.ts・dialogs/ConflictDialog.tsx（新規）、selfWriteRegistry.ts・atomicWrite.ts・memoFileService.ts・trash.ts・tabHandlers.ts・registerIpc.ts・index.ts・constants.ts・ipc-contract.ts・preload/index.ts・renderer/ipc.ts・codeMirrorSetup.ts・CodeMirrorEditor.tsx・App.tsx（変更）、package.json（chokidar追加）。M4-watch.md・00-core-principles.md §4/§5/§7/§8/§10・data-model.md・DESIGN §3.3/§5.6と照合。

- 判定: **ブロッキング指摘なし。developer への差し戻し不要。tester へ進行可。**
- M4-R1-01 [Low/中程度寄り] 要改善（ブロッキングではない）: `atomicWrite.ts`はrename失敗時に`consumeSelfWrite`で予約解放するが（M1-R1-02由来の既存対応）、同じ「操作前registerSelfWrite→fs操作失敗」パターンを持つ`memoFileService.ts`の`renameMemoFile`/`duplicateMemoFile`/`moveMemoFileToFolder`/`copyMemoFileToFolder`と`trash.ts`の`trashPath`/`deletePathDirect`には失敗時の解放処理が無い。`withRetry`/`shell.trashItem`が全滅すると、登録済みレコードがTTL(2.5秒)満了まで残存し、その間に同一パスへの真の外部変更が発生すると自己発火と誤判定され握りつぶされ得る（00-core-principles.md §4の意図「登録漏れ=外部変更の誤検知を防ぐ」に対する漏れ）。実害はTTL内の稀な競合窓に限定され、データ破損はないが、`atomicWrite.ts`で既に確立した対処パターンとの不整合のため、同様の解放処理の追加を推奨。
- developer確認9点への回答:
  1. `editor:reportActive`新設: 妥当。dirty状態はレンダラ由来でメインが本来関知しないため、最小限の一方向通知を追加する以外に方法が無い。ペイロードも機微情報を含まず、PreloadApi/ipc-contract.tsの型整合も確認。承認。
  2. mtime不使用（サイズ+ハッシュ完全一致のみ）: DESIGN §3.3/§5.6・M4-watch.mdの記述（mtime+サイズ+ハッシュの複合判定）とは字面上乖離するが、ハッシュ完全一致は実質的にmtimeより厳密な同一性判定であり、mtime追加はNTFSタイムスタンプ精度・stat取得タイミングのブレによる誤判定（自己発火の見逃し→毎回保存のたびに誤ったevt:conflict/externalChange発火）のリスクを増やすだけで精度向上に寄与しない、という判断は技術的に妥当。ブロッキングとはしないが、DESIGN.md/M4-watch.mdの文言とコードの意図的乖離のため、正本側への注記更新をどこかのタイミングで行うことを推奨（doc同期の課題であり今回の実装不備ではない）。
  3. `.bak`をchokidarの`ignored`で完全除外: DESIGN文中は`.bak`をselfWriteRegistry照合対象として扱う書きぶりだが、`.bak`は常にnull-expectationで登録され突合時は無条件マッチ（安全側）になるため、ignored除外とselfWriteRegistry経由除外は実質的に同じ結果になる。むしろignored除外の方が`.bak`関連イベントを検索インデックス/競合判定に一切到達させない点でシンプルかつ安全。承認。
  4. メタJSON外部変更の簡易処理（ツリー再取得のみ促す）: PLAN §2.7の記述（changesが空配列になり得る）と整合。実際の再読込・復旧カスケードはrefreshTree→tab:openTree側の既存経路に委譲されており妥当。承認。
  5. reloadGenerationによる強制再マウント: 非制御CodeMirrorコンポーネントの制約（initialContentLFはマウント時のみ有効）を踏まえた妥当な設計。Undo履歴が外部反映のたびにリセットされるのも「内容が外部由来」である以上適切。承認。
  6. evt:opErrorのM4初実装: IPC呼び出し元を持たないバックグラウンドI/O（chokidarイベント処理）で初めて必要になったという経緯は妥当。実装（safeProcessSettledEvent/watcher error handler）もcode/message/pathのみレンダラへ返し、内部ログにOSエラーコード・スタックを記録する00-core-principles.md §10方針と一致。承認。
  7. chokidar ^4.0.3固定: 情報不足のv5見送りは保守的で妥当な判断。承認。
  8. 競合ダイアログ表示中ロック（自動保存未実装のため対象外）: grep確認の結果、現コードベースに自動保存のデバウンス保存ロジックは実装されていない（AppSettings.autosaveはスキーマのみ）。エディタ入力ロック（readOnly Compartment）とhandleSaveのconflictInfoガードで「解決中ロック」の趣旨は満たされている。承認（自動保存実装時は当該箇所にも同様のconflictInfoガードが必要になる点を留意事項として記録）。
  9. 「自分の変更を保存」がexpectedHash:undefinedでCONFLICT検出を意図的にバイパス: ユーザーが競合ダイアログで明示的に選択した意図的な上書きであり、既存の保存API競合チェック（ハッシュ比較のみの一発判定）の設計と矛盾しない限定的バイパス。承認。
- その他の軽微な指摘（Info、対応不要）: `constants.ts`の`TEMP_FILE_GLOB`が定義のみで未使用（watcher.tsは`TEMP_FILE_PREFIX`を直接参照する独自関数`isIgnoredPath`を実装）。デッドコードだが実害なし。`index.ts`の`app.on('activate')`は`stopWatching`を挟まず`startWatching`を再実行するが、Windows優先アプリでmacOS専用経路のため実害なし。
- セキュリティ/例外処理: 秘密情報のハードコード・ログ出力なし。`processSettledEvent`の例外は`safeProcessSettledEvent`で捕捉しUNKNOWN化+内部ログのみ（Fix8方針と一致）。`chokidar`の`error`イベントも同様に処理。IPCハンドラは全て`wrapHandler`経由。同期順序（①ストア→②実ファイル+予約登録→③メタ保存）・selfWriteRegistry一元化・Windowsリトライ（withRetry）は既存M1-M3の実装パターンを踏襲し新規逸脱なし。

## developer — M4-R1-01 修正（ラウンド1）

対象: memoFileService.ts（renameMemoFile/duplicateMemoFile/moveMemoFileToFolder/copyMemoFileToFolder）、trash.ts（trashPath/deletePathDirect）。

- 修正: atomicWrite.ts で確立済みの「registerSelfWrite → fs操作 → 失敗時はconsumeSelfWriteで予約解放 → rethrow（trashPathのみ既存どおりerr()で返却）」パターンを、指摘対象の6関数すべてに追加。
  - `renameMemoFile`: `fs.rename`をtry/catchで囲み、失敗時に旧パス（delete予約）・新パス（upsert予約）両方を`consumeSelfWrite`してから`throw e`。
  - `duplicateMemoFile`/`copyMemoFileToFolder`: `fs.copyFile`失敗時に宛先パスを`consumeSelfWrite`してから`throw e`。
  - `moveMemoFileToFolder`: rename+EXDEVフォールバック（copy+unlink）全体を囲むtry/catchで、失敗時に旧パス・宛先パス両方を`consumeSelfWrite`してから`throw e`。
  - `trash.ts trashPath`: 既存のcatch節（`TRASH_FAILED`を返す箇所）に`consumeSelfWrite(absolutePath)`を追加。
  - `trash.ts deletePathDirect`: `fs.unlink`をtry/catchで囲み、失敗時に`consumeSelfWrite`してから`throw e`。
- いずれも`throw e`/`err()`前に予約解放のみを行い、リトライ回数や制御フロー自体（呼び出し元への返り値の型・エラーコード）は変更していない。
- 確認: `npm run typecheck`・`npm run build`ともにエラーなし。作業ツリーへの変更のみでコミット・プッシュはしていない。

## tester — M4（ファイル監視）動作検証（ラウンド1）

対象: reviewer M4 ラウンド1（ブロッキング指摘なし）+ developer M4-R1-01修正後の一式（reviewer再レビューは今回省略、直接tester検証）。npm install / typecheck / build / prod起動 / IPC直叩き+実DOM操作+実際のOSレベルファイル操作（エクスプローラー相当の外部変更・PowerShellによる排他ロックでのfs操作強制失敗）による外部変更検知・自己発火除外・競合ダイアログ/ロック・M4-R1-01修正・メタJSON外部変更・OS生成ファイル除外を検証。

- **判定: 不具合なし。developer への差し戻しなし。M4はコミット判断（ユーザー指示待ち）へ進めてよい。**
- npm install: 成功（`up to date, audited 393 packages`。allow-scripts警告のみ）。
- typecheck: `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json` エラーなし。
- build: `electron-vite build` 成功（`out/main/index.js`(68.00kB)/`out/preload/index.js`(5.10kB)/`out/renderer/assets/index-*.js`(942.25kB)+css）。
- **[Info] 記録のみ（コード不具合ではなくビルド成果物の一過性事象、対応不要）: 検証開始時にリポジトリに残存していた`out/`（developerが直前にビルドした`.gitignore`対象の成果物）で起動したところ、`appSettings`モジュールがバンドル内で2箇所に分裂し（`cached`変数を持つ側と`initAppSettings`本体を持つ側が別インスタンス化）、`cached`が実際には設定されず`bootstrap()`が`getAppSettings not initialized`の未処理Promise例外で失敗しウィンドウが生成されない事象を確認（CDPのpageターゲットが0件）。`rm -rf out && npm run build`でクリーンビルドし直したところ即座に解消し、以降複数回の再ビルド（cleanなし）でも再現しなかった（Rollupの一過性のモジュール重複と推定）。コード自体の欠陥ではなく`out/`という`.gitignore`対象のビルド成果物が古い/不整合な状態で残っていたことによる事象と判断（CIやクリーンチェックアウトでは発生しない）。念のため以降のビルド確認は必ず`rm -rf out`後の状態で実施した。developer/reviewerへの申し送り事項として記録するのみで、差し戻しは行わない。
- prod起動: `--user-data-dir`で隔離したuserDataを使い`electron . --remote-debugging-port=9333`起動（クリーンビルド後）。ログは`DevTools listening`のみでエラーなし。CDPのpageターゲット確認・`document.title`取得で正常起動を確認。
- CDP操作手法: Node組込みの`WebSocket`グローバル（Node 22+）でCDPへ直接接続し`Runtime.evaluate`（`window.api`直叩き・DOM操作・`dispatchEvent(new MouseEvent(...))`によるReactハンドラ起動）と`Input.insertText`（contenteditableへフォーカス後の実文字入力、CodeMirror本文編集）を使用。ws等の外部パッケージ不使用。
- **1. 外部変更検知（evt:externalChange, 最重要）**: タブ登録後、`window.api`を介さず**Node `fs`で直接**（アプリ外からのファイル操作を模した最も直接的な検証）tabAフォルダへ`.txt`を新規作成/内容変更/削除する3パターンを実施。いずれも200msデバウンス後に`evt:externalChange`が正しい`kind`（'add'/'change'/'unlink'）で発火し、`tab:openTree`でツリーへの反映（新規追加/削除）も確認。
- **2. 自己発火除外（selfWriteRegistry）**: アプリ自身のIPC操作（`memo.save`/`memo.rename`/`memo.move`（タブ間移動）/`memo.move copy:true`（タブ間コピー）/`memo.duplicate`（同タブ内複製）/`memo.delete`（既定=ごみ箱送り））を実行するたびに`evt:conflict`/`evt:externalChange`が一切発火しないことを確認（`evt:indexUpdated`は経路①分のみ想定通り発火）。rename/move/duplicate/deleteいずれも自己書き込みとして正しく除外された。
- **3. 編集中メモへの外部変更→競合ダイアログ→ロック（実DOM操作、最重要）**: タブ/メモ行を実際にクリックして開き（`dispatchEvent(new MouseEvent('click'))`でReactのonClickを起動）、`Input.insertText`でCodeMirrorへ実際に文字入力しdirty状態にした上で、当該メモファイルをNode `fs`で直接外部変更。`evt:conflict`が発火し、DOM上に`.confirm-dialog`（「〇〇は編集中に外部（他のアプリ等）で変更されました」）が実際に表示されることを確認。表示中は`.cm-content`の`contenteditable`が`false`（入力ロック）になることも確認。
  - ロック中の保存試行: `保存`ボタン自体は`disabled`属性が付与されない（見た目上は活性のまま）が、クリックしても`handleSave`内部の`conflictInfo`ガードにより実際には何も起きない（ディスク上のファイル内容・ダイアログ表示とも変化なし）ことを実機確認。ロック自体は機能上有効だが、ボタンの見た目が非活性化されない点はUX上の軽微な不整合（**Info、対応不要と判断**。データ破損や誤操作には至らない防御的ガードが機能しているため）。
- **4. 競合解決フロー（両方向）**: 「外部の変更を採用」クリックでダイアログが閉じ本文が外部内容に置き換わり編集可能に復帰（dirty解消・保存ボタン非活性）することを確認。別途dirty+競合状態を再現し「自分の変更を保存」クリックで`expectedHash:undefined`バイパス保存が実行され、ディスク上のファイルが**自分の編集内容**で上書きされる（外部の変更が破棄される）ことを実ファイル確認。いずれの解決後も後続の自己書き込み（保存）が誤ってconflict/externalChangeを再発火しないことも確認。
- **5. M4-R1-01修正の実機確認（rename失敗時のselfWriteRegistry解放、最重要）**: PowerShell（`[System.IO.File]::Open(path,'Open','ReadWrite','None')`、`-ExecutionPolicy Bypass`で別プロセス起動）で対象メモファイルを排他ロックした状態で`memo:rename`をIPC直叩きし、リトライ全滅で`Result{ok:false}`（`UNKNOWN`）になることを確認（rename自体は約800ms〜1秒で失敗、退避先はロック解放直後）。ロック解放直後（登録から2.5秒のTTLが自然失効するより十分前、実測で登録後1.7〜2.4秒の時点）に、**同一パス（旧名）への本物の外部delete**と**リネーム先の名前での本物の外部add**をNode `fs`で直接実行したところ、両方とも即座に`evt:externalChange`（それぞれ`kind:'unlink'`/`kind:'add'`）が正しく発火し、TTL待ちで握りつぶされることがないことを確認。これは修正前の実装であれば「新パスのnull期待値は常にマッチ扱い」「旧パスのdelete期待値はTTLが切れるまで残存」により本来検知すべき外部変更が最大2.5秒握りつぶされ得た箇所であり、修正が実際に機能していることを実機で裏付けた。duplicate/move/copy/trashPath/deletePathDirectは同一パターン（コードレビューで確認済み）だが、copyFile/unlink/trashItemを黒箱的に確実に失敗させる手段（フォルダACL拒否等）は用意が煩雑なため個別の強制失敗テストは実施していない（renameで代表検証、明記のうえ許容と判断）。
- **6. メタJSON（`.tabtreenote.json`）の外部変更検知**: メタJSONをNode `fs`で直接書き換え（`expanded`変更）たところ`evt:externalChange`（`changes:[]`の簡易ペイロード）が発火し、`tab:openTree`再取得で実際に`expanded:false`が反映されることを確認。
- **7. 一時ファイル・`.bak`・OS生成ファイルの監視除外**: `.~tmp~`プレフィックスファイル・`.bak`ファイル・`desktop.ini`・`Thumbs.db`をtabAフォルダへ直接作成しても、いずれも`evt:externalChange`/`evt:conflict`/`evt:indexUpdated`が一切発火しないことを確認。
- **8. 経路②インデックス更新**: 上記1・6・7の検証を通じて、外部変更検知時のみ`evt:indexUpdated`が発火し（メタJSON外部変更・一時ファイル等では発火しない）、自己発火除外時は発火しない（経路①分のみ発火）ことを一貫して確認。
- opError: 検証全体を通じて`evt:opError`は一度も発火せず（意図しない例外が発生していないことの傍証）。
- 後片付け: 検証用一時フォルダ（scratchpad配下、リポジトリ外）・Electron userData（`--user-data-dir`で隔離、リポジトリ外）・PowerShellロック用一時スクリプトを削除済み。検証後`Get-Process electron`/`Get-Process powershell`（自セッション以外）とも0件を確認。
- 外部サービスへの副作用: なし（すべてローカルファイル操作・localhost CDP・ローカルPowerShellプロセスのみ。実運用のAPIキー/Webhook等は使用していない）。
