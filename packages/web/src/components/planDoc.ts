import type { PlanDocument } from "@ahtapot/shared";

import type { PlanPhaseRow } from "../api";

/**
 * Plan belgesini okunabilir bölümlere çevirir.
 *
 * Tasarım planı beş bölümlü bir okuma olarak kuruyor (özet · kapsam · safhalar ·
 * test · risk), ama `PlanDocument` şeması düz bir alan torbası: `summary`,
 * `targetRepos`, `phases`, `testStrategy`, `outOfScope`… Bölümler ŞEMADAN
 * TÜRETİLİR, uydurulmaz — motora yeni alan eklemeden.
 *
 * Boş bölüm hiç üretilmez: veri yokken "veri yok" kutusu göstermek, rail'i
 * beş satır uzun ve beş satır gürültülü yapıyor. Rail yalnız okunacak bir şey
 * olan bölümleri listeler.
 */

/** Satır işareti — `markTones` ile aynı sözlük: ✓ içinde, × dışında, → karar, ! risk, · nötr. */
export type Mark = "✓" | "×" | "→" | "!" | "·";

export interface DocLine {
  mark: Mark;
  title: string;
  /** İkinci satır: gerekçe ya da ölçüm. Boşsa çizilmez. */
  note: string;
}

export interface DocBlock {
  head: string;
  /** Başlığın yanındaki rozet ("tamam", "onay bekliyor", "sırada"). */
  tag: string;
  /** Serbest paragraf. */
  body: string;
  lines: DocLine[];
  /** Ölçü çipleri — "4 safha", "risk low". */
  chips: string[];
}

export interface DocSection {
  id: string;
  /** Rail'deki iki haneli sıra numarası. */
  num: string;
  title: string;
  /** Rail'de sağda duran kısa ölçü. */
  meta: string;
  /** Okuma panelindeki büyük başlık. */
  head: string;
  /** Başlık altındaki giriş paragrafı. */
  lead: string;
  blocks: DocBlock[];
}

/** Safha durumunun rozet karşılığı. */
const PHASE_TAGS: Record<string, string> = {
  done: "tamam",
  approved: "tamam",
  running: "koşuyor",
  awaiting_approval: "onay bekliyor",
  rejected: "reddedildi",
  skipped: "atlandı",
  pending: "sırada",
};

const COMPLEXITY_TR: Record<string, string> = {
  small: "küçük",
  medium: "orta",
  large: "büyük",
};

function block(b: Partial<DocBlock>): DocBlock {
  return { head: "", tag: "", body: "", lines: [], chips: [], ...b };
}

/** Bölümde okunacak bir şey var mı? Başlıksız, satırsız, çipsiz blok boştur. */
function hasContent(s: DocSection): boolean {
  if (s.lead.trim()) return true;
  return s.blocks.some((b) => b.body.trim() || b.lines.length > 0 || b.chips.length > 0);
}

/** 01 · Özet ve karar */
function ozet(doc: PlanDocument, phases: PlanPhaseRow[]): DocSection {
  const files = new Set(phases.flatMap((p) => p.files));
  const gates = phases.filter((p) => p.status === "awaiting_approval").length;
  const chips = [
    `${phases.length} safha`,
    files.size > 0 ? `${files.size} dosya` : "",
    `karmaşıklık ${COMPLEXITY_TR[doc.estimatedComplexity] ?? doc.estimatedComplexity}`,
    gates > 0 ? `${gates} insan kapısı` : "",
  ].filter(Boolean);

  const lines: DocLine[] = doc.targetRepos.map((r) => ({
    mark: "→" as const,
    title: r,
    note: "",
  }));
  // Seçim gerekçesi tek repo için de anlamlı: neden oraya dokunuluyor.
  if (doc.repoSelectionReason && lines.length > 0) {
    const first = lines[0];
    if (first) first.note = doc.repoSelectionReason;
  }

  return {
    id: "ozet",
    num: "01",
    title: "Özet ve karar",
    meta: `${phases.length} safha`,
    head: doc.summary,
    lead: "",
    blocks: [
      lines.length > 0 ? block({ head: "Dokunulan repolar", lines }) : block({}),
      block({ head: "Ölçüler", chips }),
    ].filter((b) => b.head),
  };
}

/**
 * 02 · Gereksinimler (§42)
 *
 * İş tanımı dağınık girilebiliyor; insan burada metnin NASIL anlaşıldığını
 * okur. Alıntı ham metne geri bağlar, örtük gereksinim (alıntısız) ayrıca
 * söylenir. Hiçbir safhanın karşılamadığı gereksinim `!` ile öne çıkar —
 * planın atladığı istek onaydan önce görünsün. Eski planlarda liste yok;
 * bölüm de yok.
 *
 * Safha eşleşmesi `order` üzerinden: `PlanPhaseRow` `covers` taşımıyor,
 * belgedeki safha ile satır aynı sırayı paylaşıyor.
 */
