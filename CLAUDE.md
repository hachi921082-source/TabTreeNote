# TabTreeNote

## ワークフロー

このプロジェクトは4エージェント体制で進める。

1. **designer** — 要件整理・アーキテクチャ設計、spec.md/PLAN.md/DESIGN.md の作成・更新
2. **developer** — designer の設計に基づく実装（コード・設定ファイル等）
3. **reviewer** — developer が実装したコードの静的レビュー（正しさ・セキュリティ・設計適合性。実行検証はしない）
4. **tester** — reviewer 通過後、実際にコードを実行して動作検証

フローの基本順序: designer → developer → reviewer → tester。reviewer/tester で問題が見つかった場合は該当エージェントへ差し戻す。

## 参考資料

- [spec.md](spec.md) に類似アプリ（猫メモノート）の参考URLあり
