// src/main/util/migrate.ts
// スキーマバージョン（`schemaVersion`）マイグレーション土台（M7, DESIGN §3.2「メタ情報の
// バージョニング」/ PLAN §7 M7「schemaVersion/appVersion マイグレーション土台」）。
//
// v1（`SCHEMA_VERSION`=1）のみが存在する現時点では実際に適用すべき変換ステップは無い。
// 本モジュールは「読み込んだ JSON の schemaVersion を判定し、現行版まで変換ステップを順に
// 適用してから使う」という将来のマイグレーション追加のための共通の型・関数の置き場所を
// 用意しておくもの（実体は現状 no-op）。将来 schemaVersion を引き上げる際は、`steps` 配列へ
// `vN → vN+1` の変換関数を追記するだけで済むようにする。
import { SCHEMA_VERSION } from '@shared/constants';

/** 個々のマイグレーションステップ: `fromVersion` のデータを `fromVersion + 1` 相当へ変換する。 */
export type MigrationStep<T> = (data: T) => T;

/**
 * `data.schemaVersion` を現行 `SCHEMA_VERSION` まで順に引き上げる。
 * `steps[i]` は「`i+1` → `i+2`」への変換を表す（`steps` は空でもよい＝現行スキーマがそのまま
 * 最新の v1 の場合）。読み込んだ `schemaVersion` が現行より新しい場合（将来バージョンのアプリで
 * 保存されたデータを、より旧いアプリで開いた場合）はダウングレード変換を行わず、そのまま返す
 * （v1 スコープ外の既知の制限。内部ログにのみ警告を残す, 00-core-principles.md §10）。
 */
export function migrateSchema<T extends { schemaVersion: number }>(data: T, steps: readonly MigrationStep<T>[]): T {
  if (data.schemaVersion >= SCHEMA_VERSION) {
    if (data.schemaVersion > SCHEMA_VERSION) {
      // eslint-disable-next-line no-console -- 内部診断ログ（00-core-principles.md §10 Fix8）
      console.error(
        `[main] schemaVersion ${data.schemaVersion} は現行アプリ（${SCHEMA_VERSION}）より新しいデータです。変換せずそのまま読み込みます。`
      );
    }
    return data;
  }
  let migrated = data;
  for (let v = data.schemaVersion; v < SCHEMA_VERSION; v++) {
    const step = steps[v - 1];
    if (!step) break; // 対応する変換ステップが未実装（v1 のみの現状はこの分岐に到達しない）。
    migrated = { ...step(migrated), schemaVersion: v + 1 };
  }
  return migrated;
}
