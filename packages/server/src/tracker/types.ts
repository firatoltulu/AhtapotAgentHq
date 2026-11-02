import type { StageKey } from "./stages.js";

/** İşin bağlı olduğu dış kayıt — tracker'a özgü alan yok (bkz. `jobs.externalRef`). */
export interface ExternalRef {
  jobId: string;
  projectId: string;
  externalRef: string | null;
  externalUrl: string | null;
}

/**
 * Bir takip sistemine (GitHub issue, yarın Jira/ClickUp) yazan adaptör.
 *
 * `source` `jobs.source` ile eşleşir; senkron adaptörü buna göre seçer. Motor
 * ve senkron hangi sistemle konuştuğunu bilmez — yeni takipçi = yeni adaptör.
 * Desteklenmeyen bir işlem sessizce atlanabilir (ör. etiketsiz takipçi).
 */
export interface IssueTracker {
  readonly source: string;
  /** Kaydı Ahtapot'un kimliğine (token sahibi) ata. */
  assignToSelf(ref: ExternalRef): Promise<void>;
  /** Kendini çıkar, kaydı açana ata — "sıra sende". */
  assignToReporter(ref: ExternalRef): Promise<void>;
  comment(ref: ExternalRef, markdown: string): Promise<void>;
  /** Aşamayı kayıtta görünür kıl (etiket, durum alanı…). */
  setStage(ref: ExternalRef, stage: StageKey, prefix: string): Promise<void>;
  close(ref: ExternalRef): Promise<void>;

  // ── Kayıttan OKUYANLAR (canlı test kararı). İsteğe bağlı: yoksa etiketle
  //    karar o takipçide kapalıdır.
  /** Karar etiketlerini repoda var et, kayıtta önceki turdan kalanları sök. */
  prepareVerdict?(ref: ExternalRef, labels: VerdictLabels): Promise<void>;
  /** Kayıttaki karar etiketleri + `since`ten sonra insanların yazdığı yorumlar. */
  readVerdict?(ref: ExternalRef, labels: VerdictLabels, since: string): Promise<VerdictRead>;
  /** İşlenen karar etiketlerini kayıttan kaldır. */
  clearVerdict?(ref: ExternalRef, labels: VerdictLabels): Promise<void>;
}

export interface VerdictLabels {
  approve: string;
  fix: string;
}

export interface VerdictRead {
  approve: boolean;
  fix: boolean;
  /** Ahtapot'un kendi yorumları hariç, eskiden yeniye. */
  notes: string[];
}

/**
 * Ahtapot'un yazdığı her yorumda görünmez işaret.
 *
 * Yazarla ayırt edilemiyor: `gh` çoğu kurulumda test eden kişinin kendi
 * token'ıyla koşuyor, yani Ahtapot'un yorumu da insanınki de aynı hesaptan.
 */
export const SYNC_MARKER = "<!-- ahtapot:sync -->";
