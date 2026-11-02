import { test } from "node:test";
import assert from "node:assert/strict";

import { TriageDocumentSchema, TriageSchema, type ModelTier, type Triage, type TriageDocument } from "@ahtapot/shared";

import { bumpTier, chooseModel, clampToMaxTier, deriveTier, parseTriage, resolveTier } from "./triage.js";

/**
 * Triage motoru — model seçiminin saf mantığı.
 *
 * Buradaki her test para kaybettiren bir kusuru hedefler: ters eşik, uygulanmayan
 * tavan, sessizce onaysız seçilen pahalı model, triage çökünce işin de çökmesi.
 */

/** Varsayılanlı boş profil yapılandırması. */
function cfg(over: Partial<Triage> = {}): Triage {
  return { ...TriageSchema.parse({}), ...over };
}

/** Varsayılanlı boş triage belgesi; testler yalnız ilgilendikleri alanı verir. */
function doc(over: Record<string, unknown> = {}): TriageDocument {
  return TriageDocumentSchema.parse({
    stage: "intake",
    recommendedTier: "cheap",
    rationale: "test",
    ...over,
  });
}

// ── Şema toleransı ───────────────────────────────────────────────────────────

test("şema: karar alanları dışında her şey eksik olabilir", () => {
  // Haiku KESİNLİKLE eksik alan üretecek. Bir alana `.default()` koymayı
  // unutmak, triage'ı hiç çalışmaz hâle getirirdi.
  const parsed = TriageDocumentSchema.safeParse({
    stage: "intake",
    recommendedTier: "standard",
    rationale: "iki katman, şema değişikliği yok",
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.deepEqual(parsed.data.scope.layers, []);
  assert.equal(parsed.data.scope.schemaChange.level, "unknown");
  assert.equal(parsed.data.confidence, "medium");
  assert.deepEqual(parsed.data.acceptanceCriteria, []);
});

test("şema: uydurma seviye reddedilir", () => {
  // Enum'u `z.string()` yapma cazibesine karşı: geçersiz bir model adı
  // runner'a gitseydi koşu API hatasıyla düşerdi.
  const parsed = TriageDocumentSchema.safeParse({
    stage: "intake",
    recommendedTier: "gpt-5",
    rationale: "x",
  });
  assert.equal(parsed.success, false);
});

// ── Türetme eşikleri ─────────────────────────────────────────────────────────

test("türetme: ağır iş cheap DÖNMEZ", () => {
  // Eşikte ters karşılaştırma en pahalı kusur: dört katmanlı, şema değiştiren,
  // race condition riskli bir iş Haiku'ya giderse iş baştan koşar.
  const heavy = doc({
    scope: {
      layers: ["db", "api", "ui", "auth"],
      schemaChange: { level: "high" },
      multiTenantImpact: { level: "high" },
      estimatedFiles: 14,
    },
    ambiguity: { overall: { level: "high" }, vaguePhrases: ["olsa güzel olur", "bazen"] },
    risk: { irreversible: { level: "high" }, concurrency: { level: "high" }, changeKind: "breaking" },
  });
  const tier = deriveTier(heavy);
  assert.notEqual(tier, "cheap");
  assert.ok(tier === "deep" || tier === "frontier", `beklenmedik seviye: ${tier}`);
});

test("türetme: tek dosyalık net iş cheap", () => {
  const trivial = doc({
    scope: { layers: ["ui"], schemaChange: { level: "none" }, multiTenantImpact: { level: "none" }, estimatedFiles: 1 },
    ambiguity: { overall: { level: "none" } },
    risk: { irreversible: { level: "none" }, concurrency: { level: "none" }, changeKind: "additive" },
  });
  assert.equal(deriveTier(trivial), "cheap");
});

test("türetme: emsal varlığı seviyeyi DÜŞÜREBİLİR", () => {
  const base = {
    scope: { layers: ["api", "ui"], schemaChange: { level: "none" }, multiTenantImpact: { level: "none" }, estimatedFiles: 3 },
    ambiguity: { overall: { level: "low" } },
    risk: { irreversible: { level: "none" }, concurrency: { level: "none" }, changeKind: "additive" },
  };
  const without = deriveTier(doc(base));
  const withPrecedent = deriveTier(doc({
    ...base,
    history: { similarPrecedent: "aynısı ProductController'da var" },
  }));
  // Emsal iş kolaylaştırır; en azından seviyeyi yükseltmemeli.
  assert.ok(
    (["cheap", "standard", "deep", "frontier"] as ModelTier[]).indexOf(withPrecedent)
      <= (["cheap", "standard", "deep", "frontier"] as ModelTier[]).indexOf(without),
  );
});

test("türetme: `unknown` sinyal sıfır SAYILMAZ", () => {
  // Model "emin değilim" dediğinde bunu "sorun yok" saymak, tam da ölçemediği
  // için ucuza gönderilmemesi gereken işi ucuza gönderir.
  const allNone = doc({
    scope: { layers: ["api"], schemaChange: { level: "none" }, multiTenantImpact: { level: "none" } },
    ambiguity: { overall: { level: "none" } },
    risk: { irreversible: { level: "none" }, concurrency: { level: "none" } },
  });
  // Varsayılan belge her sinyali `unknown` bırakır.
  const allUnknown = doc({ scope: { layers: ["api"] } });
  const order: ModelTier[] = ["cheap", "standard", "deep", "frontier"];
  assert.ok(order.indexOf(deriveTier(allUnknown)) > order.indexOf(deriveTier(allNone)));
});

// ── Güven ve tavan ───────────────────────────────────────────────────────────

test("düşük güven seviyeyi YUKARI yuvarlar", () => {
  // Yukarı yuvarlamayı unutmak ya da ters yöne yapmak: model kendi kararına
  // güvenmiyorken biz güvenmiş oluruz.
  const body = {
    scope: { layers: ["api", "ui"], estimatedFiles: 4 },
    risk: { concurrency: { level: "low" } },
  };
  const order: ModelTier[] = ["cheap", "standard", "deep", "frontier"];
  const mid = resolveTier(doc({ ...body, confidence: "medium" }), cfg()).tier;
  const low = resolveTier(doc({ ...body, confidence: "low" }), cfg()).tier;
  assert.ok(order.indexOf(low) >= order.indexOf(mid), `low=${low} mid=${mid}`);
});

test("maxTier kör freni: triage frontier dese de kırpılır", () => {
  // Bütçe freninin uygulanmaması doğrudan para kaybıdır.
  const heavy = doc({
    recommendedTier: "frontier",
    scope: { layers: ["db", "api", "ui", "auth"], schemaChange: { level: "high" }, estimatedFiles: 20 },
    risk: { irreversible: { level: "high" }, concurrency: { level: "high" }, changeKind: "breaking" },
  });
  const { tier } = resolveTier(heavy, cfg({ maxTier: "standard" }));
  assert.equal(tier, "standard");
});

test("öneri ile türetme ayrışırsa PAHALI olan kazanır", () => {
  // Yanlış ucuz seçimin bedeli (başarısız iş + yeniden koşma) yanlış pahalı
  // seçiminkinden yüksek.
  const light = doc({
    recommendedTier: "deep",
    rationale: "modelin içgüdüsü",
    scope: { layers: ["ui"], schemaChange: { level: "none" }, estimatedFiles: 1 },
    ambiguity: { overall: { level: "none" } },
    risk: { irreversible: { level: "none" }, concurrency: { level: "none" } },
  });
  assert.equal(deriveTier(light), "cheap");
  assert.equal(resolveTier(light, cfg()).tier, "deep");
});

test("clampToMaxTier ve bumpTier sınırlarda taşmaz", () => {
  assert.equal(clampToMaxTier("frontier", "cheap"), "cheap");
  assert.equal(clampToMaxTier("cheap", "frontier"), "cheap");
  assert.equal(bumpTier("frontier"), "frontier");
  assert.equal(bumpTier("cheap", 2), "deep");
});

// ── Onay eşiği ───────────────────────────────────────────────────────────────

test("approvalRequiredFrom: frontier onay ister, deep istemez", () => {
  // Fable'ın sessizce onaysız seçilmesi, bütçe kontrolünü anlamsız kılardı.
  const c = cfg({ approvalRequiredFrom: "frontier" });
  const heavy = doc({
    recommendedTier: "frontier",
    scope: { layers: ["db", "api", "ui", "auth"], schemaChange: { level: "high" }, estimatedFiles: 20 },
    risk: { irreversible: { level: "high" }, concurrency: { level: "high" }, changeKind: "breaking" },
  });
  assert.equal(resolveTier(heavy, c).requiresApproval, true);

  const mid = doc({ recommendedTier: "deep", scope: { layers: ["api", "ui"] } });
  assert.equal(resolveTier(mid, c).requiresApproval, false);
});

test("approvalRequiredFrom null ise onay hiç istenmez", () => {
  const c = cfg({ approvalRequiredFrom: null });
  const heavy = doc({ recommendedTier: "frontier", risk: { irreversible: { level: "high" }, concurrency: { level: "high" } } });
  assert.equal(resolveTier(heavy, c).requiresApproval, false);
});

test("maxTier onayı gereksiz kılar: kırpma ÖNCE, eşik SONRA", () => {
  // Tavan zaten frontier'ı engellemişse insana sorulacak bir şey kalmaz.
  const c = cfg({ maxTier: "deep", approvalRequiredFrom: "frontier" });
  const heavy = doc({
    recommendedTier: "frontier",
    scope: { layers: ["db", "api", "ui", "auth"], schemaChange: { level: "high" }, estimatedFiles: 20 },
    risk: { irreversible: { level: "high" }, concurrency: { level: "high" }, changeKind: "breaking" },
  });
  const r = resolveTier(heavy, c);
  assert.equal(r.tier, "deep");
  assert.equal(r.requiresApproval, false);
});

// ── Merdiven eşlemesi ────────────────────────────────────────────────────────

test("chooseModel: seviye profildeki modele düşer", () => {
  const light = doc({
    scope: { layers: ["ui"], schemaChange: { level: "none" }, estimatedFiles: 1 },
    ambiguity: { overall: { level: "none" } },
    risk: { irreversible: { level: "none" }, concurrency: { level: "none" } },
  });
  const choice = chooseModel(light, cfg());
  assert.ok(choice);
  assert.equal(choice.tier, "cheap");
  assert.equal(choice.model, "claude-haiku-5-5");
  assert.equal(choice.effort, "medium");
});

test("chooseModel: varsayılan merdiven bugünkü davranışı korur (deep = opus/high)", () => {
  // Merdiven varsayılanı bugünkü Planner/Developer ayarından SAPMAMALI;
  // sapsaydı triage açıldığı anda her iş sessizce model değiştirirdi.
  const c = cfg();
  assert.equal(c.ladder.deep?.model, "claude-opus-5-5");
  assert.equal(c.ladder.deep?.effort, "high");
});

test("chooseModel: merdiven boşsa null döner (rol sabit modelinde kalır)", () => {
  const choice = chooseModel(doc(), cfg({ ladder: {} }));
  assert.equal(choice, null);
});

// ── Üç katmanlı doğrulama ────────────────────────────────────────────────────

test("parseTriage: blok yoksa null — ÇAĞIRAN fallback'e düşer, iş ÖLMEZ", () => {
  // Bu planın en önemli güvencesi: triage bir danışmandır, çökmesi işi
  // öldürmemeli. `null` dönüşü çağıranın `fallbackTier`a düşmesini sağlar.
  assert.equal(parseTriage(null, "intake"), null);
  assert.equal(parseTriage("düz metin", "intake"), null);
  assert.equal(parseTriage(undefined, "intake"), null);
});

test("parseTriage: karar alanları eksikse ÖLÇÜMLER kurtarılır, tier türetilir", () => {
  // Ölçümün kendisi değerli; `recommendedTier` yazılmadı diye belgeyi çöpe
  // atmak, ödenmiş bir turu boşa harcamak olurdu.
  const out = parseTriage({
    scope: { layers: ["db", "api", "ui", "auth"], schemaChange: { level: "high" }, estimatedFiles: 15 },
    risk: { irreversible: { level: "high" }, concurrency: { level: "high" }, changeKind: "breaking" },
    ambiguity: { overall: { level: "high" } },
  }, "postplan");

  assert.ok(out, "ölçümler kurtarılmadı");
  assert.equal(out.synthesized, true);
  assert.equal(out.doc.stage, "postplan");
  assert.deepEqual(out.doc.scope.layers, ["db", "api", "ui", "auth"]);
  assert.notEqual(out.doc.recommendedTier, "cheap");
  assert.match(out.doc.rationale, /sentezledi/);
});

test("parseTriage: stage çağırandan gelir, modelin yazdığı EZİLİR", () => {
  // Model yanlış stage yazarsa kayıt yanlış yere bağlanırdı.
  const out = parseTriage({ stage: "intake", recommendedTier: "standard", rationale: "x" }, "postplan");
  assert.ok(out);
  assert.equal(out.doc.stage, "postplan");
  assert.equal(out.synthesized, false);
});
