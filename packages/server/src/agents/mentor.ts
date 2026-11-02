import { MODEL_TIER_ORDER, type AgentRoleName, type ModelTier, type Triage } from "@ahtapot/shared";

import type { StuckSignal } from "./stuck.js";

/**
 * Mentor danışmasının saf parçaları (karar §33): basamak seçimi, soru
 * dosyası, önerinin sarılması. Koşuyu motor yapar.
 */

/** Runner'ın danışma için motora verdiği her şey. */
export interface ConsultRequest {
  runId: string;
  role: AgentRoleName;
  juniorModel: string;
  signal: StuckSignal;
  /** Aynı sinyal bu koşuda kaçıncı kez danışılıyor (1'den). Her tekrar bir basamak daha yukarı. */
  attempt: number;
  /** Döngünün kanıtı: tekrar okunan dosyanın ya da tekrar eden hatanın son sonucu. */
  evidence: string;
  /** Agent'ın son metin mesajları, eskiden yeniye. */
  recentText: string[];
}

/**
 * Model adının merdivendeki seviyesi.
 *
 * Koşu modeli adıyla gelir: safha seviyesi, zorlama (§22) ya da profil rolü
 * hepsi sonunda bir modele çözülüyor. Aynı model iki basamakta varsa alttaki
 * alınır — mentor daha yukarıda aranır, eksik değil fazla temkin.
 */
export function tierOfModel(model: string, ladder: Triage["ladder"]): ModelTier | null {
  for (const t of MODEL_TIER_ORDER) if (ladder[t]?.model === model) return t;
  return null;
}

/**
 * Mentor basamağı: junior'un `attempt` basamak yukarısı, `maxTier`ı aşmadan.
 *
 * `rungFor` DEĞİL (§22 gerekçesi): eksik basamakta sessizce başka modele
 * düşerdi. Tanımsız basamak ve junior'la aynı model atlanır. Yukarıda
 * yeterince basamak yoksa en üsttekine razı olunur; hiç yoksa `null` —
 * bu agent'ın mentoru insandır.
 */
export function mentorRung(
  juniorModel: string,
  ladder: Triage["ladder"],
  maxTier: ModelTier,
  attempt: number,
): { tier: ModelTier; model: string; effort: string } | null {
  const cur = tierOfModel(juniorModel, ladder);
  if (cur === null) return null;
  const maxIdx = MODEL_TIER_ORDER.indexOf(maxTier);
  let found: { tier: ModelTier; model: string; effort: string } | null = null;
  let steps = 0;
  for (let i = MODEL_TIER_ORDER.indexOf(cur) + 1; i <= maxIdx; i++) {
    const tier = MODEL_TIER_ORDER[i]!;
    const rung = ladder[tier];
    if (!rung || rung.model === juniorModel) continue;
    found = { tier, model: rung.model, effort: rung.effort };
    if (++steps >= attempt) break;
  }
  return found;
}

const SIGNAL_TEXT: Record<StuckSignal["signal"], string> = {
  repeat_read: "Aynı şeyi arada hiçbir şey yazmadan tekrar tekrar okuyor.",
  repeat_failure: "Aynı işlem aynı hatayla tekrar tekrar kırılıyor.",
  no_progress: "Uzun süredir worktree'ye hiçbir şey yazmadı.",
};

/** Kanıtın sınırı — mentor araçsız, her şey bu mesajda; bağlamı da boğmamalı. */
const EVIDENCE_LIMIT = 12_000;

/** Mentora giden soru dosyası. Çağıran `scrubSecrets`ten geçirir. */
export function renderMentorPrompt(task: string, req: ConsultRequest): string {
  const evidence = req.evidence.length > EVIDENCE_LIMIT
    // Baş ve son: dosyada aranan yer de, hatada asıl satır da çoğu zaman uçlarda.
    ? `${req.evidence.slice(0, EVIDENCE_LIMIT * 0.6)}\n…[kesildi]…\n${req.evidence.slice(-EVIDENCE_LIMIT * 0.4)}`
    : req.evidence;
  return [
    `# Takılan agent: ${req.role} (${req.juniorModel})`,
    "",
    "## Görevi",
    task.trim() || "(motor görevi çıkaramadı)",
    "",
    "## Döngü",
    SIGNAL_TEXT[req.signal.signal],
    req.signal.detail,
    req.attempt > 1 ? `Bu döngü için ${req.attempt}. danışma: önceki öneri işe yaramadı.` : "",
    "",
    "## Kanıt (son sonuç)",
    "```",
    evidence.trim() || "(sonuç metni yok)",
    "```",
    "",
    "## Agent'ın son söyledikleri",
    req.recentText.length ? req.recentText.map((t) => `> ${t.trim().replace(/\n/g, "\n> ")}`).join("\n\n") : "(yok)",
  ].filter((l) => l !== "").join("\n");
}

/**
 * Agent'a giden metin. Emir değil ÖNERİ: mentor yalnız soru dosyasını gördü,
 * agent worktree'nin tamamını görüyor. Körü körüne uygulanan öneri yeni bir
 * döngü başlatır.
 */
export function wrapAdvice(mentorModel: string, signal: StuckSignal, advice: string): string {
  return [
    `## Mentor önerisi (${mentorModel})`,
    "",
    `Orkestratör bir döngü fark etti: ${signal.detail}. Daha güçlü bir modele danışıldı:`,
    "",
    advice.trim(),
    "",
    "---",
    "Bu bir öneridir. Önce doğrula; durumuna uymuyorsa gerekçesini yazıp kendi yolunla devam et.",
  ].join("\n");
}
