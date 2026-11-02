import { test } from "node:test";
import assert from "node:assert/strict";

import { extractOptions, normalize, split } from "./questions.ts";

test("kısa soru olduğu gibi kalır", () => {
  const r = split("Kural nerede değerlendirilsin?", "arka plan");
  assert.equal(r.question, "Kural nerede değerlendirilsin?");
  assert.equal(r.context, "arka plan");
});

test("uzun soru bölünür: ilk cümle başlık, son soru cümlesi eklenir, gerisi context", () => {
  // Gerçek örnek: Planner gerekçeyi soruya sıkıştırmıştı (~900 karakter).
  const long =
    "KURAL MOTORU — EN ÜSTTEKİ KARAR. " +
    "Kütüphane LINQ ifadesi üretiyor, Elasticsearch sorgusu değil ve bu ayrım türetilmiş alanlarda kendini gösteriyor. " +
    "Üç seçenek var ve her birinin bedeli farklı bir yerde ortaya çıkıyor, bu yüzden önden seçilmesi gerekiyor. " +
    "Onayın hangisi?";
  const r = split(long, "");
  assert.ok(r.question.length < long.length, "soru kısaltılmadı");
  assert.match(r.question, /KURAL MOTORU/, "başlık kayboldu");
  assert.match(r.question, /Onayın hangisi\?$/, "asıl soru cümlesi eklenmedi");
  assert.match(r.context, /türetilmiş alanlar/, "gerekçe context'e taşınmadı");
});

test("normalize: düz dize, nesne ve bozuk kayıt bir arada", () => {
  const out = normalize([
    "düz dize soru",
    { question: "nesne soru", options: ["A", "B"], recommended: "A", blocksPlan: true },
    { question: "" },       // boş — atlanmalı
    null,                    // bozuk — atlanmalı
    { options: ["x"] },      // sorusuz — atlanmalı
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.question, "düz dize soru");
  assert.deepEqual(out[0]?.options, []);
  assert.equal(out[1]?.blocksPlan, true);
  assert.equal(out[1]?.recommended, "A");
});

test("normalize: dizi olmayan girdi çökmez", () => {
  assert.deepEqual(normalize(undefined), []);
  assert.deepEqual(normalize("metin"), []);
});

test("metne gömülü (A)/(B)/(C) şıkları ayıklanır — gerçek örnek", () => {
  // Ekranda yaşandı: options boş, şıklar gerekçe metninde, insan elle yazıyordu.
  const text =
    "Üç seçenek: (A) MODELİ ondan al, DEĞERLENDİRMEYİ ES'te yap — planın seçtiği yol: türetilmiş alanlar kurala açık kalır. " +
    "(B) Kütüphaneyi Postgres üzerinde doğrudan kullan: çeviri yazılmaz ama o alanlar KURALA GİREMEZ. " +
    "(C) İkisi birden: ES ana yol, LINQ yüklemi tek-ürün üyelik kontrolü için. Onayın hangisi?";
  const opts = extractOptions(text);
  assert.equal(opts.length, 3);
  assert.match(opts[0]?.label ?? "", /^A\)/);
  assert.match(opts[0]?.label ?? "", /MODELİ ondan al/);
  assert.match(opts[1]?.label ?? "", /^B\)/);
  assert.match(opts[2]?.label ?? "", /^C\)/);
  assert.ok((opts[0]?.label ?? "").length <= 95, "etiket düğmeye sığmayacak kadar uzun");
});

test("yanlış ayıklama yapılmaz: tek işaret, sırasız harf, hiç işaret", () => {
  assert.deepEqual(extractOptions("Tek bir (A) referansı var."), []);
  assert.deepEqual(extractOptions("Madde (B) ve sonra (A) geliyor."), [], "sırasız harfler şık değildir");
  assert.deepEqual(extractOptions("Hiç şık yok, düz metin."), []);
});

test("normalize: options boşsa metinden ayıklar, doluysa dokunmaz", () => {
  const embedded = normalize([
    { question: "Hangisi? (A) Birinci yol (B) İkinci yol", options: [] },
  ]);
  assert.equal(embedded[0]?.options.length, 2, "gömülü şıklar ayıklanmadı");

  const declared = normalize([
    { question: "Hangisi? (A) Birinci (B) İkinci", options: ["Kendi şıkkım"] },
  ]);
  assert.deepEqual(declared[0]?.options, ["Kendi şıkkım"], "tanımlı şıklar ezildi");
});
