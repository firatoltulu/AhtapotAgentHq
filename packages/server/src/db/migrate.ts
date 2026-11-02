import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { openDb } from "./index.js";

/** Migration'ları uygular. Sunucu açılışında ve `npm run db:migrate` ile koşar. */
export function runMigrations(dbPath?: string): void {
  const { db, sqlite, file } = openDb(dbPath);
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/db/migrate.js → paket kökü → drizzle/
  const folder = join(here, "..", "..", "drizzle");
  migrate(db, { migrationsFolder: folder });
  sqlite.close();
  console.log(`migration tamam: ${file}`);
}

// Doğrudan çalıştırıldıysa koş. Windows yollarını da doğru karşılaştırmak için
// argümanı file:// URL'ine çeviriyoruz — ters eğik çizgi/ileri eğik çizgi farkı
// string karşılaştırmasını sessizce bozar.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runMigrations();
}
