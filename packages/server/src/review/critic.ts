import {
  CritiqueDocumentSchema, scenarioKey, scrubSecrets,
  type CritiqueDocument, type PlanDocument, type TestScenariosDocument,
} from "@ahtapot/shared";

import { extractBlock } from "../analyst/analyst.js";

/**
 * İkinci göz (karar §42) — eleştirmenin göreceği metin ve çıktısının
 * ayrıştırılması. Motoru, DB'yi, sağlayıcıyı bilmez.
 *
 * Eleştirmenin repo bağlamı YOK; gördüğü yalnız ham iş tanımı, Claude'un
 * çıkardığı gereksinimler ve plan/senaryolar. İş metin karşılaştırmak — bu
 * yüzden dosya içeriği gönderilmez, yalnız yollar.
 */

export interface CritiqueJob {
  title: string;
  description: string;
}

/** Planner'daki tavanla aynı: uzun açıklama prompt'u şişirmesin. */
const DESCRIPTION_CAP = 4000;

/**
 * Ham metin etiket içinde: açıklama `# Görev` gibi bir başlık taşırsa
 * prompt'un bölüm düzenini taklit edemesin. Kapanış etiketi metin içinde
 * kaçışlanır, sınır kullanıcı tarafından kapatılamaz.
 */
function jobSection(job: CritiqueJob): string[] {
  const desc = job.description.trim();
  const safe = (s: string): string => s.replaceAll("</raw_job>", "<\\/raw_job>");
  return [
    "# Ham iş tanımı (kullanıcının yazdığı, değiştirilmemiş)",
    "<raw_job>",
    `Başlık: ${safe(job.title)}`,
    desc ? safe(desc.slice(0, DESCRIPTION_CAP)) + (desc.length > DESCRIPTION_CAP ? "\n…(kesildi)" : "") : "(açıklama boş)",
    "</raw_job>",
  ];
}

function requirementsSection(plan: PlanDocument): string[] {
  if (plan.requirements.length === 0) return ["\n# Gereksinimler", "(Planner gereksinim listesi çıkarmadı — ham metinle planı doğrudan karşılaştır.)"];
  return [
    "\n# Gereksinimler (Claude'un ham metinden çıkardığı)",
    ...plan.requirements.map((r) => `- ${r.id}: ${r.text}${r.source ? `\n  alıntı: “${r.source}”` : "\n  alıntı yok (örtük)"}`),
  ];
}

/** Plan eleştirisi için kullanıcı mesajı. Maskeli (kural 4). */
export function buildPlanCritique(job: CritiqueJob, plan: PlanDocument): string {
  const lines = [
    ...jobSection(job),
    ...requirementsSection(plan),
    "\n# Plan",
    `Özet: ${plan.summary}`,
    ...plan.phases.map((p) => [
      `\n## Safha ${p.id} (${p.order + 1}). ${p.title}`,
      p.rationale,
      p.covers.length ? `Karşıladığı: ${p.covers.join(", ")}` : "Karşıladığı: (belirtilmemiş)",
      p.acceptance.length ? `Kabul: ${p.acceptance.join(" · ")}` : "",
      p.files.length ? `Dosyalar: ${p.files.join(", ")}` : "",
    ].filter(Boolean).join("\n")),
    plan.outOfScope.length ? `\n# Kapsam dışı\n${plan.outOfScope.map((s) => `- ${s}`).join("\n")}` : "",
    plan.openQuestions.length
      ? `\n# Planner'ın açık soruları\n${plan.openQuestions.map((q) => `- ${q.question}${q.assumption ? ` (varsayım: ${q.assumption})` : ""}`).join("\n")}`
      : "",
    plan.testStrategy ? `\n# Test stratejisi\n${plan.testStrategy}` : "",
    "\n# Görev",
    "Konu: PLAN. Ham metni, gereksinimleri ve planı karşılaştır. Tam olarak bir CRITIQUE_JSON bloğu üret.",
  ];
  return scrubSecrets(lines.filter(Boolean).join("\n"));
}

/** Senaryo eleştirisi için kullanıcı mesajı. `ref` olarak senaryonun anahtarı (`s0`…) verilir. */
export function buildScenariosCritique(job: CritiqueJob, plan: PlanDocument, doc: TestScenariosDocument): string {
  const lines = [
    ...jobSection(job),
    ...requirementsSection(plan),
    "\n# Test senaryoları",
    ...doc.scenarios.map((s, i) => [
      `\n## ${scenarioKey(i)}. ${s.title}${s.area ? ` (${s.area})` : ""} — öncelik ${s.priority}`,
      s.covers.length ? `Doğruladığı: ${s.covers.join(", ")}` : "Doğruladığı: (belirtilmemiş)",
      s.account ? `Hesap: ${s.account}` : "",
      s.preconditions.length ? `Ön koşul: ${s.preconditions.join(" · ")}` : "",
      `Adımlar:\n${s.steps.map((st, j) => `${j + 1}. ${st}`).join("\n")}`,
      `Beklenen: ${s.expected}`,
    ].filter(Boolean).join("\n")),
    doc.notes ? `\n# Tester notu\n${doc.notes}` : "",
    "\n# Görev",
    "Konu: SENARYOLAR. Gereksinimlerin senaryolarca karşılanmasını ve beklenen sonuçları denetle. `ref` olarak senaryo için başlıktaki anahtarı (s0, s1…) kullan. Tam olarak bir CRITIQUE_JSON bloğu üret.",
  ];
  return scrubSecrets(lines.filter(Boolean).join("\n"));
}

export type CritiqueParse =
  | { ok: true; doc: CritiqueDocument }
  | { ok: false; reason: string };

/**
 * `CRITIQUE_JSON` bloğu → Zod. SENTEZ YOK: blok yoksa "bulgu yok" uydurmak
 * insanı yanıltırdı.
 *
 * Çitsiz düz JSON da KABUL EDİLMEZ: sözleşme tek — blok yoksa `failed`.
 * Claude dışı modelin çit kuralına uymadığı ölçülürse ayrıca açılır.
 */
export function parseCritique(text: string): CritiqueParse {
  const raw = extractBlock(text, "CRITIQUE_JSON");
  if (raw === null) return { ok: false, reason: "CRITIQUE_JSON bloğu bulunamadı" };
  const parsed = CritiqueDocumentSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `CRITIQUE_JSON şemaya uymuyor: ${parsed.error.issues[0]?.message ?? "?"}` };
  // Bulgu metinleri UI'a ve DB'ye gider (kural 4).
  return {
    ok: true,
    doc: {
      ...parsed.data,
      notes: scrubSecrets(parsed.data.notes),
      findings: parsed.data.findings.map((f) => ({ ...f, text: scrubSecrets(f.text), suggestion: scrubSecrets(f.suggestion) })),
    },
  };
}
