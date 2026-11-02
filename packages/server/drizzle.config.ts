import type { Config } from "drizzle-kit";

/**
 * Migration üretimi. Dialect bugün SQLite; PostgreSQL'e geçişte yalnız bu satır
 * ve schema.ts'teki tablo yapıcıları değişir — uygulama kodu aynı kalır.
 */
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: process.env.AHTAPOT_DB ?? "./data/ahtapot.sqlite" },
} satisfies Config;
