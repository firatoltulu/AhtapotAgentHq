import type { PlanDocument } from "@ahtapot/shared";

export type Question = PlanDocument["openQuestions"][number];

/**
 * Uzun soruyu okunabilir hâle getirir.
 *
 * Eski planlarda (ve yeni biçimi görmemiş turlarda) Planner gerekçeyi soru
 * metnine sıkıştırıyor: 900 karakterlik tek paragraf. Soruyu ilk cümlede
 * kesip gerisini `context`e almak, hiç olmazsa neyin sorulduğunu görünür
 * kılar — son cümle çoğu zaman asıl soru olduğu için ("…Onayın hangisi?")
 * o da başlığa eklenir.
 */
export function split(question: string, context: string): { question: string; context: string } {
  const q = question.trim();
  if (q.length <= 180) return { question: q, context };

  const sentences = q.split(/(?<=[.!?])\s+/);
  const head = sentences[0] ?? q;
  const tail = sentences[sentences.length - 1] ?? "";
  // Son cümle soruysa asıl karar odur; başlıkla birleştir.
  const title = tail !== head && tail.endsWith("?") && tail.length <= 160 ? `${head.replace(/[.:]$/, "")} — ${tail}` : head;
  const rest = q.slice(head.length).trim();
  return { question: title.slice(0, 300), context: [rest, context].filter(Boolean).join("\n\n") };
}

/**
 * Metne gömülü şıkları ayıklar.
 *
 * YAŞANDI: Planner şıkları `options` yerine gerekçe metnine yazıyor —
 * "Üç seçenek: (A) … (B) … (C) …". `options` boş kalınca UI düğme çizemiyor
 * ve insan şıkkı elle yazmak zorunda kalıyor. Yeni promptla bu düzeldi, ama
 * ÜRETİLMİŞ planlar diskte duruyor; onları da kurtarmak gerek.
 *
 * Yalnız güvenli kalıp: satır başı ya da boşluk sonrası "(A)" / "(B)" gibi
 * ardışık büyük harf işaretleri. En az iki şık bulunmazsa hiçbir şey yapılmaz —
 * yanlış ayıklama, elle yazmaktan daha kötüdür.
 */
export function extractOptions(text: string): { label: string; body: string }[] {
  const marks = [...text.matchAll(/(?:^|[\s(])\(([A-E])\)\s/g)];
  if (marks.length < 2) return [];

  // Harfler sırayla mı? (A), (B), (C) — değilse metinde geçen bir referanstır.
  const letters = marks.map((m) => m[1]);
  const ordered = letters.every((l, i) => l === String.fromCharCode(65 + i));
  if (!ordered) return [];

  const out: { label: string; body: string }[] = [];
  for (const [i, m] of marks.entries()) {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? (marks[i + 1]?.index ?? text.length) : text.length;
    const body = text.slice(start, end).trim().replace(/[.;,]$/, "");
    if (!body) continue;
    // Etiket: ilk cümle ya da ilk tire öncesi — düğmeye sığacak kadar kısa.
    const label = (body.split(/\s+—\s+|[.:]\s/)[0] ?? body).trim();
    out.push({ label: `${letters[i]}) ${label.slice(0, 90)}`, body });
  }
  return out.length >= 2 ? out : [];
}

/**
 * Şıkkı "etiket / sonuç / bedel" olarak ayrıştırır.
 *
 * Şema şıkları düz dize tutuyor (`options: string[]`), ama Planner ikisini de
 * tek satıra sıkıştırıyor: "Derlemeyi kır — hata derlemede yakalanır · bedeli:
 * şema gecikirse istemci bloke olur". İnsan şıkkı seçerken asıl merak ettiği
 * bu ikisi; tek satırda okunmuyor.
 *
 * Ayrıştırma SAVUNMACI: kalıp tutmazsa şık olduğu gibi etiket kalır. Yanlış
 * bölme, bölmemekten kötüdür — `extractOptions` ile aynı ilke.
 */
export interface OptionParts {
  /** Düğmeye yazılan kısa etiket. */
  label: string;
  /** Seçilirse ne olur. Ayrışmadıysa boş. */
  result: string;
  /** Neye mal olur. Ayrışmadıysa boş. */
  cost: string;
}

/** "bedeli:" / "bedel:" / "maliyeti:" — bedel kısmını başlatan işaretler. */
const COST_MARK = /\s*[·—–-]?\s*(?:bedeli?|maliyeti?)\s*[:：]\s*/i;
/** Etiketi gövdeden ayıran ilk tire ya da iki nokta. */
const LABEL_MARK = /\s+[—–]\s+|\s*[:：]\s+/;

export function splitOption(raw: string): OptionParts {
  const text = raw.trim();
  if (!text) return { label: raw, result: "", cost: "" };

  // Önce bedeli ayır: "… bedeli: …" kalıbı en güvenilir işaret.
  const costAt = text.search(COST_MARK);
  const head = costAt >= 0 ? text.slice(0, costAt).trim() : text;
  const cost = costAt >= 0 ? text.slice(costAt).replace(COST_MARK, "").trim() : "";

  // Sonra etiketi gövdeden ayır. Etiket düğmeye sığmalı; uzunsa bölme.
  const m = LABEL_MARK.exec(head);
  if (!m || m.index > 90) {
    return { label: head || raw, result: "", cost };
  }
  const label = head.slice(0, m.index).trim();
  const result = head.slice(m.index + m[0].length).trim();
  // Etiket ya da sonuç boş kaldıysa bölme bir şey kazandırmamış demektir.
  if (!label || !result) return { label: head || raw, result: "", cost };
  return { label, result, cost };
}

/**
 * Soruları normalize eder.
 *
 * Sunucu belgeyi şemadan geçiriyor, ama WS kapı yükü ve eski kayıtlar ham JSON
 * taşıyabiliyor: `openQuestions` düz dize dizisi olabilir. Normalize edilmezse
 * `q.question` undefined kalır ve sihirbaz render sırasında patlar — yaşandı.
 */
/** Tanımlı şıklar varsa onlar; yoksa metne gömülü olanlar. */
function pickOptions(o: Partial<Question>, text: string): string[] {
  const declared = Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === "string") : [];
  if (declared.length > 0) return declared;
  return extractOptions(text).map((x) => x.label);
}

export function normalize(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  const out: Question[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.trim()) {
        out.push({
          id: "", ...split(item, ""),
          options: extractOptions(item).map((x) => x.label),
          recommended: "", assumption: "", blocksPlan: false,
        });
      }
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Partial<Question>;
    if (typeof o.question !== "string" || !o.question.trim()) continue;
    out.push({
      id: typeof o.id === "string" ? o.id : "",
      ...split(o.question, typeof o.context === "string" ? o.context : ""),
      options: pickOptions(o, `${o.question} ${typeof o.context === "string" ? o.context : ""}`),
      recommended: typeof o.recommended === "string" ? o.recommended : "",
      assumption: typeof o.assumption === "string" ? o.assumption : "",
      blocksPlan: o.blocksPlan === true,
    });
  }
  return out;
}
