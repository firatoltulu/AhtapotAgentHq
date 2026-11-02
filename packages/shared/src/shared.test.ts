import { test } from "node:test";
import assert from "node:assert/strict";

import { ProjectProfileSchema, TriageSchema } from "./profile.js";
import {
  canTransition,
  ALLOWED_TRANSITIONS,
  REOPEN_TARGETS,
  JOB_STATES,
  MODEL_TIER_ORDER,
  PlanGatePayloadSchema,
  TriageDocumentSchema,
} from "./job.js";
import { scrubSecrets, containsSecret, logTail } from "./secrets.js";
import { containerName, networkName, liveSubdomain, BRAND } from "./brand.js";
import { jobIdValues, resolveEnvPlaceholders, resolveJobPlaceholders } from "./placeholders.js";

/** Sınanan her şeyin dayandığı en küçük geçerli profil. */
function minimalProfile() {
  return ProjectProfileSchema.parse({
    version: 1,
    slug: "northwind",
    name: "Northwind",
    workspace: {
      root: "C:/src/northwind",
      rootIsRepo: true,
      repos: [{ name: "Northwind", path: ".", defaultBranch: "main", primary: true }],
    },
    exec: { image: "ahtapot/exec-dotnet10:latest" },
    build: { steps: [{ name: "dotnet", run: "dotnet build Northwind.slnx -c Debug" }] },
  });
}

test("profil: verilmeyen bölümler varsayılanlarıyla dolar", () => {
  const p = minimalProfile();
  assert.equal(p.exec.resources.memory, "8g");
  assert.equal(p.limits.maxLoops.build, 3);
  assert.equal(p.test.baseline, true);
});

test("profil: güvenlik varsayılanları kısıtlayıcı taraftadır", () => {
  const p = minimalProfile();
  // Log okuma serbest bırakılamaz: .run/ gibi dizinler canlı token taşıyor.
  assert.equal(p.security.logReadPolicy, "targeted");
  // Review dış süreçtir; agent kendiliğinden tetiklemez.
  assert.equal(p.workflow.review.autoTrigger, false);
  // Kendiliğinden commit yasak; onay o yasağı kaldırır.
  assert.equal(p.workflow.commitPolicy, "onApproval");
});

test("profil: slug Docker nesne adına uygun olmalı", () => {
  const bad = { ...minimalProfile(), slug: "Northwind Projesi" };
  assert.throws(() => ProjectProfileSchema.parse(bad));
});

test("durum makinesi: geri adımlar Developing'e döner", () => {
  assert.ok(canTransition("Building", "Developing"), "kırmızı build");
  assert.ok(canTransition("LiveTest", "Developing"), "canlı testte kusur");
  assert.ok(canTransition("QA", "Developing"), "test kırmızı");
  assert.ok(canTransition("PRReview", "Developing"), "PR reddi");
});

test("durum makinesi: terminal durumlardan çıkış yok", () => {
  // Done yalnız insanın yeniden açtığı adımlara döner; iptal ve Draft yok.
  assert.ok(!canTransition("Done", "Cancelled"));
  assert.ok(!canTransition("Done", "Draft"));
  assert.ok(!canTransition("Done", "Building"));
  assert.ok(!canTransition("Cancelled", "Planning"));
  assert.ok(!canTransition("Cancelled", "NeedsAttention"));
});

test("durum makinesi: Done seçilen adımdan yeniden açılabilir", () => {
  for (const s of REOPEN_TARGETS) assert.ok(canTransition("Done", s), `Done → ${s}`);
});

test("durum makinesi: aşama atlanamaz", () => {
  assert.ok(!canTransition("Draft", "QA"));
  assert.ok(!canTransition("Planning", "Developing"), "plan onayı zorunlu");
});

