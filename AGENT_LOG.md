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