function gereksinimler(doc: PlanDocument): DocSection {
  const coveredBy = new Map<string, number[]>();
  for (const p of doc.phases) {
    for (const id of p.covers) coveredBy.set(id, [...(coveredBy.get(id) ?? []), p.order + 1]);
  }
  const uncovered = doc.requirements.filter((r) => !coveredBy.has(r.id)).length;

  const lines: DocLine[] = doc.requirements.map((r) => {
    const by = coveredBy.get(r.id) ?? [];
    const where = by.length > 0 ? `Safha ${by.join(", ")}` : "hiçbir safha karşılamıyor";
    const origin = r.source ? `“${r.source}”` : "örtük — açıklamada geçmiyor";
    return {
      mark: by.length === 0 ? ("!" as const) : r.source ? ("✓" as const) : ("→" as const),
      title: `${r.id} · ${r.text}`,
      note: `${origin} · ${where}`,
    };
  });

  return {
    id: "gereksinimler",
    num: "",
    title: "Gereksinimler",
    meta: uncovered > 0 ? `${uncovered} karşılanmamış` : `${doc.requirements.length} gereksinim`,
    head: "İş tanımı nasıl anlaşıldı",
    lead: "",
    blocks: lines.length > 0 ? [block({ head: "Açıklamadan çıkarılanlar", lines })] : [],
  };
}

/** 02 · Kapsam */
function kapsam(doc: PlanDocument, phases: PlanPhaseRow[]): DocSection {
  const files = [...new Set(phases.flatMap((p) => p.files))];
  const blocks: DocBlock[] = [];

  if (files.length > 0) {
    blocks.push(
      block({
        head: "İçinde",
        lines: files.map((f) => ({ mark: "✓" as const, title: f, note: "" })),
      }),
    );
  }
  if (doc.outOfScope.length > 0) {
    blocks.push(
      block({
        head: "Dışında",
        lines: doc.outOfScope.map((s) => ({ mark: "×" as const, title: s, note: "" })),
      }),
    );
  }

  return {
    id: "kapsam",
    num: "02",
    title: "Kapsam",
    meta: doc.outOfScope.length > 0 ? "içinde / dışında" : `${files.length} dosya`,
    head: "Nereye dokunuyor, nereye dokunmuyor",
    lead: doc.repoSelectionReason,
    blocks,
  };
}

/** 03 · Safhalar */
function safhalar(doc: PlanDocument, phases: PlanPhaseRow[]): DocSection {
  const covers = new Map(doc.phases.map((p) => [p.order, p.covers]));
  return {
    id: "safhalar",
    num: "03",
    title: "Safhalar",
    meta: `${phases.length} safha`,
    head: "Sıra ve neden bu sıra",
    lead: "",
    blocks: phases.map((p) =>
      block({
        head: `Safha ${p.order + 1} · ${p.title}`,
        tag: PHASE_TAGS[p.status] ?? p.status,
        body: p.rationale,
        chips: [
          `${p.files.length} dosya`,
          `risk ${p.risk}`,
          p.exceedsFileCap ? "tavan aşımı" : "",
          (covers.get(p.order) ?? []).join(", "),
        ].filter(Boolean),
      }),
    ),
  };
}

/** 04 · Test stratejisi */
function test(doc: PlanDocument): DocSection {
  return {
    id: "test",
    num: "04",
    title: "Test stratejisi",
    meta: "",
    head: "Testler ne zaman, neyi ölçüyor",
    lead: doc.testStrategy,
    blocks: [],
  };
}

/**
 * 05 · Riskler
 *
 * Şemada ayrı bir risk listesi yok; safhaların `risk` ve `exceedsFileCap`
 * alanlarından derlenir. `low` olanlar listelenmez — hepsi low ise bölüm hiç
 * görünmez, çünkü okunacak bir şey yoktur.
 */
function risk(phases: PlanPhaseRow[]): DocSection {
  const risky = phases.filter((p) => p.risk !== "low" || p.exceedsFileCap);
  const lines: DocLine[] = risky.map((p) => ({
    mark: "!" as const,
    title: `${p.risk} · Safha ${p.order + 1} — ${p.title}`,
    note: p.exceedsFileCap
      ? `${p.files.length} dosya, tavanı aşıyor — gerekçe safhada`
      : p.rationale,
  }));

  return {
    id: "risk",
    num: "05",
    title: "Riskler",
    meta: risky.length > 0 ? `${risky.length} risk` : "",
    head: "Ne kırılabilir",
    lead: "",
    blocks:
      lines.length > 0
        ? [
            block({ head: "Safha riskleri", lines }),
            block({
              head: "Geri dönüş",
              lines: [
                { mark: "→", title: "Safha bazlı revert", note: "her safha tek commit; sırayla geri alınabilir" },
              ],
            }),
          ]
        : [],
  };
}

/**
 * Plan belgesini rail'de gezilecek bölümlere çevirir. Boş bölüm elenir.
 *
 * Sıra numarası elemeden SONRA verilir: gereksinim bölümü eski planlarda
 * yok, sabit numara rail'de boşluk bırakırdı.
 */
export function buildDocSections(doc: PlanDocument, phases: PlanPhaseRow[]): DocSection[] {
  return [ozet(doc, phases), gereksinimler(doc), kapsam(doc, phases), safhalar(doc, phases), test(doc), risk(phases)]
    .filter(hasContent)
    .map((s, i) => ({ ...s, num: String(i + 1).padStart(2, "0") }));
}
