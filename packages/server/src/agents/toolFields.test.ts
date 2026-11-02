import { test } from "node:test";
import assert from "node:assert/strict";

import { diffLines, toolFields } from "./toolFields.js";

/**
 * Araç alanı çıkarımı.
 *
 * Kusur yakalaması beklenen yer: `Edit` girdisinin farka çevrilmesi. Akışta
 * ham JSON basılmasının sebebi buydu ve çıkarım sessizce boş dönerse kusur
 * geri gelir — "diff boş" ile "diff yok" UI'da aynı görünür.
 */

test("diffLines ortak ön ve son eki atar", () => {
  const diff = diffLines("a\nb\nc\n", "a\nX\nc\n");
  assert.deepEqual(diff, [
    ["-", "b"],
    ["+", "X"],
  ]);
});

test("diffLines yalnız ekleme yapılan değişikliği eksiksiz gösterir", () => {
  const diff = diffLines("a\nc\n", "a\nb\nc\n");
  assert.deepEqual(diff, [["+", "b"]]);
});

test("diffLines dosya sonundaki yeni satırı fark saymaz", () => {
  assert.deepEqual(diffLines("a\n", "a\n"), []);
  assert.deepEqual(diffLines("a", "a\n"), []);
});

test("Edit farkı üretir ve +/− sayar", () => {
  const f = toolFields("Edit", {
    file_path: "C:\\src\\northwind\\src\\App.tsx",
    old_string: "const a = 1;\nconst b = 2;",
    new_string: "const a = 1;\nconst b = 3;\nconst c = 4;",
    replace_all: false,
  });
  assert.equal(f.file, "C:\\src\\northwind\\src\\App.tsx");
  assert.deepEqual(f.diff, [
    ["-", "const b = 2;"],
    ["+", "const b = 3;"],
    ["+", "const c = 4;"],
  ]);
  assert.deepEqual(f.meta, ["+2 −1"]);
});

test("replace_all çipi yalnız açıkken yazılır", () => {
  const on = toolFields("Edit", { file_path: "a.ts", old_string: "x", new_string: "y", replace_all: true });
  assert.ok(on.meta.includes("replace_all: evet"));
  const off = toolFields("Edit", { file_path: "a.ts", old_string: "x", new_string: "y", replace_all: false });
  assert.ok(!off.meta.some((m) => m.startsWith("replace_all")));
});

test("Write tüm içeriği eklenmiş sayar", () => {
  const f = toolFields("Write", { file_path: "yeni.ts", content: "bir\niki\n" });
  assert.deepEqual(f.diff, [
    ["+", "bir"],
    ["+", "iki"],
  ]);
  assert.deepEqual(f.meta, ["2 satır yazıldı"]);
});

test("Read kısmi okumayı tam okumadan ayırır", () => {
  const partial = toolFields("Read", { file_path: "a.cs", offset: 40, limit: 56 });
  assert.deepEqual(partial.meta, ["satır 40–96 okundu"]);
  const full = toolFields("Read", { file_path: "a.cs" });
  assert.deepEqual(full.meta, []);
  assert.equal(full.file, "a.cs");
});

test("Bash komutu ve dizini ham taşır", () => {
  const f = toolFields("Bash", { command: "npm run build", cwd: "/w/Northwind" });
  assert.equal(f.command, "npm run build");
  assert.equal(f.cwd, "/w/Northwind");
  assert.deepEqual(f.diff, []);
});

/**
 * Tanınmayan araçta hiçbir alan uydurulmaz: UI o zaman `inputSummary`ye düşer.
 * Yanlış çıkarım, çıkarmamaktan kötüdür.
 */
test("tanınmayan araç boş varsayılan döner", () => {
  const f = toolFields("mcp__something__query", { sql: "select 1" });
  assert.equal(f.file, undefined);
  assert.equal(f.command, undefined);
  assert.deepEqual(f.meta, []);
  assert.deepEqual(f.diff, []);
});

test("girdi nesne değilse çökmez", () => {
  assert.deepEqual(toolFields("Edit", null).diff, []);
  assert.deepEqual(toolFields("Edit", "metin").diff, []);
});

/** Fark satırı çok uzunsa kutu yatay kaymasın diye kesilir. */
test("uzun fark satırı kesilir", () => {
  const long = "x".repeat(900);
  const f = toolFields("Edit", { file_path: "a.ts", old_string: "", new_string: long });
  const first = f.diff[0];
  assert.ok(first);
  assert.ok(first[1].length < 900);
  assert.ok(first[1].endsWith("…"));
});
