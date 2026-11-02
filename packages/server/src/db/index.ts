import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase, RunResult } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { v7 as uuidv7 } from "uuid";

import { BRAND } from "@ahtapot/shared";
import * as schema from "./schema.js";

export { schema };

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * Sorgu yürütücü: ya veritabanının kendisi ya da açık bir transaction.
 *
 * Aynı bağlantıda iç içe `db.transaction` SQLite'ta "cannot start a transaction
 * within a transaction" ile düşer. Bu yüzden bir transaction içinde yazması
 * gereken yardımcılar (olay sırası, olay kaydı) `tx`i parametre alır.
 */
export type Executor = BaseSQLiteDatabase<"sync", RunResult, typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: SqliteDatabase;
  file: string;
}

/**
 * Veritabanını açar.
 *
 * WAL zorunlu: orkestratör aynı anda bir işi yazarken UI başka bir işi okuyor.
 * Rollback journal'da okuyucu yazarı bloklar ve panel donuk görünür.
 *
 * `busy_timeout`: SQLITE_BUSY'yi hatayla değil beklemeyle karşıla — eşzamanlı
 * iş sayısı arttıkça kısa kilit çakışmaları normaldir.
 *
 * `foreign_keys`: SQLite'ta VARSAYILAN KAPALIDIR. Açılmazsa `references()`
 * tanımları belge olmaktan öteye geçmez ve yetim satırlar sessizce birikir.
 */
export function openDb(dbPath?: string): DbHandle {
  const file = resolve(dbPath ?? process.env.AHTAPOT_DB ?? `./data/${BRAND.dbFileName}`);
  mkdirSync(dirname(file), { recursive: true });

  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  // Dayanıklılık ile hız arasında: WAL + NORMAL, güç kesintisinde son işlemi
  // kaybedebilir ama bozulma üretmez. Orkestratör durumu zaten yeniden kurar.
  sqlite.pragma("synchronous = NORMAL");

  const db = drizzle(sqlite, { schema });
  return { db, sqlite, file };
}

/**
 * Birincil anahtar üreteci.
 *
 * UUIDv7 zaman sıralıdır: hem taşınabilir (SQLite↔PG) hem de B-tree index'te
 * artan anahtar gibi davranır. Rastgele v4 kullanmak büyük tablolarda index
 * parçalanmasına yol açardı.
 */
export const newId = (): string => uuidv7();

/** ISO-8601 UTC — şemadaki tüm zaman alanlarının biçimi. */
export const isoNow = (): string => new Date().toISOString();

/** Dolar → mikro-dolar. Para her yerde tam sayı olarak taşınır. */
export const toMicroUsd = (usd: number): number => Math.round(usd * 1_000_000);
export const fromMicroUsd = (micro: number): number => micro / 1_000_000;
