import test from "node:test";
import assert from "node:assert/strict";

import { parseDiff } from "./parseDiff.ts";

/**
 * Diff ayrıştırıcısı testleri.
 *
 * Ölçüt: testin bir kusuru yakalayabilmesi. Buradaki riskler gerçek —
 * satır numaralarının hunk başlığından yeniden başlaması, `+++`/`---`
 * başlıklarının değişiklik sanılması, yeni/silinmiş dosyanın işaretlenmesi.
 */

test("değişmiş dosyada satır numaraları hunk başlığından sayılır", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -12,3 +12,4 @@ export function f()",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
  ].join("\n");

  const files = parseDiff(patch);
  assert.equal(files.length, 1);
  const f = files[0]!;
  assert.equal(f.path, "src/a.ts");
  assert.equal(f.mark, "M");
  assert.equal(f.added, 2);
  assert.equal(f.removed, 1);

  // `---`/`+++` başlıkları gövdeye girmemeli: girerse added/removed şişer.
  const kinds = f.lines.map((l) => l.kind);
  assert.deepEqual(kinds, ["hunk", "ctx", "del", "add", "add"]);

  // Bağlam satırı hunk'ın başladığı numarayı alır.
  assert.equal(f.lines[1]!.old, 12);
  assert.equal(f.lines[1]!.neu, 12);
  // Silinen satır yalnız eski numarayı, eklenen yalnız yeniyi taşır.
  assert.equal(f.lines[2]!.old, 13);
  assert.equal(f.lines[2]!.neu, null);
  assert.equal(f.lines[3]!.old, null);
  assert.equal(f.lines[3]!.neu, 13);
});

test("yeni ve silinmiş dosya işaretlenir", () => {
  const patch = [
    "diff --git a/yeni.ts b/yeni.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/yeni.ts",
    "@@ -0,0 +1,2 @@",
    "+satir1",
    "+satir2",
    "diff --git a/eski.ts b/eski.ts",
    "deleted file mode 100644",
    "--- a/eski.ts",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "-gitti",
  ].join("\n");

  const files = parseDiff(patch);
  assert.equal(files.length, 2);
  assert.equal(files[0]!.mark, "+");
  assert.equal(files[0]!.added, 2);
  assert.equal(files[1]!.mark, "−");
  assert.equal(files[1]!.removed, 1);
});

test("birden çok hunk: sayaç her başlıkta sıfırlanmaz, başlıktaki değere atlar", () => {
  const patch = [
    "diff --git a/x.ts b/x.ts",
    "@@ -1,2 +1,2 @@",
    " bir",
    "-iki",
    "+IKI",
    "@@ -40,2 +40,2 @@",
    " kirk",
    "-kirkbir",
    "+KIRKBIR",
  ].join("\n");

  const f = parseDiff(patch)[0]!;
  const second = f.lines.findIndex((l) => l.kind === "hunk" && l.text.includes("-40"));
  assert.equal(f.lines[second + 1]!.old, 40, "ikinci hunk 40'tan başlamalı");
  assert.equal(f.added, 1 + 1);
  assert.equal(f.removed, 1 + 1);
});

test("yeniden adlandırmada hedef ad okunur", () => {
  const patch = [
    "diff --git a/old/name.ts b/new/name.ts",
    "similarity index 95%",
    "rename from old/name.ts",
    "rename to new/name.ts",
  ].join("\n");

  const f = parseDiff(patch)[0]!;
  assert.equal(f.path, "new/name.ts");
  assert.equal(f.lines.length, 0, "gövdesiz blok satır üretmemeli");
});

test("'\\ No newline' satırı sayaçlara girmez", () => {
  const patch = [
    "diff --git a/n.ts b/n.ts",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
    "\\ No newline at end of file",
  ].join("\n");

  const f = parseDiff(patch)[0]!;
  assert.equal(f.added, 1);
  assert.equal(f.removed, 1);
  assert.ok(!f.lines.some((l) => l.text.startsWith("\\")));
});

test("boş patch dosya üretmez", () => {
  assert.deepEqual(parseDiff(""), []);
});

test("hunk gövdesindeki '+++' ve '---' satırları başlık sanılmaz", () => {
  // Bir markdown dosyasına yatay çizgi ve diff örneği eklenmesi — gerçek senaryo.
  const patch = [
    "diff --git a/README.md b/README.md",
    "index 1111111..2222222 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,2 +1,4 @@",
    " başlık",
    "+++ vurgulu satır",
    "--- ayraç",
    " son",
  ].join("\n");
  const [file] = parseDiff(patch);
  assert.equal(file?.added, 1, "gövdedeki '+++' eklenen satır sayılmalı");
  assert.equal(file?.removed, 1, "gövdedeki '---' silinen satır sayılmalı");
  const texts = file!.lines.filter((l) => l.kind !== "hunk").map((l) => l.text);
  assert.deepEqual(texts, ["başlık", "++ vurgulu satır", "-- ayraç", "son"]);
});

test("patch sonundaki boş satır sahte bağlam satırı üretmez", () => {
  // `git diff` çıktısı \n ile biter; son boş satır numaralandırılmamalı.
  const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n satır\n+yeni\n";
  const [file] = parseDiff(patch);
  assert.deepEqual(file!.lines.filter((l) => l.kind === "ctx").map((l) => l.text), ["satır"]);
  assert.equal(file?.added, 1);
});