test("durum makinesi: NeedsAttention her çalışan durumdan erişilebilir", () => {
  for (const s of JOB_STATES) {
    if (s === "Done" || s === "Cancelled" || s === "NeedsAttention") continue;
    assert.ok(canTransition(s, "NeedsAttention"), `${s} → NeedsAttention`);
  }
});

test("durum makinesi: her durumun geçiş tablosunda karşılığı var", () => {
  for (const s of JOB_STATES) {
    assert.ok(Array.isArray(ALLOWED_TRANSITIONS[s]), `${s} tanımsız`);
  }
});

test("sır maskeleme: JWT gövdesi sızmaz", () => {
  // Northwind'de .run/at.txt tam olarak bu biçimde canlı bir token taşıyor.
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.s3cr3tS1gnatur3";
  const out = scrubSecrets(jwt);
  assert.ok(!out.includes("s3cr3tS1gnatur3"));
  assert.ok(containsSecret(jwt));
});

test("sır maskeleme: bilinen token önekleri", () => {
  assert.ok(!scrubSecrets("sk-ant-oat01-GIZLIDEGER").includes("GIZLIDEGER"));
  assert.ok(!scrubSecrets("ghp_AAAABBBBCCCCDDDD").includes("BBBBCCCCDDDD"));
  assert.ok(!scrubSecrets("AKIAIOSFODNN7EXAMPLE").includes("IOSFODNN7EXAMPLE"));
});

test("sır maskeleme: bağlantı dizesi parolası", () => {
  const conn = "Host=db;Port=5432;Database=northwind;Username=postgres;Password=hunter2";
  const out = scrubSecrets(conn);
  assert.ok(!out.includes("hunter2"));
  assert.ok(out.includes("Database=northwind"), "parola dışı bilgi korunur");
});

test("sır maskeleme: temiz metne dokunmaz", () => {
  const line = "Registered 218 endpoints";
  assert.equal(scrubSecrets(line), line);
  assert.ok(!containsSecret(line));
});

test("logTail: boyutu sınırlar ve maskeler", () => {
  const noise = "x".repeat(5000);
  const out = logTail(`${noise}\nsk-ant-oat01-GIZLI`, 1000);
  assert.ok(out.length <= 1000);
  assert.ok(!out.includes("GIZLI"));
});

test("marka: Docker adları tek kaynaktan türer", () => {
  assert.equal(containerName.agent("job-1"), `${BRAND.slug}-agent-job-1`);
  assert.equal(containerName.live("job-1"), `${BRAND.slug}-live-job-1`);
  assert.equal(networkName("job-1"), `${BRAND.slug}-net-job-1`);
});

test("liveSubdomain: deterministik ve jobId'yi doğrudan taşımaz", () => {
  const a = liveSubdomain("job-1");
  const b = liveSubdomain("job-1");
  assert.equal(a, b);
  assert.match(a, /^job-[0-9a-f]{8}$/);
  assert.notEqual(liveSubdomain("job-1"), liveSubdomain("job-2"));
});

// ── Triage şeması ────────────────────────────────────────────────

test("triage şeması: karar alanları dışında her şey eksik olabilir", () => {
  // Ucuz model KESİNLİKLE eksik alan üretecek. Bir alana `.default()` koymayı
  // unutmak triage'ı hiç çalışmaz hâle getirirdi.
  const parsed = TriageDocumentSchema.safeParse({
    stage: "intake",
    recommendedTier: "standard",
    rationale: "iki katman, şema değişikliği yok",
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.deepEqual(parsed.data.scope.layers, []);
  assert.equal(parsed.data.scope.schemaChange.level, "unknown");
  assert.equal(parsed.data.risk.changeKind, "unknown");
  assert.equal(parsed.data.confidence, "medium");
  assert.deepEqual(parsed.data.acceptanceCriteria, []);
  assert.deepEqual(parsed.data.history.touchedFiles, []);
});

test("triage şeması: uydurma seviye reddedilir", () => {
  // Enum'u `z.string()` yapma cazibesine karşı: geçersiz bir model adı
  // runner'a gitseydi koşu API hatasıyla düşerdi.
  assert.equal(
    TriageDocumentSchema.safeParse({ stage: "intake", recommendedTier: "gpt-5", rationale: "x" }).success,
    false,
  );
  // Geçerli dört değer kabul edilir.
  for (const tier of MODEL_TIER_ORDER) {
    assert.ok(TriageDocumentSchema.safeParse({ stage: "intake", recommendedTier: tier, rationale: "x" }).success, tier);
  }
});

test("triage şeması: gerekçesiz belge reddedilir", () => {
  // Seçimin nedeni sonradan sorulabilmeli; boş gerekçe denetim izini değersiz kılar.
  assert.equal(
    TriageDocumentSchema.safeParse({ stage: "intake", recommendedTier: "deep", rationale: "" }).success,
    false,
  );
});

test("merdiven şeması: KISMİ — iki basamaklı profil geçerli", () => {
  // Bir proje yalnız `standard` ve `deep` tanımlayıp uçları boş bırakabilmeli.
  // Zorunlu tam kayıt olsaydı böyle bir profil hiç yüklenemezdi.
  const parsed = TriageSchema.safeParse({
    enabled: true,
    ladder: { standard: { model: "m-s" }, deep: { model: "m-d", effort: "max" } },
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data.ladder.standard?.effort, "high", "effort varsayılanı");
  assert.equal(parsed.data.ladder.cheap, undefined);
});

test("triage varsayılanı: KAPALI ve bugünkü davranışı korur", () => {
  // Davranış değişikliği opt-in olmalı: mevcut profiller sürüm yükseltince
  // sessizce model değiştirmemeli. `deep` bugünkü Planner/Developer ayarı.
  const cfg = TriageSchema.parse({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.fallbackTier, "deep");
  assert.equal(cfg.ladder.deep?.model, "claude-opus-5-5");
  assert.equal(cfg.ladder.deep?.effort, "high");
  assert.equal(cfg.approvalRequiredFrom, "frontier");
});

test("profil: agents.triage varsayılanla gelir, mevcut profiller bozulmaz", () => {
  // Triage alanı eklenmeden yazılmış bir profil hiçbir değişiklik olmadan
  // yüklenebilmeli — aksi hâlde onaylı profiller geçersizleşirdi.
  const profile = minimalProfile();
  assert.equal(profile.agents.triage.enabled, false);
  assert.equal(profile.agents.triage.model, "claude-haiku-5-5");
});

test("profil: docLayers verilmezse boş dizi gelir", () => {
  // Desen her projede yok; Analyst bulamazsa boş bırakır — var olan
  // profillerin davranışı (render fonksiyonları hiçbir satır basmaz) korunur.
  const profile = minimalProfile();
  assert.deepEqual(profile.agents.docLayers, []);
});

test("profil: docLayers geçerli girdide indexFile README.md'ye varsayılanlanır", () => {
  const profile = ProjectProfileSchema.parse({
    ...minimalProfile(),
    agents: { docLayers: [{ dir: "docs/rules", purpose: "active-rule" }] },
  });
  assert.equal(profile.agents.docLayers[0]?.indexFile, "README.md");
});

test("profil: docLayers geçersiz purpose reddedilir", () => {
  const bad = {
    ...minimalProfile(),
    agents: { docLayers: [{ dir: "docs/rules", purpose: "unknown" }] },
  };
  assert.throws(() => ProjectProfileSchema.parse(bad));
});

test("profil: eski overlayDir/rulesDir/contextFiles alanları sessizce düşer", () => {
  // Bu alanlar kaldırıldı (tüketicisiz ölü şemaydı); eski kaydedilmiş
  // profiller yine de sorunsuz parse olmalı.
  const legacy = {
    ...minimalProfile(),
    agents: { overlayDir: "overlays", rulesDir: "rules", contextFiles: ["a.md"] },
  };
  const profile = ProjectProfileSchema.parse(legacy);
  assert.equal((profile.agents as Record<string, unknown>)["overlayDir"], undefined);
});

test("model seçimi: eski kapı yükü (modelChoice yok) geçerli kalır", () => {
  // Triage'dan ÖNCE açılmış işlerin kapılarında bu alan hiç yok; UI ve motor
  // onları okumaya devam edebilmeli.
  const parsed = PlanGatePayloadSchema.safeParse({
    planId: "p1",
    plan: { summary: "x", phases: [{ id: "a", order: 0, title: "t" }] },
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data.modelChoice, undefined);
});

test("yer tutucu: $jobId ve türevleri çözülür", () => {
  const id = "01a0c00e-2732-778a-b9d9-ec340e1b8dff";
  assert.equal(resolveJobPlaceholders("northwind:$jobIdShort:", id), "northwind:01a0c00eec340e1b8dff:");
  assert.equal(resolveJobPlaceholders("x-$jobId-y", id), `x-${id}-y`);
  // Süslü biçim sınırı ayırır: `$jobIdShort` ile `${jobId}Short` aynı şey değil.
  assert.equal(resolveJobPlaceholders("${jobId}Short", id), `${id}Short`);
  assert.equal(jobIdValues(id).jobIdSql, "x01a0c00e_2732_778a_b9d9_ec340e1b8dff");
});

test("yer tutucu: $jobIdShort aynı milisaniyede açılan işleri AYIRIR", () => {
  // ÖLÇÜLDÜ (2026-09-21): art arda üretilen altı UUIDv7'nin ilk segmenti
  // aynıydı ve ~20 sn sonra değişti — yalnız o segmenti kullanmak, aynı dakika
  // içindeki işlere aynı Redis prefix'ini ve aynı Elastic index'ini verirdi.
  // Bu test tam o regresyonu yakalar.
  const a = "01a0c0db-fc4b-738d-ac3d-d53b377c6612";
  const b = "01a0c0db-fc4b-738d-ac3d-d95206957714"; // aynı zaman öneki, farklı kuyruk
  assert.notEqual(jobIdValues(a).jobIdShort, jobIdValues(b).jobIdShort);
  // Zaman öneki BAŞTA kalır: adlar leksikografik olarak da kronolojik sıralanır.
  assert.ok(jobIdValues(a).jobIdShort.startsWith("01a0c0db"));
});

test("yer tutucu: tanınmayan $ değişkeni DOKUNULMADAN kalır", () => {
  // Parolalar ve kabuk değişkenleri `$` taşıyabiliyor; bilinmeyeni boşa
  // çevirmek onları sessizce silerdi.
  const id = "01a0c00e-2732-778a-b9d9-ec340e1b8dff";
  assert.equal(resolveJobPlaceholders("$PATH ve $jobIdYok", id), "$PATH ve $jobIdYok");
  assert.equal(resolveJobPlaceholders("p@ss$word", id), "p@ss$word");
});

test("yer tutucu: env haritasında yalnız DEĞERLER çözülür", () => {
  const id = "01a0c00e-2732-778a-b9d9-ec340e1b8dff";
  const out = resolveEnvPlaceholders({ "PREFIX_$jobIdShort": "v-$jobIdShort" }, id);
  // Anahtar dokunulmaz: ortam değişkeninin ADI profilin sözleşmesidir.
  assert.deepEqual(out, { "PREFIX_$jobIdShort": "v-01a0c00eec340e1b8dff" });
});

test("yer tutucu: tiresiz kimlikte $jobIdShort boş DÖNMEZ", () => {
  // Boş dönseydi iki iş aynı öneki paylaşırdı — izolasyon ad düzeyinde.
  assert.equal(resolveJobPlaceholders("$jobIdShort", "abc123"), "abc123");
});
